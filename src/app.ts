import {
  Application,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Rectangle,
  Text,
} from "pixi.js";
import { app as mkApp, comb, decode, iota, type Node, type NodeId, removeSubtree, sexp } from "./core/term";
import { step, firingRule } from "./core/reduce";
import { encodePermalink, decodePermalink, type Modes } from "./core/permalink";
import { LocalStore } from "./store/local";
import { DuckdbStore } from "./store/duckdb";
import { ChallengePanel } from "./view/challenge";
import { Sound } from "./view/sound";
import { CATALOG, IOTA_CODE, HINTS, iotaTreeOf, countIotas, type Law } from "./core/catalog";
import { recognize } from "./core/probe";
import { layoutRadial, layoutTopDown, type LayoutFn } from "./core/layout";
import { makeRefolder, behavioralRefolder, recognizeDeep, fromEgg, toEgg, type Refolder } from "./core/refold";
import { read, render, type Ty } from "./core/types";
import { inferType } from "./core/infer";
import { abstractLeaf, defineCombinator, findSubtree, isNameTaken, replaceSubtree, validateName } from "./core/authoring";
import { TreeView } from "./view/tree";
import { Hotbar } from "./view/hotbar";
import { Toast } from "./view/toast";
import { Zoo } from "./view/zoo";
import { theme, initTheme, toggleMode, onThemeChange } from "./view/theme";

const SNAP_R = 72; // world-space snap radius between two tree root anchors (~1.3·XS)
const AUTO_DELAY = 450; // ms a tree must sit untouched before it starts reducing (§6.4)
const STEP_MS = 300; // duration of one reduction-step tween
const STEP_GAP = 130; // pause between reduction steps
const STEP_CAP = 2000; // non-termination guard: stop auto-reducing past this many steps
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
export async function mountApp(): Promise<void> {
  initTheme(); // pick light/dark from the OS before anything paints
  const pixi = new Application();
  // resolution + autoDensity render at device pixel density so text/edges are
  // crisp on retina / iOS instead of grainy. Cap at 2× — past that the extra
  // pixels (e.g. 3× on iPhones, ~2.25× the work) aren't perceptible but cost fps.
  await pixi.init({ background: theme.bg, resizeTo: window, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
  document.body.appendChild(pixi.canvas);

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

  const trees: TreeView[] = [];
  let drag: Drag = null;
  let snapTarget: TreeView | null = null;
  let focus: TreeView | null = null; // the tree whose expression is shown up top
  // Active touch points (by id) + the previous pinch frame, for two-finger zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; cx: number; cy: number } | null = null;
  let expandAll = false; // "Expand" view: draw every combinator as its full ι-tree
  let fastMode = false; // "optimize" mode: reduce named combinators by their rule (not raw SKI)

  const hint = new Text({
    text: "drag ι · snap trees · they reduce on their own · right-click deletes a node",
    style: { fontFamily: "monospace", fontSize: 14, fill: theme.textDim },
  });
  hint.position.set(16, 14);
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
    exprText.position.set(window.innerWidth / 2, 18);
    nextHint.style.wordWrapWidth = Math.min(940, window.innerWidth - 120);
    nextHint.position.set(window.innerWidth / 2, 44);
  };
  placeExpr();

  // The easiest undiscovered combinator to aim for next (fewest ι in its tree),
  // shown with a research-backed hint on how to build it.
  function updateHint(): void {
    let best: Law | null = null;
    let bestN = Infinity;
    for (const law of CATALOG) {
      if (isDiscovered(law.sym)) continue;
      const n = countIotas(iotaTreeOf(law));
      if (n < bestN) {
        bestN = n;
        best = law;
      }
    }
    nextHint.text = best ? `next to discover →  ${HINTS[best.sym] ?? best.lawText}` : "✦ every combinator discovered ✦";
  }

  // ---- discovery (§7): the set of combinators found so far. Drives the
  // behavioural probe (what to still look for) and the masking of transient
  // S/K/I nodes (undiscovered ones render as "?", revealed on discovery). ----
  const discovered = new Set<string>();
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
    } catch {
      /* malformed stored definition — drop it */
    }
  }

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
  const READ_AS: Record<string, Ty> = { Arithmetic: "Int", Booleans: "Bool", Lists: "List" };

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
  let layoutFn: LayoutFn = layoutTopDown;

  // What a recognised tree collapses into: a single named node. I/K/S reduce by
  // built-in rules; the rest carry their definition (law.def) for the reducer
  // to unfold when applied.
  const collapsedNode = (law: Law): Node => comb(law.sym, law.def?.(), law.arity);

  const zoo = new Zoo(isDiscovered); // added to the HUD last (below) so it overlays everything

  // Reveal every combinator at once (the "U" cheat key + the Zoo unlock).
  function unlockAll(): void {
    for (const law of CATALOG) discovered.add(law.sym);
    hotbar.refresh();
    for (const t of trees) t.refresh();
    zoo.refresh();
    updateHint();
    paintRail();
    toast.show("all combinators unlocked");
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
    toast.show(`${law.lawText}  —  discovered!`);
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
  const auto = new Map<TreeView, { gen: number; timer: number; steps: number; source?: Node }>();

  // Playback transport (§6.4): auto-reduce can be paused/played, or fast-forwarded
  // at 3× (shorter step tween + gap). Speed is read live, so play↔ff is seamless;
  // only resuming from pause re-kicks the loop.
  type Transport = "play" | "pause" | "ff";
  let transport: Transport = "play";
  const speed = (): number => (transport === "ff" ? 3 : 1);
  const stepDur = (): number => STEP_MS / speed();
  const stepGap = (): number => STEP_GAP / speed();

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
    const gen = a.gen;
    a.timer = window.setTimeout(() => stepAuto(tree, gen), AUTO_DELAY);
  }

  function stepAuto(tree: TreeView, gen: number): void {
    const a = auto.get(tree);
    if (!a || a.gen !== gen) return;
    if (transport === "pause") return; // frozen — resume re-kicks from setTransport
    if (a.steps >= STEP_CAP) return; // still reducing — bail (non-termination guard)
    const next = step(tree.node, 0, fastMode);
    if (!next) {
      settle(tree); // normal form reached — recognise + collapse to a named node
      void challenges.onNormalForm(a.source ?? tree.node); // golf: score the built tree
      return;
    }
    sound.tick(firingRule(tree.node, fastMode)); // sonify the rule about to fire
    a.steps++;
    tree.animateTo(next, stepDur(), () => {
      const a2 = auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      if (transport === "pause") return; // paused mid-tween — stop scheduling
      a2.timer = window.setTimeout(() => stepAuto(tree, gen), stepGap());
    });
  }

  // Switch playback mode. Pause freezes every tree; resuming re-kicks the ones
  // that still have a reduction left (settled trees stay put). play↔ff needs no
  // re-kick — stepDur/stepGap read `transport` live.
  function setTransport(mode: Transport): void {
    const wasPaused = transport === "pause";
    transport = mode;
    paintRail();
    if (mode === "pause") {
      for (const [tree, a] of auto) {
        clearTimeout(a.timer);
        tree.stopAnimation();
      }
    } else if (wasPaused) {
      for (const [tree, a] of auto) {
        if (step(tree.node, 0, fastMode)) {
          a.gen++;
          const gen = a.gen;
          a.timer = window.setTimeout(() => stepAuto(tree, gen), 0);
        }
      }
    }
  }
  const cycleTransport = (): void => setTransport(transport === "play" ? "pause" : transport === "pause" ? "ff" : "play");

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
  const rail = new Container(); // left-edge button rail (built below); under the Zoo overlay
  hud.addChild(rail);
  hud.addChild(zoo.container); // last → the Zoo overlay sits on top of the hotbar + rail

  // ---- golf challenges + leaderboard + sonification (ADR 0005) ----
  // (the shared `store` is declared up top, with the authoring load.)
  const sound = new Sound();
  const challenges = new ChallengePanel(store, { notify: (m) => toast.show(m), onShare: (token) => shareToken(token) });
  hud.addChild(challenges.container); // overlays the hotbar + rail, like the Zoo
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
    ghost.moveTo(ax, ay).lineTo(left.rootWorld.x, left.rootWorld.y).stroke({ width: 3, color: theme.fnEdge, alpha: 0.7 });
    ghost.moveTo(ax, ay).lineTo(right.rootWorld.x, right.rootWorld.y).stroke({ width: 2.5, color: theme.argEdge, alpha: 0.7 });
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
    const s = Math.max(0.2, Math.min(4, newScale));
    const ratio = s / world.scale.x;
    world.position.set(sx - (sx - world.position.x) * ratio, sy - (sy - world.position.y) * ratio);
    world.scale.set(s);
  };

  pixi.canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
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

  const placeLegend = () => legend.position.set(16, window.innerHeight - 184);
  placeLegend();
  zoo.layout();

  // ---- light/dark toggle (top-right): defaults to the OS scheme, a click pins it ----
  const themeBtn = new Container();
  themeBtn.eventMode = "static";
  themeBtn.cursor = "pointer";
  themeBtn.hitArea = new Rectangle(-18, -18, 36, 36);
  themeBtn.on("pointerdown", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    toggleMode();
  });
  hud.addChild(themeBtn);
  const placeThemeBtn = () => themeBtn.position.set(window.innerWidth - 30, 30);
  const paintThemeBtn = (): void => {
    for (const c of themeBtn.removeChildren()) c.destroy({ children: true });
    const g = new Text({ text: "◐", style: { fontFamily: "monospace", fontSize: 22, fill: theme.textDim } });
    g.anchor.set(0.5);
    themeBtn.addChild(g);
  };
  paintThemeBtn();
  placeThemeBtn();

  // Repaint the whole scene when the theme changes (OS change or manual toggle).
  function applyTheme(): void {
    pixi.renderer.background.color = theme.bg;
    hint.style.fill = theme.textDim;
    exprText.style.fill = theme.text;
    nextHint.style.fill = theme.textDim;
    ghostLabel.style.fill = theme.text;
    paintLegend(legend);
    paintThemeBtn();
    paintRail();
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
    placeThemeBtn();
    placeRail();
    toast.layout();
    placeExpr();
    zoo.layout();
    challenges.layout();
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

  // Toggle the layout for every tree (and trees spawned afterward).
  function toggleLayout(): void {
    layoutFn = layoutFn === layoutTopDown ? layoutRadial : layoutTopDown;
    for (const t of trees) t.setLayout(layoutFn);
  }

  // Toggle the "expand everything to ι" view (read by TreeView.expand).
  function toggleExpand(): void {
    expandAll = !expandAll;
    for (const t of trees) t.refresh();
    paintRail();
  }

  // ---- left rail: open the Zoo (Pokédex) + canvas actions. Touch-friendly
  // equivalents of the T / R / U keys; each draws a small glyph + a label. ----
  const drawDex = (g: Graphics, c: number): void => {
    g.circle(0, -3, 10).stroke({ width: 2.5, color: c }); // scanner lens ring
    g.circle(0, -3, 4).fill({ color: c }); // lens centre
    g.circle(9, -12, 2).fill({ color: c }); // LED
    g.circle(13.5, -12, 1.5).fill({ color: theme.textDim }); // LED
    g.roundRect(-9, 9, 18, 4, 1.5).stroke({ width: 1.5, color: c }); // screen strip
  };
  const drawLayout = (g: Graphics, c: number): void => {
    const ends: [number, number][] = [[-10, 8], [10, 8], [0, -11]];
    for (const [x, y] of ends) g.moveTo(0, 0).lineTo(x, y);
    g.stroke({ width: 2, color: c });
    g.circle(0, 0, 3.5).fill({ color: c });
    for (const [x, y] of ends) g.circle(x, y, 3).fill({ color: c });
  };
  const drawClear = (g: Graphics, c: number): void => {
    g.roundRect(-4, -12, 8, 3, 1).stroke({ width: 2, color: c }); // handle
    g.moveTo(-10, -7).lineTo(10, -7).stroke({ width: 2.5, color: c }); // lid
    g.moveTo(-8, -5).lineTo(-6, 12).lineTo(6, 12).lineTo(8, -5).stroke({ width: 2, color: c }); // body
    g.moveTo(-3, -2).lineTo(-2, 9).moveTo(3, -2).lineTo(2, 9).stroke({ width: 1.5, color: c }); // ribs
  };
  const drawUnlock = (g: Graphics, c: number): void => {
    g.roundRect(-8, 0, 16, 13, 2.5).stroke({ width: 2, color: c }); // body
    g.circle(0, 6, 1.8).fill({ color: c }); // keyhole
    g.arc(-4, -2, 6, Math.PI * 0.5, Math.PI * 1.6).stroke({ width: 2, color: c }); // open shackle
  };
  const drawExpand = (g: Graphics, c: number): void => {
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
      g.moveTo(sx * 3, sy * 3).lineTo(sx * 11, sy * 11); // shaft to corner
      g.moveTo(sx * 11, sy * 11).lineTo(sx * 4, sy * 11).moveTo(sx * 11, sy * 11).lineTo(sx * 11, sy * 4); // arrowhead
    }
    g.stroke({ width: 2, color: c });
  };
  const drawRefold = (g: Graphics, c: number): void => {
    g.moveTo(-9, -11).lineTo(0, -1).moveTo(9, -11).lineTo(0, -1); // two strands fold in
    g.moveTo(0, -1).lineTo(0, 11); // into one stem
    g.stroke({ width: 2, color: c });
    g.moveTo(0, 12).lineTo(-3.5, 7).moveTo(0, 12).lineTo(3.5, 7).stroke({ width: 2, color: c }); // arrowhead
    g.circle(0, -1, 2.5).fill({ color: c }); // join
  };
  const drawType = (g: Graphics, c: number): void => {
    g.circle(-9, 0, 2.5).fill({ color: c }); // a value …
    g.moveTo(-5, 0).lineTo(9, 0).stroke({ width: 2, color: c }); // … through a function arrow (a → b)
    g.moveTo(9, 0).lineTo(4, -5).moveTo(9, 0).lineTo(4, 5).stroke({ width: 2, color: c }); // arrowhead
  };
  // Transport icon reflects the current mode: play ▶ / pause ‖ / fast-forward ⏩.
  const drawTransport = (g: Graphics, c: number): void => {
    if (transport === "pause") {
      g.roundRect(-7, -9, 5, 18, 1.5).fill({ color: c });
      g.roundRect(2, -9, 5, 18, 1.5).fill({ color: c });
    } else if (transport === "ff") {
      g.moveTo(-11, -9).lineTo(-1, 0).lineTo(-11, 9).fill({ color: c });
      g.moveTo(0, -9).lineTo(10, 0).lineTo(0, 9).fill({ color: c });
    } else {
      g.moveTo(-6, -10).lineTo(9, 0).lineTo(-6, 10).fill({ color: c });
    }
  };
  // A lightning bolt — "optimize" mode (reduce named combinators by their rule).
  const drawOptimize = (g: Graphics, c: number): void => {
    g.poly([3, -12, -7, 2, -1, 2, -4, 12, 8, -3, 2, -3]).fill({ color: c });
  };
  // A pennant on a pole — the golf challenges / leaderboard.
  const drawGolf = (g: Graphics, c: number): void => {
    g.moveTo(-7, -12).lineTo(-7, 12).stroke({ width: 2, color: c }); // pole
    g.moveTo(-7, -12).lineTo(8, -7).lineTo(-7, -2).fill({ color: c }); // flag
    g.circle(-7, 12, 2).fill({ color: c }); // ball at the base
  };
  // A musical note — the sonification toggle.
  const drawSound = (g: Graphics, c: number): void => {
    g.moveTo(-1, -12).lineTo(-1, 8).stroke({ width: 2, color: c }); // stem
    g.moveTo(-1, -12).lineTo(9, -9).lineTo(9, -4).lineTo(-1, -7).fill({ color: c }); // flag
    g.circle(-5, 8, 4).fill({ color: c }); // note head
  };
  // Three linked nodes — the share action.
  const drawShare = (g: Graphics, c: number): void => {
    g.moveTo(8, -8).lineTo(-7, 0).moveTo(8, 8).lineTo(-7, 0).stroke({ width: 1.8, color: c }); // links
    g.circle(8, -8, 3.5).fill({ color: c });
    g.circle(8, 8, 3.5).fill({ color: c });
    g.circle(-7, 0, 3.5).fill({ color: c });
  };
  // "Define" — a subtree collapsing into a single labelled block (a filled tag).
  const drawDefine = (g: Graphics, c: number): void => {
    g.moveTo(-9, -10).lineTo(0, -2).moveTo(9, -10).lineTo(0, -2).stroke({ width: 2, color: c }); // two branches fold in
    g.roundRect(-7, 1, 14, 11, 3).fill({ color: c }); // into a named tag
  };
  // "Abstract" — pull a hole (○) out of a tree as a free variable (λ-style).
  const drawAbstract = (g: Graphics, c: number): void => {
    g.moveTo(-7, -11).lineTo(4, 11).moveTo(7, -11).lineTo(-1, 5).stroke({ width: 2, color: c }); // a lambda
    g.circle(8, 8, 3.5).stroke({ width: 2, color: c }); // the hole
  };
  type RailDef = { label: string | (() => string); draw: (g: Graphics, c: number) => void; brand?: boolean; count?: boolean; active?: () => boolean; act: () => void };
  const RAIL: RailDef[] = [
    { label: "Dex", draw: drawDex, brand: true, count: true, act: () => zoo.toggle() },
    { label: "layout", draw: drawLayout, act: () => toggleLayout() },
    { label: () => transport, draw: drawTransport, active: () => transport !== "play", act: () => cycleTransport() },
    { label: "expand", draw: drawExpand, active: () => expandAll, act: () => toggleExpand() },
    { label: "refold", draw: drawRefold, active: () => refoldOn, act: () => toggleRefold() },
    { label: "type", draw: drawType, active: () => typeOn, act: () => toggleType() },
    { label: "optimize", draw: drawOptimize, active: () => fastMode, act: () => { fastMode = !fastMode; paintRail(); } },
    { label: "golf", draw: drawGolf, brand: true, active: () => challenges.isOpen, act: () => challenges.toggle() },
    { label: "sound", draw: drawSound, active: () => sound.enabled, act: () => { sound.toggle(); paintRail(); } },
    { label: "share", draw: drawShare, act: () => shareFocused() },
    { label: "define", draw: drawDefine, active: () => authorMode === "define", act: () => setAuthorMode("define") },
    { label: "abstract", draw: drawAbstract, active: () => authorMode === "abstract", act: () => setAuthorMode("abstract") },
    { label: "clear", draw: drawClear, act: () => clearCanvas() },
    { label: "unlock", draw: drawUnlock, act: () => unlockAll() },
  ];
  const railButtons = RAIL.map((def) => {
    const c = new Container();
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new Rectangle(-26, -24, 52, 62);
    c.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      def.act();
    });
    rail.addChild(c);
    return { def, c };
  });
  function paintRail(): void {
    for (const { def, c } of railButtons) {
      for (const ch of c.removeChildren()) ch.destroy({ children: true });
      const on = def.active?.() ?? false; // a toggle button in its "on" state
      const accent = on || def.brand ? theme.iota : theme.accent;
      const border = on || def.brand ? theme.iota : theme.border;
      const bg = new Graphics().roundRect(-22, -22, 44, 44, 9).fill({ color: on ? theme.select : theme.panel }).stroke({ width: on ? 2 : 1.5, color: border });
      const icon = new Graphics();
      def.draw(icon, accent);
      const labelText = typeof def.label === "function" ? def.label() : def.label;
      const label = new Text({ text: labelText, style: { fontFamily: "monospace", fontSize: 11, fill: on ? theme.iota : theme.textDim } });
      label.anchor.set(0.5, 0);
      label.position.set(0, 24);
      c.addChild(bg, icon, label);
      if (def.count) {
        const found = CATALOG.filter((l) => isDiscovered(l.sym)).length;
        const cnt = new Text({ text: `${found}/${CATALOG.length}`, style: { fontFamily: "monospace", fontSize: 10, fill: theme.textDim } });
        cnt.anchor.set(0.5, 0);
        cnt.position.set(0, 37);
        c.addChild(cnt);
      }
    }
  }
  function placeRail(): void {
    const step = 72;
    const top = window.innerHeight / 2 - ((railButtons.length - 1) * step) / 2;
    railButtons.forEach(({ c }, i) => c.position.set(38, top + i * step));
  }
  paintRail();
  placeRail();

  // ---- permalinks (ADR 0005): a tree + active modes <-> a URL-safe token. ----
  const MAX_HASH = 1800; // beyond this, share a downloadable .json instead of a link

  /** The currently-active display modes, packed for a permalink. */
  const currentModes = (): Modes => ({
    optimize: fastMode || undefined,
    refold: refoldOn || undefined,
    type: typeOn || undefined,
    expand: expandAll || undefined,
    page: hotbar.page,
    transport,
  });

  /** Restore a tree's accompanying display modes (the inverse of currentModes). */
  function applyModes(m: Modes): void {
    expandAll = !!m.expand;
    fastMode = !!m.optimize;
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
    g.moveTo(0, 0).lineTo(26, 0).stroke({ width: 3, color: theme.fnEdge });
    g.moveTo(0, 18).lineTo(26, 18).stroke({ width: 2.5, color: theme.argEdge });
    c.addChild(g);
    const style = { fontFamily: "monospace", fontSize: 12, fill: theme.textDim };
    const l1 = new Text({ text: "function (left)", style });
    l1.position.set(34, -7);
    const l2 = new Text({ text: "argument (right)", style });
    l2.position.set(34, 11);
    c.addChild(l1, l2);
  }

  // Dev-only test seam (stripped from production builds): expose tree state so
  // an end-to-end driver can assert on spawn/snap/reduce.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    (globalThis as Record<string, unknown>).__combinate = {
      trees,
      sexps: () => trees.map((t) => sexp(t.node)),
      roots: () => trees.map((t) => t.rootWorld),
      discovered: () => [...discovered],
      mode: () => (layoutFn === layoutRadial ? "radial" : "topdown"),
      toggleLayout: () => toggleLayout(),
      transport: { mode: () => transport, set: (m: string) => setTransport(m as Transport), cycle: () => cycleTransport() },
      autoSteps: () => [...auto.values()].reduce((s, a) => s + a.steps, 0),
      run: () => { if (focus) scheduleAuto(focus); },
      fast: { on: () => fastMode, set: (b: boolean) => { fastMode = b; paintRail(); } },
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
      sound: { on: () => sound.enabled, toggle: () => sound.toggle() },
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
