import {
  Application,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Rectangle,
  Text,
} from "pixi.js";
import { app as mkApp, comb, decode, iota, type Node, type NodeId, removeSubtree, sexp } from "./core/term";
import { firingRule, redexAt } from "./core/reduce";
import { GraphReducer, evalShared } from "./core/graph";
import { encodePermalink, decodePermalink, type Modes } from "./core/permalink";
import { LocalStore } from "./store/local";
import { DuckdbStore } from "./store/duckdb";
import { ChallengePanel } from "./view/challenge";
import { QuestPanel } from "./view/quest";
import { QuestTracker } from "./view/questTracker";
import { Sound } from "./view/sound";
import { CATALOG, IOTA_CODE, type Law } from "./core/catalog";
import { recognize } from "./core/probe";
import { layoutAuto, layoutRadial, layoutTopDown, type LayoutFn } from "./core/layout";
import { makeRefolder, behavioralRefolder, recognizeDeep, fromEgg, toEgg, type Refolder } from "./core/refold";
import { read, render, type Ty } from "./core/types";
import { inferType } from "./core/infer";
import { abstractLeaf, defineCombinator, findSubtree, isNameTaken, replaceSubtree, validateName } from "./core/authoring";
import { TreeView, dashedSegment } from "./view/tree";
import { Hotbar } from "./view/hotbar";
import { Toast } from "./view/toast";
import { Zoo } from "./view/zoo";
import { MhsPanel } from "./view/mhs/panel";
import { preloadCompiler } from "./view/mhs/compiler";
import { theme, initTheme, toggleMode, currentMode, colorOn, toggleColor, onThemeChange } from "./view/theme";
import { MenuBar, type Menu } from "./view/menubar";
import { About } from "./view/about";
import { FluffPanel, isFluff, prefersReducedMotion, onFluffChange } from "./view/fluff";
import { OptimizePanel, isOpt, setOpt, onOptChange } from "./view/optimize";
import { type NativeOpts } from "./core/native";
import { tween } from "./view/anim";

const SNAP_R = 72; // world-space snap radius between two tree root anchors (~1.3·XS)
const AUTO_DELAY = 450; // ms a tree must sit untouched before it starts reducing (§6.4)
const STEP_MS = 300; // duration of one reduction-step tween
const STEP_GAP = 130; // pause between reduction steps
const HEAVY_GAP = 8; // big trees jump-cut each step; pace them fast but still yield to the renderer (≠ 0, which starves rAF)
const STEP_CAP = 2000; // non-termination guard: stop auto-reducing past this many steps
const GRAPH_STEP_CAP = 100_000; // graph mode shares (cheap steps) — let fac-scale reductions finish
const COLLAPSE_MS = 340; // morph from a recognised normal form into its named node
const ATTACH_MS = 280; // glide two trees together when snapped
const DELETE_MS = 240; // fade out a right-clicked subtree

type Drag =
  | { kind: "tree"; tree: TreeView; offX: number; offY: number }
  | { kind: "spawn"; tree: TreeView }
  | { kind: "pan"; startX: number; startY: number; worldX: number; worldY: number }
  | null;

/** Wire the functional core to a Pixi scene: hotbar → spawn, drag → move/snap,
 * auto-reduce on idle (cancelled on touch), plus a pannable/zoomable camera
 * (§5.3, §6). */
export async function mountApp(onStep: (label: string) => void = () => {}): Promise<void> {
  initTheme(); // pick light/dark from the OS before anything paints
  const pixi = new Application();
  // resolution + autoDensity render at device pixel density so text/edges are
  // crisp on retina / iOS instead of grainy. Cap at 2× — past that the extra
  // pixels (e.g. 3× on iPhones, ~2.25× the work) aren't perceptible but cost fps.
  await pixi.init({ background: theme.bg, resizeTo: window, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
  document.body.appendChild(pixi.canvas);
  onStep("renderer"); // splash step 1/3

  const world = new Container();
  const ghostLayer = new Container();
  const hud = new Container();
  // The camera transform, read live so TreeView can viewport-cull edges.
  const cameraTransform = (): { x: number; y: number; scale: number } => ({ x: world.position.x, y: world.position.y, scale: world.scale.x });
  world.addChild(ghostLayer);
  pixi.stage.addChild(world, hud);

  const ghost = new Graphics();
  const ghostLabel = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 15, fill: theme.text },
  });
  ghostLabel.anchor.set(0.5, 1);
  ghostLabel.visible = false;
  ghostLayer.addChild(ghost, ghostLabel);
  const flourish = new Graphics(); // fluff: a marching-ants ring at each reduction
  flourish.eventMode = "none";
  world.addChild(flourish); // brought to front in reduceFlourish so it's not hidden under trees

  const trees: TreeView[] = [];
  let drag: Drag = null;
  let snapTarget: TreeView | null = null;
  let focus: TreeView | null = null; // the tree whose expression is shown up top
  // Active touch points (by id) + the previous pinch frame, for two-finger zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; cx: number; cy: number } | null = null;
  let expandAll = false; // "Expand" view: draw every combinator as its full ι-tree
  let fastMode = isOpt("rules"); // "optimize" mode — mirror of view/optimize (the source of truth); reduce named combinators by their rule (not raw SKI)
  let shareMode = isOpt("graph"); // "graph" mode mirror: call-by-need graph reduction, shared subterms drawn as one node
  // The active native-value optimizations (ADR 10), or undefined if none — read from
  // the optimize store each reduction, passed into the reducer alongside `fastMode`.
  const nativeOpts = (): NativeOpts | undefined => {
    const o: NativeOpts = {};
    if (isOpt("nativeNumbers")) o.numbers = true;
    if (isOpt("nativeLists")) o.lists = true;
    if (isOpt("nativeBooleans")) o.booleans = true;
    return o.numbers || o.lists || o.booleans ? o : undefined;
  };
  let menuBar: MenuBar | undefined; // the top menu bar (built below); paintRail() refreshes its open pull-down

  const hint = new Text({
    text: "drag ι · snap trees · they reduce on their own · right-click deletes a node",
    style: { fontFamily: "monospace", fontSize: 14, fill: theme.textDim },
  });
  hint.position.set(16, 30); // below the menu bar
  hud.addChild(hint);

  const legend = new Container();
  paintLegend(legend);
  hud.addChild(legend);

  const toast = new Toast(pixi.ticker);
  hud.addChild(toast.container);

  // Live read-out of the current (last-touched) tree's expression, top-centre.
  const exprText = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 18, fill: theme.text },
  });
  exprText.anchor.set(0.5, 0);
  hud.addChild(exprText);

  // A lighter sub-line hinting at the next combinator worth chasing (the smallest
  // ι-tree you haven't found yet — easiest to build).
  const nextHint = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 13, fill: theme.textDim, wordWrap: true, wordWrapWidth: 900, align: "center", lineHeight: 18 } });
  nextHint.anchor.set(0.5, 0);
  hud.addChild(nextHint);
  const placeExpr = () => {
    exprText.position.set(window.innerWidth / 2, 32); // below the menu bar
    // On phones the centred sub-line collides with the top-left legend; drop it
    // there (the Zoo still shows discovery progress).
    nextHint.visible = window.innerWidth >= 560;
    nextHint.style.wordWrapWidth = Math.min(940, window.innerWidth - 120);
    nextHint.position.set(window.innerWidth / 2, 58);
  };
  placeExpr();

  // The in-HUD hint reuses the Quest as the single hint source: the current stage's
  // spoiler hint when it has one, else its objective (the last intro line). Refreshed
  // whenever the quest advances (see `quest.onAdvance`).
  function updateHint(): void {
    const stage = quest.current;
    if (!stage) {
      nextHint.text = "✦ every combinator discovered ✦";
      return;
    }
    const strip = (s: string): string =>
      s
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const hint = stage.hint ? strip(stage.hint) : "";
    nextHint.text = hint ? `hint →  ${hint}` : strip(stage.intro[stage.intro.length - 1] ?? "");
  }

  // ---- discovery (§7): the set of combinators found so far. Drives the
  // behavioural probe (what to still look for) and the masking of transient
  // S/K/I nodes (undiscovered ones render as "?", revealed on discovery). ----
  // Discovered combinators persist across sessions (localStorage); the player's own
  // authored combos are tracked separately so a "Reset progress" keeps them.
  const DISCOVERED_KEY = "combinate:discovered:v1";
  const discovered = new Set<string>();
  const authoredNames = new Set<string>();
  try {
    const raw = localStorage.getItem(DISCOVERED_KEY);
    if (raw) for (const s of JSON.parse(raw) as string[]) discovered.add(s);
  } catch {
    /* ignore */
  }
  const saveDiscovered = (): void => {
    try {
      localStorage.setItem(DISCOVERED_KEY, JSON.stringify([...discovered]));
    } catch {
      /* ignore */
    }
  };
  const isDiscovered = (sym: string): boolean => discovered.has(sym);

  // ---- authoring (ADR 0006): load the player's own combinators from the store
  // and register each into the shared catalog *before* the Zoo/hotbar are built,
  // so both pick them up. A user comb is the same object as a discovery — a named
  // leaf backed by a tree — so it is also marked discovered. ----
  // The shared persistence store (ADR 0008): LocalStore by default; `?store=duckdb`
  // swaps in the DuckDB-WASM prototype behind the same port (lazy-loaded). Used by
  // both authoring (definitions) and golf (bests/leaderboard).
  const store = new URLSearchParams(location.search).get("store") === "duckdb" ? new DuckdbStore() : new LocalStore();
  for (const d of await store.getDefinitions()) {
    if (isNameTaken(d.name)) continue; // a name we already have (catalog or reload) — skip
    try {
      defineCombinator(d.name, fromEgg(d.egg));
      discovered.add(d.name);
      authoredNames.add(d.name);
    } catch {
      /* malformed stored definition — drop it */
    }
  }
  onStep("catalog"); // splash step 2/3

  // S-expression of a term; an undiscovered S/K/I is shown as its full ι-tree
  // (not its letter), matching the tree view, so the read-out never spoils a
  // combinator before it's found.
  const exprOf = (n: Node): string => {
    switch (n.kind) {
      case "iota":
        return "ι";
      case "comb": {
        const code = !isDiscovered(n.sym) ? IOTA_CODE[n.sym] : undefined;
        return code ? exprOf(decode(code)) : n.sym;
      }
      case "free":
        return n.name;
      case "app":
        return `(${exprOf(n.fn)} ${exprOf(n.arg)})`;
    }
  };
  // ---- re-folding lens (PLAN.md Phase 2): an opt-in read-out that runs the
  // focused term through the egg-via-WASM re-sugarer and shows its most-named
  // reading (e.g. S(KS)K → B). The wasm is a driven adapter, lazy-loaded on
  // first use; the core stays Pixi/DOM-free behind the `Refolder` port. ----
  let refoldOn = false;
  let refolder: Refolder | null = null;
  let refolderLoading = false;
  let refoldRaw: ((sexpr: string) => string) | null = null;

  // Upgrade the lens from the pure behavioural pre-pass to the full
  // behavioural→egg pipeline once the wasm loads. If it fails to load, the
  // behavioural-only re-folder keeps working (no need to disable the lens).
  async function ensureRefolder(): Promise<void> {
    if (refoldRaw || refolderLoading) return;
    refolderLoading = true;
    try {
      const mod = await import("../crates/refold/pkg/refold.js");
      await mod.default();
      refoldRaw = mod.refold;
      refolder = makeRefolder(mod.refold);
      lastShownNode = null; // recompute now the egg stage is live
    } catch {
      toast.show("re-folder: behavioural only (wasm unavailable)");
    } finally {
      refolderLoading = false;
    }
  }

  function toggleRefold(): void {
    refoldOn = !refoldOn;
    lastShownNode = null; // force a recompute on the next frame
    if (refoldOn) {
      if (!refolder) refolder = behavioralRefolder; // instant pure-TS lens
      void ensureRefolder(); // then upgrade with the egg stage
    }
    paintRail();
  }

  // ---- type lens (ADR 0003): an opt-in badge appending the focused term's
  // principal simple type to the read-out (or "no simple type" for the
  // self-application birds — M, L, U, Y). Pure inference on the normal form. ----
  let typeOn = false;
  function toggleType(): void {
    typeOn = !typeOn;
    lastShownNode = null; // force a read-out recompute on the next frame
    paintRail();
  }

  // The read-as mode is just the current hotbar page (ADR 0003): a typed page
  // forces that reading and resolves the bare-A ambiguity `read` otherwise defers
  // (A → 0 / [] / false). The Programs page has no type → auto-discovery.
  const READ_AS: Record<string, Ty> = { Arithmetic: "Int", Booleans: "Bool", Lists: "List", Char: "Char" };

  // Live read-out of the focused tree's expression, recomputed only when its
  // node identity (or the read-as page) changes — so the probes never run every
  // frame. A compact data value (Phase 1) is shown whenever the term is data —
  // always on; the refold lens additionally names combinators (Phase 2) when the
  // term isn't data.
  let lastShownNode: Node | null = null;
  let lastMode: Ty | undefined;
  let lastExpr = "";
  pixi.ticker.add(() => {
    const node = focus && trees.includes(focus) ? focus.node : null;
    const mode = READ_AS[hotbar.page];
    if (node === lastShownNode && mode === lastMode) return;
    lastShownNode = node;
    lastMode = mode;
    let txt = "";
    if (node) {
      // Type-guided data reading: the page forces a reading (mode), elements
      // propagate a sibling's type and route non-data parts to their combinator
      // name. Falls back to the egg lens / raw sexp when the term isn't data.
      const v = read(node, mode ?? null); // Phase 1 (+ propagation/routing)
      const value = v ? render(v) : null;
      const folded = !value && refoldOn && refolder ? refolder(node) : null; // Phase 2: combinator naming, behind the lens
      txt = value ?? (folded ? sexp(folded) : exprOf(node));
      if (typeOn) txt += `  ::  ${inferType(node) ?? "no simple type"}`; // type lens
    }
    if (txt !== lastExpr) {
      lastExpr = txt;
      exprText.text = txt;
    }
  });

  // Layout: top-down by default; T toggles the radial view (§5.1).
  let layoutFn: LayoutFn = layoutAuto;

  // What a recognised tree collapses into: a single named node. I/K/S reduce by
  // built-in rules; the rest carry their definition (law.def) for the reducer
  // to unfold when applied.
  const collapsedNode = (law: Law): Node => comb(law.sym, law.def?.(), law.arity);

  const sound = new Sound();
  const zoo = new Zoo(isDiscovered, (sym) => sound.play(sym)); // added to the HUD last (below) so it overlays everything

  // Reveal every combinator at once (the "U" cheat key + the Zoo unlock).
  function unlockAll(): void {
    for (const law of CATALOG) discovered.add(law.sym);
    saveDiscovered();
    hotbar.refresh();
    for (const t of trees) t.refresh();
    zoo.refresh();
    updateHint();
    paintRail();
    toast.show("all combinators unlocked");
  }

  // Reset progress (wired to the Quest modal's Reset button): forget the discovered
  // combinators — but keep the player's own authored combos — and refresh everything.
  // The Quest stage is reset by the panel itself; this clears the discovery side.
  function resetProgress(): void {
    discovered.clear();
    for (const n of authoredNames) discovered.add(n);
    saveDiscovered();
    hotbar.refresh();
    for (const t of trees) t.refresh();
    zoo.refresh();
    updateHint();
    paintRail();
  }

  // When a tree settles at normal form, recognise what it does: unlock the law
  // if new (§7), then collapse the tree into that single named node so a
  // discovered combinator shows up *as itself* (e.g. I), not as `S K (K K)`.
  function settle(tree: TreeView): void {
    const law = recognize(tree.node);
    if (!law) return; // realises no known law — leave the term as it is
    if (!discovered.has(law.sym)) discover(law);
    if (!(tree.node.kind === "comb" && tree.node.sym === law.sym)) {
      tree.animateTo(collapsedNode(law), COLLAPSE_MS, () => {});
    }
  }

  function discover(law: Law): void {
    discovered.add(law.sym);
    saveDiscovered();
    toast.show(`${law.lawText}  —  discovered!`);
    if (isFluff("discovery")) sound.playIfReady(law.sym); // fluff: chirp the new bird (only if audio's already unlocked — discovery isn't a gesture)
    hotbar.reveal(law.sym);
    for (const t of trees) t.refresh(); // reveal newly-known combinators everywhere
    zoo.refresh();
    updateHint();
    paintRail();
  }

  // ---- authoring verbs (ADR 0006): Define (name a subtree → a new block) and
  // one-hole Abstract (mark a leaf as a hole → bracket-abstract the tree over
  // it). A rail toggle arms a select mode; the next click on a tree node acts. ----
  type AuthorMode = "define" | "abstract" | null;
  let authorMode: AuthorMode = null;

  function setAuthorMode(mode: AuthorMode): void {
    authorMode = authorMode === mode ? null : mode;
    paintRail();
    if (authorMode === "define") toast.show("Define: click a subtree to name it as a new block");
    else if (authorMode === "abstract") toast.show("Abstract: click a leaf to abstract the tree over it");
  }

  // Prompt for a fresh combinator name, validating against the catalog + existing
  // user combinators (ADR 0006: reject collisions). Returns the trimmed name, or
  // null if the player cancelled or entered an invalid one.
  function promptName(): string | null {
    const raw = window.prompt("name this combinator:");
    if (raw === null) return null;
    const err = validateName(raw);
    if (err) {
      toast.show(err);
      return null;
    }
    return raw.trim();
  }

  // Register a freshly-authored combinator: append it to the catalog, persist it,
  // reveal it in the hotbar, and seed the Zoo. Shared by Define and Abstract.
  function register(name: string, body: Node): Law {
    const law = defineCombinator(name, body);
    discovered.add(name);
    authoredNames.add(name);
    saveDiscovered();
    void store.putDefinition({ name, egg: toEgg(body) });
    hotbar.refresh();
    hotbar.reveal(name);
    zoo.rebuild();
    updateHint();
    paintRail();
    return law;
  }

  // Define: collapse the selected subtree into a named block, in place.
  function doDefine(tree: TreeView, id: NodeId): void {
    const sub = findSubtree(tree.node, id);
    if (!sub) return;
    const name = promptName();
    if (!name) return;
    const law = register(name, sub);
    cancelAuto(tree);
    tree.animateTo(replaceSubtree(tree.node, id, collapsedNode(law)), COLLAPSE_MS, () => {});
    focus = tree;
    toast.show(`defined ${name}`);
  }

  // Abstract: mark one leaf as a hole, bracket-abstract the whole tree over it,
  // and replace the tree with the resulting (named) combinator.
  function doAbstract(tree: TreeView, id: NodeId): void {
    const body = abstractLeaf(tree.node, id);
    if (!body) {
      toast.show("pick a single leaf (not an application) to abstract over");
      return;
    }
    const name = promptName();
    if (!name) return;
    const law = register(name, body);
    cancelAuto(tree);
    tree.animateTo(collapsedNode(law), COLLAPSE_MS, () => {});
    focus = tree;
    toast.show(`abstracted → ${name}`);
  }

  // ---- auto-reduce on idle (§6.4): each tree, left untouched for a beat,
  // plays itself to normal form one tween at a time; touching it cancels. A
  // per-tree generation token invalidates pending callbacks on cancel. On
  // reaching normal form, probe it for a discovery (§7.1). ----
  // `source` is the tree as the player built/edited it (captured on release),
  // before reduction mutates it — the golf metric + challenge target score the
  // source, not its normal form.
  type AutoState = { gen: number; timer: number; steps: number; source?: Node; grapher?: GraphReducer };
  const auto = new Map<TreeView, AutoState>();

  // Playback transport (§6.4): auto-reduce can be paused/played, or fast-forwarded
  // at 3× (shorter step tween + gap). Speed is read live, so play↔ff is seamless;
  // only resuming from pause re-kicks the loop.
  type Transport = "play" | "pause" | "ff";
  let transport: Transport = "play"; // trees reduce on their own; auto-pauses (with a toast) if a term won't terminate or blows up
  const speed = (): number => (transport === "ff" ? 3 : 1);
  const stepDur = (): number => STEP_MS / speed();
  const stepGap = (): number => STEP_GAP / speed();
  // Delay before the next reduction step: big trees jump-cut, so pace them at a
  // short fixed gap (still yields to the renderer); small trees use the speed gap.
  const nextGap = (t: TreeView): number => (t.heavy() ? HEAVY_GAP : stepGap());

  function cancelAuto(tree: TreeView): void {
    const a = auto.get(tree);
    if (a) {
      a.gen++;
      clearTimeout(a.timer);
    }
    tree.stopAnimation();
  }

  function scheduleAuto(tree: TreeView): void {
    let a = auto.get(tree);
    if (!a) {
      a = { gen: 0, timer: 0, steps: 0 };
      auto.set(tree, a);
    }
    a.gen++;
    a.steps = 0;
    a.source = tree.node; // score the tree as built, before reduction
    a.grapher = shareMode ? new GraphReducer(tree.node, fastMode) : undefined; // graph mode: a fresh shared graph
    const gen = a.gen;
    a.timer = window.setTimeout(() => stepAuto(tree, gen), AUTO_DELAY);
  }

  // Auto-pause (with a toast) when a tree won't settle within its step budget,
  // instead of grinding the reducer (and the frame rate) forever.
  function autoPause(reason: string): void {
    setTransport("pause");
    toast.show(`auto-paused — ${reason}`);
  }

  // A tree reached normal form: recognise + collapse it, then score it for golf.
  // Shared by the auto loop and the manual Step button so both record solves.
  function finishNormalForm(tree: TreeView, a: AutoState): void {
    settle(tree);
    void challenges.onNormalForm(a.source ?? tree.node);
    quest.onNormalForm(a.source ?? tree.node); // guided progression
  }

  // The auto-state for a tree, created (without a running timer) if missing —
  // some focused trees (e.g. spawned by the Haskell panel) were never scheduled.
  function ensureAuto(tree: TreeView): AutoState {
    let a = auto.get(tree);
    if (!a) {
      a = { gen: 0, timer: 0, steps: 0, source: tree.node };
      auto.set(tree, a);
    }
    return a;
  }

  // Fluff "marching ants": a gold dashed ring crawls + fades at a tree's root when
  // a reduction fires — skipped on fast-forward (would strobe), big trees, reduced
  // motion. One ring at a time; rapid steps restart it.
  let flourishCancel: (() => void) | null = null;
  function reduceFlourish(tree: TreeView): void {
    if (!isFluff("redexAnts") || transport === "ff" || prefersReducedMotion() || tree.heavy()) return;
    flourishCancel?.();
    world.addChild(flourish); // bring to front (above the trees added after it)
    const { x, y } = tree.rootWorld;
    flourishCancel = tween(
      pixi.ticker,
      340,
      (e) => {
        const r = 26 + 22 * e; // start outside the root-mark ring, then expand
        const N = 12;
        const arc = (Math.PI * 2) / N;
        const span = arc * 0.5;
        const off = e * arc * 1.5; // crawling dashes
        flourish.clear();
        for (let i = 0; i < N; i++) flourish.arc(x, y, r, i * arc + off, i * arc + off + span);
        flourish.stroke({ width: 2.5, color: theme.iota, alpha: 0.9 * (1 - e) });
      },
      () => {
        flourish.clear();
        flourishCancel = null;
      },
    );
  }

  function stepAuto(tree: TreeView, gen: number): void {
    const a = auto.get(tree);
    if (!a || a.gen !== gen) return;
    if (transport === "pause") return; // frozen — resume re-kicks from setTransport
    // Non-termination guard. Graph mode shares, so it does far fewer, far cheaper
    // steps and can finish reductions the tree reducer can't (fac-scale) — give it
    // a much higher ceiling so the feasibility win actually lands.
    if (a.steps >= (shareMode ? GRAPH_STEP_CAP : STEP_CAP)) {
      // Tree mode gives up early; graph mode shares (it can finish fac-scale work
      // the tree reducer can't), so point the player there before declaring defeat.
      autoPause(shareMode ? `no normal form after ${a.steps} steps` : `won't settle after ${a.steps} steps — try Graph reduction (Reduce menu)`);
      return;
    }

    // Graph mode: step the shared graph and animate each snapshot. A shared subterm
    // is one node with several incoming edges, and reducing it once updates it
    // everywhere — sharing made visible (and `fac`-scale becomes feasible). Toggled
    // mid-flight → make/clear the grapher to match.
    if (shareMode) {
      if (!a.grapher) a.grapher = new GraphReducer(tree.node, fastMode);
      const g = a.grapher;
      if (!g.step()) {
        finishNormalForm(tree, a); // normal form
        return;
      }
      sound.tick(firingRule(tree.node, fastMode)); // a tone per contraction (approx)
      a.steps = g.steps;
      reduceFlourish(tree);
      tree.animateTo(g.snapshot(), stepDur(), () => {
        const a2 = auto.get(tree);
        if (!a2 || a2.gen !== gen) return;
        if (transport === "pause") return;
        a2.timer = window.setTimeout(() => stepAuto(tree, gen), nextGap(tree));
      });
      return;
    }
    a.grapher = undefined; // optimize/raw path: no live graph

    // One traversal yields both the rule to sonify and the contractum to animate.
    const redex = redexAt(tree.node, 0, fastMode, nativeOpts());
    if (!redex) {
      finishNormalForm(tree, a); // normal form reached — recognise, collapse, score
      return;
    }
    const next = redex.build(); // build before the side effects (sound/step count)
    sound.tick(redex.sym); // sonify the rule about to fire
    a.steps++;
    reduceFlourish(tree);
    tree.animateTo(next, stepDur(), () => {
      const a2 = auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      if (transport === "pause") return; // paused mid-tween — stop scheduling
      a2.timer = window.setTimeout(() => stepAuto(tree, gen), nextGap(tree));
    });
  }

  // Step: pause, then advance the *focused* tree by exactly one reduction (no
  // reschedule). An action, not a transport mode. No-op if nothing is focused.
  function stepOnce(): void {
    setTransport("pause"); // single-stepping implies the auto-run is stopped
    const tree = focus && trees.includes(focus) ? focus : null;
    if (!tree) return;
    const a = ensureAuto(tree);
    if (shareMode) {
      if (!a.grapher) a.grapher = new GraphReducer(tree.node, fastMode);
      if (!a.grapher.step()) {
        finishNormalForm(tree, a);
        return;
      }
      sound.tick(firingRule(tree.node, fastMode));
      a.steps = a.grapher.steps;
      reduceFlourish(tree);
      tree.animateTo(a.grapher.snapshot(), stepDur(), () => {});
    } else {
      a.grapher = undefined;
      const redex = redexAt(tree.node, 0, fastMode, nativeOpts());
      if (!redex) {
        finishNormalForm(tree, a);
        return;
      }
      sound.tick(redex.sym);
      a.steps++;
      reduceFlourish(tree);
      tree.animateTo(redex.build(), stepDur(), () => {});
    }
  }

  // Switch playback mode. Pause freezes every tree; resuming re-kicks the ones
  // that still have a reduction left (settled trees stay put). play↔ff needs no
  // re-kick — stepDur/stepGap read `transport` live.
  function setTransport(mode: Transport): void {
    const wasPaused = transport === "pause";
    transport = mode;
    paintRail();
    paintTransport();
    if (mode === "pause") {
      for (const [tree, a] of auto) {
        clearTimeout(a.timer);
        tree.stopAnimation();
      }
    } else if (wasPaused) {
      for (const [tree, a] of auto) {
        if (redexAt(tree.node, 0, fastMode, nativeOpts())) {
          a.steps = 0; // explicit resume = "keep going" → a fresh budget before auto-pause re-trips
          a.gen++;
          const gen = a.gen;
          a.timer = window.setTimeout(() => stepAuto(tree, gen), 0);
        }
      }
    }
  }
  // Cycle Pause → Play → Fast-forward → Pause.
  const cycleTransport = (): void => setTransport(transport === "pause" ? "play" : transport === "play" ? "ff" : "pause");

  // ---- transport bar (top-right): the live reduction rate + Pause / Step / Play /
  // Fast-forward as side-by-side glyph buttons. The active mode is boxed in gold;
  // Step (an action, never "active") advances the focused tree one reduction. ----
  const totalSteps = (): number => [...auto.values()].reduce((s, a) => s + a.steps, 0);
  const TBTN = 26; // button-cell pitch
  type TKind = "pause" | "step" | "play" | "ff";
  const transportBar = new Container();
  hud.addChild(transportBar);
  const rateText = new Text({ text: "paused", style: { fontFamily: "monospace", fontSize: 12, fill: theme.textDim } });
  rateText.anchor.set(1, 0.5);
  transportBar.addChild(rateText);

  // Draw a transport glyph centred at the origin: ‖ / |▷ / ▷ / ▷▷.
  const drawTGlyph = (g: Graphics, kind: TKind, color: number): void => {
    g.clear();
    if (kind === "pause") g.roundRect(-6, -7, 4, 14, 1).fill({ color }).roundRect(2, -7, 4, 14, 1).fill({ color });
    else if (kind === "step") g.roundRect(-8, -7, 3, 14, 1).fill({ color }).poly([-3, -7, 6, 0, -3, 7]).fill({ color });
    else if (kind === "play") g.poly([-5, -8, 7, 0, -5, 8]).fill({ color });
    else g.poly([-8, -7, -1, 0, -8, 7]).fill({ color }).poly([0, -7, 7, 0, 0, 7]).fill({ color });
  };
  // Four buttons, laid out leftward from the corner: pause(-78) step(-52) play(-26) ff(0).
  const tButtons = (["pause", "step", "play", "ff"] as const).map((kind, i) => {
    const cont = new Container();
    cont.position.set(-(3 - i) * TBTN, 0);
    cont.eventMode = "static";
    cont.cursor = "pointer";
    cont.hitArea = new Rectangle(-TBTN / 2, -13, TBTN, 26);
    const box = new Graphics();
    const glyph = new Graphics();
    cont.addChild(box, glyph);
    cont.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (kind === "step") stepOnce();
      else setTransport(kind);
    });
    transportBar.addChild(cont);
    return { kind, box, glyph };
  });
  function paintTransport(): void {
    for (const b of tButtons) {
      const active = b.kind !== "step" && transport === b.kind;
      b.box.clear();
      if (active) b.box.roundRect(-11, -11, 22, 22, 5).fill({ color: theme.iota, alpha: 0.18 }).stroke({ width: 1, color: theme.iota });
      drawTGlyph(b.glyph, b.kind, active ? theme.iota : b.kind === "step" ? theme.text : theme.textDim);
    }
    rateText.style.fill = theme.textDim;
  }
  const placeTransport = (): void => {
    transportBar.position.set(window.innerWidth - 18, 34);
    rateText.position.set(-3 * TBTN - 22, 0); // just left of the Pause button
  };
  let rateAccum = 0;
  let lastTotal = 0;
  let redPerSec = 0;
  pixi.ticker.add((tk: { deltaMS: number }) => {
    rateAccum += tk.deltaMS;
    if (rateAccum < 300) return;
    const total = totalSteps();
    // max(0, …): an explicit resume resets per-tree step counts, so the delta (and
    // the EMA) can dip below zero — never show a negative rate.
    redPerSec = Math.max(0, redPerSec * 0.5 + ((total - lastTotal) / (rateAccum / 1000)) * 0.5);
    lastTotal = total;
    rateAccum = 0;
    rateText.text = transport === "pause" ? "paused" : `${redPerSec.toFixed(1)} red/s`;
  });
  paintTransport();
  placeTransport();

  // FPS counter (View ▸ FPS counter), bottom-left — for diagnosing render cost on
  // big trees (factorial). Off by default; sampled ~4×/s from the Pixi ticker.
  let fpsOn = false;
  const fpsText = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 12, fill: theme.textDim } });
  fpsText.anchor.set(0, 1);
  fpsText.visible = false;
  hud.addChild(fpsText);
  const placeFps = (): void => {
    fpsText.position.set(14, window.innerHeight - 12);
  };
  const toggleFps = (): void => {
    fpsOn = !fpsOn;
    fpsText.visible = fpsOn;
  };
  placeFps();
  let fpsAccum = 0;
  pixi.ticker.add((tk: { deltaMS: number }) => {
    if (!fpsOn) return;
    fpsAccum += tk.deltaMS;
    if (fpsAccum < 250) return;
    fpsAccum = 0;
    fpsText.text = `${pixi.ticker.FPS.toFixed(0)} fps`;
  });

  // Fluff: water drift — sway settled trees' leaves around their layout positions
  // (the edges/spine stay put). One ticker over all trees; each tree skips itself
  // while tweening or if it's big (heavy). Toggling drift off snaps everyone back.
  let driftT = 0;
  pixi.ticker.add((tk: { deltaMS: number }) => {
    if (prefersReducedMotion()) return;
    driftT += tk.deltaMS;
    const t = driftT / 1000;
    if (isFluff("drift")) for (const tree of trees) tree.applyDrift(t);
    if (isFluff("livingZoo")) zoo.tickFluff(t); // float the open creature's picture
  });
  // Snap everything back to rest whenever ambient motion stops (a toggle changed,
  // or the OS reduced-motion preference flipped). The ticker re-applies next frame
  // if the effect is still on.
  const resetAmbient = (): void => {
    for (const tree of trees) tree.clearDrift();
    zoo.clearFluff();
  };
  onFluffChange(resetAmbient);
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener("change", resetAmbient);
  // Leaf-nodes toggle changes the particle texture, baked in at creation — rebuild
  // each tree's display so it applies immediately (only when that toggle flips).
  let prevLeaves = isFluff("leaves");
  onFluffChange(() => {
    if (isFluff("leaves") !== prevLeaves) {
      prevLeaves = isFluff("leaves");
      for (const tree of trees) tree.refresh();
    }
  });

  // Stage receives pointer events over empty space (so panning works there).
  pixi.stage.eventMode = "static";
  const fitStage = () => {
    pixi.stage.hitArea = new Rectangle(0, 0, window.innerWidth, window.innerHeight);
  };
  fitStage();

  const screenToWorld = (x: number, y: number) => world.toLocal({ x, y });

  function addTree(tree: TreeView): void {
    trees.push(tree);
    world.addChild(tree.container);
    tree.container.on("pointerdown", (e: FederatedPointerEvent) => onTreeDown(tree, e));
    tree.container.on("rightdown", (e: FederatedPointerEvent) => onTreeRightDown(tree, e));
  }

  function spawnTree(node: Node, screenX: number, screenY: number): TreeView {
    const w = screenToWorld(screenX, screenY);
    const tree = new TreeView(node, w.x, w.y, pixi.ticker, isDiscovered, layoutFn, () => expandAll, cameraTransform);
    addTree(tree);
    focus = tree;
    if (!prefersReducedMotion()) tree.popIn(); // grab/spawn pop is always on (only reduced-motion suppresses it)
    return tree;
  }

  const spawnFor = (sym: string): Node => (sym === "ι" ? iota() : collapsedNode(CATALOG.find((l) => l.sym === sym)!));
  const hotbar = new Hotbar(
    (node, e) => {
      hint.visible = false;
      drag = { kind: "spawn", tree: spawnTree(node, e.global.x, e.global.y) };
    },
    pixi.ticker,
    isDiscovered,
    spawnFor,
  );
  hotbar.refresh();
  hud.addChild(hotbar.container);
  hud.addChild(zoo.container); // last → the Zoo overlay sits on top of the hotbar

  // ---- golf challenges + leaderboard + sonification (ADR 0005) ----
  // (the shared `store` is declared up top; `sound` is constructed up by the Zoo,
  // which needs sound.play for its tones.)
  const challenges = new ChallengePanel(store, { notify: (m) => toast.show(m), onShare: (token) => shareToken(token) });
  const quest = new QuestPanel({
    notify: (m) => toast.show(m),
    onUnlock: (sym) => {
      const law = CATALOG.find((l) => l.sym === sym);
      if (law && !discovered.has(sym)) discover(law);
    },
    onReset: () => resetProgress(),
  });
  // Tracked-quest HUD (ADR 13): a glanceable side card mirroring the current stage,
  // refreshed whenever the quest advances. The panel stays the sole owner of progress.
  const questTracker = new QuestTracker({
    current: () => quest.current,
    location: () => quest.location,
    done: () => quest.done,
    openQuest: () => quest.open(),
  });
  quest.onAdvance(() => {
    questTracker.refresh();
    updateHint(); // the in-HUD hint tracks the current quest stage
  });
  hud.addChild(challenges.container); // overlays the hotbar, like the Zoo

  // Haskell → ι panel (ADR 0007): compile a curated or free-typed program (stock
  // MicroHs dump, post-processed) and drop the resulting combinator tree on the
  // canvas. A DOM overlay, so it lives outside the Pixi HUD. The result's read-out
  // lens (Int/List/Char/Bool) is set by jumping to the matching hotbar page.
  const TY_PAGE: Record<Ty, string> = { Int: "Arithmetic", Bool: "Booleans", List: "Lists", Char: "Char" };
  const mhsPanel = new MhsPanel(
    (tree, read) => {
      // Compiled programs are big: optimize, lay out radially, and zoom to fit.
      setOpt("rules", true);
      setLayoutMode(layoutRadial);
      const view = spawnTree(tree, window.innerWidth / 2, window.innerHeight / 2);
      if (read) hotbar.selectPage(TY_PAGE[read]);
      fitTree(view);
      toast.show("compiled from Haskell");
    },
    () => paintRail(),
  );
  updateHint();

  function onTreeDown(tree: TreeView, e: FederatedPointerEvent): void {
    if (e.button !== 0) return; // left-drag only; right-click is handled separately
    e.stopPropagation();
    // An armed authoring mode consumes the click on a picked node instead of dragging.
    if (authorMode) {
      const id = tree.pickNode(e.global);
      if (id !== null) (authorMode === "define" ? doDefine : doAbstract)(tree, id);
      authorMode = null;
      paintRail();
      return;
    }
    focus = tree;
    cancelAuto(tree); // touching a tree freezes it (§6.4)
    const w = screenToWorld(e.global.x, e.global.y);
    world.addChild(tree.container); // bring to front
    drag = {
      kind: "tree",
      tree,
      offX: tree.container.position.x - w.x,
      offY: tree.container.position.y - w.y,
    };
  }

  // Right-click a node to delete its subtree (the sibling is promoted, §6.2).
  function onTreeRightDown(tree: TreeView, e: FederatedPointerEvent): void {
    e.stopPropagation();
    const id = tree.pickNode(e.global);
    if (id === null) return;
    cancelAuto(tree);
    const next = removeSubtree(tree.node, id);
    if (next === null) {
      // deleted the root → the whole tree goes
      auto.delete(tree);
      trees.splice(trees.indexOf(tree), 1);
      tree.destroy();
      if (focus === tree) focus = null;
    } else {
      focus = tree;
      tree.animateTo(next, DELETE_MS, () => {});
      scheduleAuto(tree); // re-reduce the edited tree once it's left alone
    }
  }

  pixi.stage.on("pointerdown", (e: FederatedPointerEvent) => {
    if (drag || pinch || e.button !== 0) return; // a tree/slot claimed it, pinching, or a right-click
    drag = {
      kind: "pan",
      startX: e.global.x,
      startY: e.global.y,
      worldX: world.position.x,
      worldY: world.position.y,
    };
  });

  pixi.stage.on("globalpointermove", (e: FederatedPointerEvent) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      world.position.set(drag.worldX + (e.global.x - drag.startX), drag.worldY + (e.global.y - drag.startY));
      return;
    }
    const tree = drag.tree;
    const w = screenToWorld(e.global.x, e.global.y);
    if (drag.kind === "tree") {
      tree.container.position.set(w.x + drag.offX, w.y + drag.offY);
    } else {
      tree.container.position.set(w.x, w.y);
    }
    updateSnap(tree);
  });

  const onUp = () => {
    if (!drag) return;
    if (drag.kind === "tree" || drag.kind === "spawn") {
      const tree = drag.tree;
      if (snapTarget) {
        commitSnap(tree, snapTarget);
      } else {
        scheduleAuto(tree); // released untouched → it begins reducing
      }
    }
    clearGhost();
    drag = null;
  };
  pixi.stage.on("pointerup", onUp);
  pixi.stage.on("pointerupoutside", onUp);

  function updateSnap(dragged: TreeView): void {
    let best: TreeView | null = null;
    let bestDist = SNAP_R;
    for (const other of trees) {
      if (other === dragged) continue;
      const d = Math.hypot(other.rootWorld.x - dragged.rootWorld.x, other.rootWorld.y - dragged.rootWorld.y);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    snapTarget = best;
    drawGhost(dragged, best);
  }

  // Preview the application about to form, with the same fn/arg edge colours as
  // the committed result so you can see which side becomes the function.
  function drawGhost(dragged: TreeView, target: TreeView | null): void {
    ghost.clear();
    if (!target) return;
    const left = dragged.rootWorld.x <= target.rootWorld.x ? dragged : target;
    const right = left === dragged ? target : dragged;
    const ax = (left.rootWorld.x + right.rootWorld.x) / 2;
    const ay = Math.min(left.rootWorld.y, right.rootWorld.y) - 56;
    ghost.moveTo(ax, ay).lineTo(left.rootWorld.x, left.rootWorld.y).stroke({ width: 3, color: theme.fnEdge, alpha: 0.7 }); // function: solid
    dashedSegment(ghost, ax, ay, right.rootWorld.x, right.rootWorld.y); // argument: dashed, matching the committed tree
    ghost.stroke({ width: 2.5, color: theme.argEdge, alpha: 0.7 });
    ghost.circle(ax, ay, 6).fill({ color: theme.mutedDot, alpha: 0.7 });
    // preview the resulting expression (left is the function), masked like the rest
    ghostLabel.text = `(${exprOf(left.node)} ${exprOf(right.node)})`;
    ghostLabel.position.set(ax, ay - 12);
    ghostLabel.visible = true;
  }

  function clearGhost(): void {
    ghostLabel.visible = false;
    ghost.clear();
    snapTarget = null;
  }

  // Snap = application. Horizontal order of the two roots decides fn (left) vs arg (§6.2).
  function commitSnap(dragged: TreeView, target: TreeView): void {
    const fn = dragged.rootWorld.x <= target.rootWorld.x ? dragged : target;
    const arg = fn === dragged ? target : dragged;
    const root = mkApp(fn.node, arg.node);
    const ax = (dragged.rootWorld.x + target.rootWorld.x) / 2;
    const ay = Math.min(dragged.rootWorld.y, target.rootWorld.y) - 32;
    // capture where every subtree node currently sits, to glide them in (§6.2)
    const fromWorld = new Map<NodeId, { x: number; y: number }>();
    for (const t of [dragged, target]) {
      for (const [id, p] of t.nodeWorldPositions()) fromWorld.set(id, p);
    }
    for (const old of [dragged, target]) {
      cancelAuto(old);
      auto.delete(old);
      trees.splice(trees.indexOf(old), 1);
      old.destroy();
    }
    const merged = new TreeView(root, ax, ay, pixi.ticker, isDiscovered, layoutFn, () => expandAll, cameraTransform);
    addTree(merged);
    focus = merged;
    merged.animateAttachFrom(fromWorld, ATTACH_MS); // smooth merge into the app tree
    scheduleAuto(merged); // then it reduces on its own
  }

  // ---- camera zoom: mouse wheel (desktop) + two-finger pinch (touch) ----
  // Set a new scale while keeping the screen point (sx, sy) fixed under it.
  const zoomTo = (newScale: number, sx: number, sy: number): void => {
    const s = Math.max(0.04, Math.min(4, newScale)); // floor low enough that a fac-scale tree fits
    const ratio = s / world.scale.x;
    world.position.set(sx - (sx - world.position.x) * ratio, sy - (sy - world.position.y) * ratio);
    world.scale.set(s);
  };

  pixi.canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      if (zoo.isOpen || challenges.isOpen) return; // an open overlay owns the wheel (its list scrolls instead of zooming the canvas behind it)
      zoomTo(world.scale.x * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), ev.clientX, ev.clientY);
    },
    { passive: false },
  );

  // Two-finger pinch: track touch points and zoom/pan around their midpoint.
  // Starting a pinch drops any single-finger drag (its `drag` is cleared, so the
  // Pixi move handler idles), and the stage won't begin a pan while pinching.
  const pinchMetrics = (): { d: number; cx: number; cy: number } => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  pixi.canvas.addEventListener("pointerdown", (ev) => {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      clearGhost();
      drag = null; // hand control to the pinch
      pinch = pinchMetrics();
    }
  });
  pixi.canvas.addEventListener("pointermove", (ev) => {
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    p.x = ev.clientX;
    p.y = ev.clientY;
    if (pointers.size >= 2 && pinch) {
      const cur = pinchMetrics();
      world.position.set(world.position.x + (cur.cx - pinch.cx), world.position.y + (cur.cy - pinch.cy));
      zoomTo(world.scale.x * (cur.d / pinch.d), cur.cx, cur.cy);
      pinch = cur;
    }
  });
  const endPointer = (ev: PointerEvent): void => {
    pointers.delete(ev.pointerId);
    pinch = pointers.size >= 2 ? pinchMetrics() : null;
  };
  pixi.canvas.addEventListener("pointerup", endPointer);
  pixi.canvas.addEventListener("pointercancel", endPointer);

  // Top-left, just under the hint line (offset so the two rows don't overlap it).
  const placeLegend = () => legend.position.set(16, 58);
  placeLegend();
  zoo.layout();

  // Repaint the whole scene when the theme changes (OS change or menu toggle). The
  // menu bar restyles itself via its own onThemeChange listener.
  function applyTheme(): void {
    pixi.renderer.background.color = theme.bg;
    hint.style.fill = theme.textDim;
    exprText.style.fill = theme.text;
    nextHint.style.fill = theme.textDim;
    ghostLabel.style.fill = theme.text;
    fpsText.style.fill = theme.textDim;
    paintLegend(legend);
    paintTransport();
    hotbar.refresh();
    zoo.applyTheme();
    challenges.applyTheme();
    for (const t of trees) t.refresh();
  }
  onThemeChange(applyTheme);

  window.addEventListener("resize", () => {
    fitStage();
    hotbar.layout();
    placeLegend();
    placeTransport();
    placeFps();
    toast.layout();
    placeExpr();
    zoo.layout();
    challenges.layout();
  });

  // Render efficiency: stop the render/animation loop while the tab is hidden —
  // no point drawing the drift to an invisible canvas. (Browsers throttle rAF in
  // the background; this also idles the drift/rate samplers.) setTimeout-driven
  // reduction keeps crawling and catches up on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pixi.ticker.stop();
    else pixi.ticker.start();
  });

  // Remove every tree from the canvas (discoveries and the hotbar stay).
  function clearCanvas(): void {
    for (const t of trees) {
      cancelAuto(t);
      auto.delete(t);
      t.destroy();
    }
    trees.length = 0;
    clearGhost();
    drag = null;
    focus = null;
  }

  // Set the layout for every tree (and trees spawned afterward).
  const setLayoutMode = (fn: LayoutFn): void => {
    if (layoutFn === fn) return;
    layoutFn = fn;
    for (const t of trees) t.setLayout(fn);
    paintRail();
  };
  // T cycles auto → top-down → radial → auto.
  function toggleLayout(): void {
    setLayoutMode(layoutFn === layoutAuto ? layoutTopDown : layoutFn === layoutTopDown ? layoutRadial : layoutAuto);
  }

  /** Frame a tree to fill the viewport (zoom + centre) — from its layout bbox. */
  function fitTree(tree: TreeView): void {
    const b = tree.worldBounds();
    const margin = 0.82;
    const scale = Math.max(0.04, Math.min(2.5, Math.min((window.innerWidth * margin) / Math.max(b.w, 1), (window.innerHeight * margin) / Math.max(b.h, 1))));
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    world.scale.set(scale);
    world.position.set(window.innerWidth / 2 - cx * scale, window.innerHeight / 2 - cy * scale);
  }

  // Toggle the "expand everything to ι" view (read by TreeView.expand).
  function toggleExpand(): void {
    expandAll = !expandAll;
    for (const t of trees) t.refresh();
    paintRail();
  }

  // ---- top menu bar (System 1 Macintosh): the old left rail folded into
  // pull-downs. Reuses the action callbacks below; a ✓ marks an active toggle,
  // a • the selected option in a group. paintRail() (kept for its many callers)
  // now just refreshes the open pull-down's checkmarks. ----
  const about = new About();
  const fluff = new FluffPanel();
  const optimize = new OptimizePanel();
  // The optimize store is the source of truth; mirror it into the reducer flags and do
  // the per-mode invalidation (carry the changed key so we invalidate only what changed).
  onOptChange((key) => {
    if (key === "rules") {
      fastMode = isOpt("rules");
      for (const a of auto.values()) a.grapher = undefined; // graphers bake `fast` at construction
    } else if (key === "graph") {
      shareMode = isOpt("graph");
      if (focus) scheduleAuto(focus);
    }
    paintRail();
  });
  const menus: Menu[] = [
    { title: "ι", apple: true, items: [
      { kind: "action", label: "About Combinate…", run: () => about.open() },
    ] },
    { title: "File", items: [
      { kind: "action", label: "Compile Haskell…", run: () => mhsPanel.open() },
      { kind: "action", label: "Share link", run: () => shareFocused() },
      { kind: "sep" },
      { kind: "action", label: "Clear canvas", accel: "R", run: () => clearCanvas() },
    ] },
    { title: "Edit", items: [
      { kind: "toggle", label: "Define combinator", accel: "D", checked: () => authorMode === "define", run: () => setAuthorMode(authorMode === "define" ? null : "define") },
      { kind: "toggle", label: "Abstract variable", accel: "A", checked: () => authorMode === "abstract", run: () => setAuthorMode(authorMode === "abstract" ? null : "abstract") },
      { kind: "sep" },
      { kind: "action", label: "Unlock all combinators", accel: "U", run: () => unlockAll() },
    ] },
    { title: "View", items: [
      { kind: "radio", label: "Auto layout", on: () => layoutFn === layoutAuto, run: () => setLayoutMode(layoutAuto) },
      { kind: "radio", label: "Top-down layout", on: () => layoutFn === layoutTopDown, run: () => setLayoutMode(layoutTopDown) },
      { kind: "radio", label: "Radial layout", accel: "T", on: () => layoutFn === layoutRadial, run: () => setLayoutMode(layoutRadial) },
      { kind: "sep" },
      { kind: "toggle", label: "Expand ι-trees", accel: "X", checked: () => expandAll, run: () => toggleExpand() },
      { kind: "toggle", label: "Type lens", checked: () => typeOn, run: () => toggleType() },
      { kind: "toggle", label: "Re-fold lens", accel: "F", checked: () => refoldOn, run: () => toggleRefold() },
      { kind: "sep" },
      { kind: "toggle", label: "Dark mode", checked: () => currentMode() === "dark", run: () => toggleMode() },
      { kind: "toggle", label: "Color (4096)", checked: () => colorOn(), run: () => toggleColor() },
      { kind: "sep" },
      { kind: "toggle", label: "FPS counter", checked: () => fpsOn, run: () => toggleFps() },
      { kind: "sep" },
      { kind: "action", label: "Fluff…", run: () => fluff.open() },
    ] },
    { title: "Reduce", items: [
      { kind: "radio", label: "Pause", on: () => transport === "pause", run: () => setTransport("pause") },
      { kind: "radio", label: "Play", on: () => transport === "play", run: () => setTransport("play") },
      { kind: "radio", label: "Fast-forward", on: () => transport === "ff", run: () => setTransport("ff") },
      { kind: "action", label: "Step", run: () => stepOnce() },
      { kind: "sep" },
      { kind: "action", label: "Optimizations…", run: () => optimize.open() },
      { kind: "sep" },
      { kind: "toggle", label: "Sound", checked: () => sound.enabled, run: () => sound.toggle() },
    ] },
    { title: "Special", items: [
      { kind: "toggle", label: "Quest", checked: () => quest.isOpen, run: () => quest.toggle() },
      { kind: "toggle", label: "Track Quest", checked: () => !quest.done && !questTracker.isHidden, run: () => { questTracker.setHidden(!questTracker.isHidden); paintRail(); } },
      { kind: "toggle", label: "Zoo", accel: "Z", checked: () => zoo.isOpen, run: () => zoo.toggle() },
      { kind: "toggle", label: "Golf challenges", accel: "G", checked: () => challenges.isOpen, run: () => challenges.toggle() },
    ] },
  ];
  menuBar = new MenuBar(menus);
  function paintRail(): void {
    menuBar?.refresh();
  }

  // ---- permalinks (ADR 0005): a tree + active modes <-> a URL-safe token. ----
  const MAX_HASH = 1800; // beyond this, share a downloadable .json instead of a link

  /** The currently-active display modes, packed for a permalink. */
  const currentModes = (): Modes => ({
    optimize: fastMode || undefined,
    graph: shareMode || undefined,
    refold: refoldOn || undefined,
    type: typeOn || undefined,
    expand: expandAll || undefined,
    page: hotbar.page,
    transport,
  });

  /** Restore a tree's accompanying display modes (the inverse of currentModes). */
  function applyModes(m: Modes): void {
    expandAll = !!m.expand;
    setOpt("rules", !!m.optimize, false); // permalink modes are tree-local — drive the reducer, don't persist as a preference
    setOpt("graph", !!m.graph, false);
    typeOn = !!m.type;
    refoldOn = !!m.refold;
    if (refoldOn && !refolder) {
      refolder = behavioralRefolder;
      void ensureRefolder();
    }
    if (m.page) hotbar.selectPage(m.page);
    if (m.transport) setTransport(m.transport);
    lastShownNode = null; // force a read-out recompute
    paintRail();
    for (const t of trees) t.refresh();
  }

  /** Write a permalink token to the hash + clipboard, or download it as JSON when
   *  it's too long for a link. */
  function shareToken(token: string): void {
    if (token.length > MAX_HASH) {
      const blob = new Blob([JSON.stringify({ permalink: token })], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "combinate-solution.json";
      a.click();
      URL.revokeObjectURL(url);
      toast.show("too long for a link — downloaded .json");
      return;
    }
    location.hash = token;
    void navigator.clipboard?.writeText(location.href).catch(() => {});
    toast.show("link copied to clipboard");
  }

  /** Share the focused tree (the "share" rail action). */
  function shareFocused(): void {
    if (!focus || !trees.includes(focus)) {
      toast.show("nothing to share");
      return;
    }
    shareToken(encodePermalink(focus.node, currentModes()));
  }

  // On load, a permalink in the URL hash restores its tree + modes.
  if (location.hash.length > 1) {
    const decoded = decodePermalink(location.hash.slice(1));
    if (decoded) {
      applyModes(decoded.modes);
      const t = spawnTree(decoded.tree, window.innerWidth / 2, window.innerHeight / 2);
      scheduleAuto(t);
      hint.visible = false;
      toast.show("restored from link");
    }
  }

  window.addEventListener("keydown", (e) => {
    if (zoo.isOpen) {
      if (e.key === "ArrowDown") return e.preventDefault(), zoo.move(1);
      if (e.key === "ArrowUp") return e.preventDefault(), zoo.move(-1);
      if (e.key === "ArrowRight") return e.preventDefault(), zoo.cyclePage(1);
      if (e.key === "ArrowLeft") return e.preventDefault(), zoo.cyclePage(-1);
      if (e.key === "Escape") return zoo.close();
    }
    if (e.key === "r" || e.key === "R") clearCanvas();
    else if (e.key === "t" || e.key === "T") toggleLayout();
    else if (e.key === "u" || e.key === "U") unlockAll();
    else if (e.key === "x" || e.key === "X") toggleExpand();
    else if (e.key === "f" || e.key === "F") toggleRefold();
    else if (e.key === "z" || e.key === "Z") zoo.toggle();
    else if (e.key === "g" || e.key === "G") challenges.toggle();
    else if (e.key === "d" || e.key === "D") setAuthorMode("define");
    else if (e.key === "a" || e.key === "A") setAuthorMode("abstract");
  });

  // Suppress the browser context menu so right-click can delete a node.
  pixi.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // A small key explaining the two edge styles (which child is the function);
  // repainted on a theme change.
  function paintLegend(c: Container): void {
    for (const ch of c.removeChildren()) ch.destroy({ children: true });
    const g = new Graphics();
    g.moveTo(0, 0).lineTo(26, 0).stroke({ width: 3, color: theme.fnEdge }); // function: solid
    for (let x = 0; x < 26; x += 14) g.moveTo(x, 18).lineTo(Math.min(x + 8, 26), 18); // argument: dashed (matches the tree)
    g.stroke({ width: 2.5, color: theme.argEdge });
    c.addChild(g);
    const style = { fontFamily: "monospace", fontSize: 12, fill: theme.textDim };
    const l1 = new Text({ text: "function (left)", style });
    l1.position.set(34, -7);
    const l2 = new Text({ text: "argument (right)", style });
    l2.position.set(34, 11);
    c.addChild(l1, l2);
  }

  // Preload the re-folding lens wasm during the splash (it's otherwise lazy on
  // first toggle). A real asset fetch — and it makes the lens instant when first
  // used. ensureRefolder swallows a load failure (the behavioural-only re-folder
  // still works), so this never blocks startup.
  await ensureRefolder();
  onStep("lenses"); // splash step 3/4

  // Warm the MicroHs live-compile blob + cache (the 3 MB compiler), so the Haskell
  // panel is ready and its first compile doesn't pay the download. Best-effort.
  await preloadCompiler();
  onStep("compiler"); // splash step 4/4

  // Dev-only test seam (stripped from production builds): expose tree state so
  // an end-to-end driver can assert on spawn/snap/reduce.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    (globalThis as Record<string, unknown>).__combinate = {
      trees,
      sexps: () => trees.map((t) => sexp(t.node)),
      roots: () => trees.map((t) => t.rootWorld),
      discovered: () => [...discovered],
      mode: () => (layoutFn === layoutAuto ? "auto" : layoutFn === layoutRadial ? "radial" : "topdown"),
      toggleLayout: () => toggleLayout(),
      transport: { mode: () => transport, set: (m: string) => setTransport(m as Transport), cycle: () => cycleTransport(), step: () => stepOnce() },
      autoSteps: () => [...auto.values()].reduce((s, a) => s + a.steps, 0),
      run: () => { if (focus) scheduleAuto(focus); },
      fast: { on: () => isOpt("rules"), set: (b: boolean) => setOpt("rules", b) },
      graph: { on: () => isOpt("graph"), set: (b: boolean) => setOpt("graph", b), eval: (s: string) => sexp(evalShared(fromEgg(s), 500000, fastMode).term) },
      expr: () => exprText.text,
      page: () => hotbar.page,
      setPage: (name: string) => hotbar.selectPage(name),
      type: { on: () => typeOn, toggle: () => toggleType(), of: (s: string) => inferType(fromEgg(s)) },
      unlockAll: () => unlockAll(),
      openZoo: () => zoo.open(),
      camera: () => ({ scale: world.scale.x, x: world.position.x, y: world.position.y }),
      golf: {
        toggle: () => challenges.toggle(),
        onNF: (s: string) => challenges.onNormalForm(fromEgg(s)),
        permalink: () => (focus ? encodePermalink(focus.node, currentModes()) : null),
      },
      quest: {
        open: () => quest.open(),
        stage: () => quest.stageIndex,
        onNF: (s: string) => quest.onNormalForm(fromEgg(s)),
      },
      sound: { on: () => sound.enabled, toggle: () => sound.toggle() },
      haskell: { open: () => mhsPanel.open(), close: () => mhsPanel.close(), isOpen: () => mhsPanel.isOpen, run: (n: string) => mhsPanel.run(n), examples: () => mhsPanel.examples, compile: (s: string) => mhsPanel.compileLive(s) },
      store, // the active Store (LocalStore, or DuckdbStore with ?store=duckdb) — for tests
      author: {
        mode: () => authorMode,
        setMode: (m: string | null) => setAuthorMode(m as AuthorMode),
        // define a combinator from an egg s-expression body (returns an error or null)
        define: (name: string, egg: string): string | null => {
          const err = validateName(name);
          if (err) return err;
          register(name, fromEgg(egg));
          return null;
        },
        defs: () => CATALOG.filter((l) => l.userDefined).map((l) => l.sym),
      },
      refold: {
        on: () => refoldOn,
        ready: () => !!refolder,
        init: () => ensureRefolder(),
        toggle: () => toggleRefold(),
        raw: (s: string) => refoldRaw?.(s) ?? null,
        // behavioural pre-pass alone, on an egg s-expression term
        deep: (s: string) => sexp(recognizeDeep(fromEgg(s))),
        // Phase 1 value reader, on an egg s-expression term
        value: (s: string) => {
          const v = read(fromEgg(s));
          return v ? render(v) : null;
        },
        // spawn a term from an egg s-expression and focus it (drives the read-out)
        spawn: (s: string) => sexp(spawnTree(fromEgg(s), window.innerWidth / 2, window.innerHeight / 2).node),
      },
    };
  }
}
