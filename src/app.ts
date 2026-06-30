import {
  Application,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import { app as mkApp, comb, exceedsNodes, iota, type Node, type NodeId, removeSubtree, sexp } from "./core/term";
import { evalShared } from "./core/graph";
import { encodePermalink, decodePermalink, type Modes } from "./core/permalink";
import { LocalStore } from "./store/local";
import { DuckdbStore } from "./store/duckdb";
import { ChallengePanel } from "./view/challenge";
import { QuestPanel } from "./view/quest";
import { QuestTracker } from "./view/questTracker";
import { Sound } from "./view/sound";
import { CATALOG, type Law, expandDisplay } from "./core/catalog";
import { recognize } from "./core/probe";
import { layoutAuto, layoutRadial, layoutTopDown, type LayoutFn } from "./core/layout";
import { recognizeDeep, fromEgg, toEgg } from "./core/refold";
import { read, render, type Ty } from "./core/types";
import { inferType } from "./core/infer";
import { abstractLeaf, defineCombinator, findSubtree, isNameTaken, replaceSubtree, validateName } from "./core/authoring";
import { TreeView, dashedSegment } from "./view/tree";
import { Hotbar } from "./view/hotbar";
import { Toast } from "./view/toast";
import { Zoo } from "./view/zoo";
import { MhsPanel } from "./view/mhs/panel";
import { ReadoutLens } from "./view/readoutLens";
import { loadWasmReducer, wasmReady, WasmSession } from "./view/wasmReducer";
import { ReductionController, type Transport } from "./view/reduction";
import { TransportBar } from "./view/transportBar";
import { preloadCompiler } from "./view/mhs/compiler";
import { theme, initTheme, toggleMode, currentMode, colorOn, toggleColor, onThemeChange } from "./view/theme";
import { MenuBar, type Menu } from "./view/menubar";
import { About } from "./view/about";
import { withMotion } from "./view/motion";
import { OptimizePanel, isOpt, setOpt, onOptChange } from "./view/optimize";
import { type NativeOpts } from "./core/native";
import { BucketTray } from "./view/bucketTray";
import { GameInputController } from "./view/gameInput";
import { GamepadController } from "./view/gamepad";
import { Sphere3D, NODE_CAP, preloadSphere3D } from "./view/sphere3d";
import { spherePreview } from "./view/spherePreview";
import { HintBar } from "./view/hints";
import { DiscoveryCard } from "./view/discovery";
import { type Context, type Intent, intentForKey } from "./view/keymap";
import { noteKbm, notePad, onDeviceChange } from "./view/inputDevice";

const KEY_ROT = 6; // 3D orbit: px-equivalent per frame for a held rotate-key
const MOM_DECAY = 0.92; // 3D orbit: drag-release momentum decay per frame
const PAD_ORBIT = 320; // 3D orbit: px-equivalent/sec at full left-stick deflection
const PAD_PAN = 1100; // build camera pan: world-px/sec at full right-stick deflection
const PAD_PAN3D = 600; // 3D pan: px-equivalent/sec at full right-stick deflection
const PAD_ROT_STEP = 22; // 3D orbit: px-equivalent per gamepad d-pad step
const SNAP_R = 72; // world-space snap radius between two tree root anchors (~1.3·XS)
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
  const discoveryCard = new DiscoveryCard(); // DOM card on discovery (a rotating 3D mini-view) — replaces the discovery toast

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

  // The read-out lens (ADR 12): the focused tree's live top-centre expression + the
  // re-fold / type lenses. Owns the lens state, `exprOf`, and the per-frame render; the
  // shell owns the `exprText` placement/theme. Created here so `isDiscovered` exists.
  const readout = new ReadoutLens({
    ticker: pixi.ticker,
    exprText,
    focusNode: () => (focus && trees.includes(focus) ? focus.node : null),
    readPage: () => hotbar.page,
    isDiscovered,
    onToggle: () => paintRail(),
    toast,
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
    rerender3D(); // the 3D view follows the discovery mask too
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
    rerender3D(); // the 3D view follows the discovery mask too
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
    discoveryCard.show(law); // a card under the tracked quest: catalog entry + a rotating 3D mini-view
    sound.playIfReady(law.sym); // chirp the new bird (only if audio's already unlocked — discovery isn't a gesture)
    hotbar.reveal(law.sym);
    for (const t of trees) t.refresh(); // reveal newly-known combinators everywhere
    rerender3D(); // a newly-known combinator changes the 3D discovery mask too
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
    reduce.cancel(tree);
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
    reduce.cancel(tree);
    tree.animateTo(collapsedNode(law), COLLAPSE_MS, () => {});
    focus = tree;
    toast.show(`abstracted → ${name}`);
  }

  // ---- auto-reduce + transport (extracted to view/reduction.ts, ADR 12). The Pixi
  // side effects (the transport bar) stay here and are injected. ----
  const reduce = new ReductionController({
    getFast: () => fastMode,
    getShare: () => shareMode,
    getNative: () => nativeOpts(),
    getTurbo: () => isOpt("wasm"),
    makeSession: (term) => (wasmReady() ? new WasmSession(term, nativeOpts()) : null),
    focusedLive: () => (focus && trees.includes(focus) ? focus : null),
    settle: (tree) => settle(tree),
    onNormalForm: (source) => {
      void challenges.onNormalForm(source);
      quest.onNormalForm(source); // guided progression
    },
    tickSound: (sym) => sound.tick(sym),
    notify: (msg) => toast.show(msg),
    onTransportChange: () => {
      paintRail();
      transportBar.paint();
    },
  });

  // Transport bar (top-right): rate read-out + Pause/Step/Play/FF — a thin view over the
  // ReductionController (extracted to view/transportBar.ts, ADR 12).
  const transportBar = new TransportBar(hud, pixi.ticker, reduce);

  // Reduction progress bar (plan 02): a thin fill along the top edge of the hotbar box, showing how
  // far the focused tree's reduction has played vs the background same-mode total. Shown only when
  // there's an honest exact total worth a bar — hidden for instant / huge / non-terminating runs.
  const PROGRESS_MIN = 12; // skip near-instant reductions
  const progressBar = new Graphics();
  progressBar.eventMode = "none";
  hud.addChild(progressBar);
  pixi.ticker.add(() => {
    progressBar.clear();
    const est = reduce.estimate;
    if (est.kind !== "exact" || est.total < PROGRESS_MIN) return;
    const steps = reduce.focusedSteps();
    if (steps >= est.total) return; // finished → no bar
    const b = hotbar.boxRect;
    if (b.w <= 0) return;
    const frac = Math.max(0, Math.min(1, steps / est.total));
    const h = 3;
    progressBar.rect(b.x, b.y - h - 1, b.w, h).fill({ color: theme.textDim, alpha: 0.3 }); // track
    progressBar.rect(b.x, b.y - h - 1, b.w * frac, h).fill({ color: theme.iota }); // fill
  });

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
    if (withMotion()) tree.popIn(); // grab/spawn pop is always on (only reduced-motion suppresses it)
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
      // Reduce under the user's current settings (no auto-enabling optimizations — Turbo / native
      // numbers stay opt-in via the Reduce menu). Compiled programs get big, so lay out radially +
      // zoom to fit; the progress bar shows how the reduction is going.
      setLayoutMode(layoutRadial);
      const view = spawnTree(tree, window.innerWidth / 2, window.innerHeight / 2);
      if (read) hotbar.selectPage(TY_PAGE[read]);
      fitTree(view);
      reduce.schedule(view); // start it reducing under the current settings (was a side effect of the old auto-Turbo)
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
    reduce.cancel(tree); // touching a tree freezes it (§6.4)
    gameInput?.detach(tree); // grabbing a bucket tree with the mouse releases its slot (ADR 17)
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
    reduce.cancel(tree);
    const next = removeSubtree(tree.node, id);
    if (next === null) {
      removeTree(tree); // deleted the root → the whole tree goes (releases its bucket too)
    } else {
      focus = tree;
      tree.animateTo(next, DELETE_MS, () => {});
      reduce.schedule(tree); // re-reduce the edited tree once it's left alone
    }
  }

  pixi.stage.on("pointerdown", (e: FederatedPointerEvent) => {
    if (view3D) {
      if (e.pointerType === "touch") return; // touch is handled at the canvas level (1-finger pan / 2-finger orbit)
      if (e.button === 0) panDrag = { x: e.global.x, y: e.global.y }; // 3D: left-drag pans
      else if (e.button === 2) orbitDrag = { x: e.global.x, y: e.global.y }; // 3D: right-drag orbits
      return;
    }
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
    if (view3D) {
      if (panDrag) {
        sphere3d.pan(e.global.x - panDrag.x, e.global.y - panDrag.y);
        panDrag = { x: e.global.x, y: e.global.y };
      } else if (orbitDrag) {
        const dx = e.global.x - orbitDrag.x;
        const dy = e.global.y - orbitDrag.y;
        sphere3d.orbit(dx, dy);
        lastDragD = { x: dx, y: dy }; // remember the flick for release momentum
        orbitDrag = { x: e.global.x, y: e.global.y };
      }
      return;
    }
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
    if (orbitDrag) {
      momVx = lastDragD.x; // a flick imparts spin momentum (decays on the ticker)
      momVy = lastDragD.y;
      lastDragD = { x: 0, y: 0 };
    }
    orbitDrag = null; // end a 3D orbit drag
    panDrag = null; // end a 3D pan drag
    if (!drag) return;
    if (drag.kind === "tree" || drag.kind === "spawn") {
      const tree = drag.tree;
      if (snapTarget) {
        commitSnap(tree, snapTarget);
      } else {
        reduce.schedule(tree); // released untouched → it begins reducing
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
    ghostLabel.text = `(${readout.exprOf(left.node)} ${readout.exprOf(right.node)})`;
    ghostLabel.position.set(ax, ay - 12);
    ghostLabel.visible = true;
  }

  function clearGhost(): void {
    ghostLabel.visible = false;
    ghost.clear();
    snapTarget = null;
  }

  // Forget + remove + destroy a tree (and release any bucket it filled, so game-mode slot
  // state stays in sync — the one mouse/controller desync rule, ADR 17).
  function removeTree(tree: TreeView): void {
    reduce.forget(tree);
    const i = trees.indexOf(tree);
    if (i >= 0) trees.splice(i, 1);
    tree.destroy();
    gameInput?.detach(tree);
    if (focus === tree) focus = null;
  }

  /** Build `app(fn, arg)` at a world anchor and start it reducing — the non-spatial apply
   *  shared by mouse-snap and the game controller (X/Y choose direction, ADR 17). `fromWorld`
   *  (the consumed trees' node positions) glides the merge; without it the result pops in. */
  function applyTerms(fnNode: Node, argNode: Node, anchor: { x: number; y: number }, fromWorld?: Map<NodeId, { x: number; y: number }>): TreeView {
    const merged = new TreeView(mkApp(fnNode, argNode), anchor.x, anchor.y, pixi.ticker, isDiscovered, layoutFn, () => expandAll, cameraTransform);
    addTree(merged);
    focus = merged;
    if (fromWorld) merged.animateAttachFrom(fromWorld, ATTACH_MS); // smooth merge into the app tree
    else if (withMotion()) merged.popIn();
    reduce.schedule(merged); // then it reduces on its own
    return merged;
  }

  /** Spawn a reducing tree at a world anchor (the game controller places buckets here). */
  function spawnTreeWorld(node: Node, wx: number, wy: number): TreeView {
    const tree = new TreeView(node, wx, wy, pixi.ticker, isDiscovered, layoutFn, () => expandAll, cameraTransform);
    addTree(tree);
    focus = tree;
    if (withMotion()) tree.popIn();
    reduce.schedule(tree);
    return tree;
  }

  // Snap = application. Horizontal order of the two roots decides fn (left) vs arg (§6.2).
  function commitSnap(dragged: TreeView, target: TreeView): void {
    const fn = dragged.rootWorld.x <= target.rootWorld.x ? dragged : target;
    const arg = fn === dragged ? target : dragged;
    const ax = (dragged.rootWorld.x + target.rootWorld.x) / 2;
    const ay = Math.min(dragged.rootWorld.y, target.rootWorld.y) - 32;
    // capture where every subtree node currently sits, to glide them in (§6.2)
    const fromWorld = new Map<NodeId, { x: number; y: number }>();
    for (const t of [dragged, target]) {
      for (const [id, p] of t.nodeWorldPositions()) fromWorld.set(id, p);
    }
    const fnNode = fn.node;
    const argNode = arg.node;
    for (const old of [dragged, target]) removeTree(old);
    applyTerms(fnNode, argNode, { x: ax, y: ay }, fromWorld);
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
      noteKbm(); // wheel is a mouse action → keyboard hint glyphs
      if (zoo.isOpen || challenges.isOpen) return; // an open overlay owns the wheel (its list scrolls instead of zooming the canvas behind it)
      if (view3D) return sphere3d.zoomBy(ev.deltaY < 0 ? 0.9 : 1 / 0.9); // 3D: wheel orbits-zoom
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
    noteKbm(); // mouse/touch on the canvas → keyboard hint glyphs (last-input-wins)
    if (view3D && ev.pointerType !== "touch") return; // 3D MOUSE is handled on the stage (left-pan / right-orbit) — don't double-handle
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (view3D) {
      if (pointers.size === 2) pinch = pinchMetrics(); // 3D: two fingers orbit + pinch-zoom
      return; // 3D: one finger pans (handled in move)
    }
    if (pointers.size === 2) {
      clearGhost();
      drag = null; // hand control to the pinch
      pinch = pinchMetrics();
    }
  });
  pixi.canvas.addEventListener("pointermove", (ev) => {
    if (view3D && ev.pointerType !== "touch") return; // 3D MOUSE handled on the stage
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    const px = p.x; // previous position, before this move
    const py = p.y;
    p.x = ev.clientX;
    p.y = ev.clientY;
    if (view3D) {
      if (pointers.size === 1) {
        sphere3d.pan(ev.clientX - px, ev.clientY - py); // one finger pans the look-at
      } else if (pointers.size >= 2 && pinch) {
        const cur = pinchMetrics();
        sphere3d.orbit(cur.cx - pinch.cx, cur.cy - pinch.cy); // two-finger centroid drag → orbit
        if (cur.d !== pinch.d) sphere3d.zoomBy(pinch.d / cur.d); // spread/pinch → zoom
        pinch = cur;
      }
      return;
    }
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
    // (the transport bar self-subscribes to theme changes)
    hotbar.refresh();
    zoo.applyTheme();
    challenges.applyTheme();
    for (const t of trees) t.refresh();
    sphere3d.retheme(); // no-op when the 3D view is closed
  }
  onThemeChange(applyTheme);

  window.addEventListener("resize", () => {
    fitStage();
    hotbar.layout();
    placeLegend();
    transportBar.place();
    placeFps();
    toast.layout();
    placeExpr();
    zoo.layout();
    challenges.layout();
    tray.layout();
    hintBar.place(window.innerWidth, window.innerHeight);
    if (view3D) {
      sphere3d.resize(window.innerWidth, window.innerHeight);
      fitSphereSprite();
    }
  });

  // Render efficiency: stop the render/animation loop while the tab is hidden —
  // no point rendering to an invisible canvas. (Browsers throttle rAF in the
  // background; this also idles the rate samplers.) setTimeout-driven
  // reduction keeps crawling and catches up on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pixi.ticker.stop();
    else pixi.ticker.start();
  });

  // Remove every tree from the canvas (discoveries and the hotbar stay).
  function clearCanvas(): void {
    for (const t of trees) {
      reduce.forget(t);
      t.destroy();
    }
    trees.length = 0;
    clearGhost();
    drag = null;
    focus = null;
  }

  // ---- 3D "packed sphere" view (ADR 18): a lazy Three.js render of the focused term ----
  // Compositing "A": Three renders to its own off-DOM canvas, which we draw as a Pixi texture
  // sprite in `sphereLayer` between `world` and `hud`, so the Pixi HUD composites on top. The
  // per-render canvas→texture re-upload is measured-negligible (~0.6ms, render-on-demand). (A
  // zero-copy stacked-transparent-canvas path was investigated + rejected — Pixi v8's MSAA back-
  // buffer resolve won't emit transparent pixels reliably; and a shared GL context inverts the
  // Pixi-first app. See ADR 18.)
  const sphere3d = new Sphere3D();
  const sphereLayer = new Container();
  sphereLayer.visible = false;
  sphereLayer.eventMode = "none"; // orbit input is read off the stage; the sprite never intercepts
  pixi.stage.addChildAt(sphereLayer, pixi.stage.getChildIndex(hud)); // just below the HUD
  let sphereTex = Texture.from(sphere3d.canvas);
  const sphereSprite = new Sprite(sphereTex);
  sphereLayer.addChild(sphereSprite);
  sphere3d.onFrame = () => sphereTex.source.update(); // re-upload the canvas after each 3D render
  // Match the sprite to the (resized) off-DOM canvas; re-bind the texture if the canvas grew.
  function fitSphereSprite(): void {
    if (sphereTex.source.resource !== sphere3d.canvas || sphereTex.source.pixelWidth !== sphere3d.canvas.width) {
      sphereTex.destroy();
      sphereTex = Texture.from(sphere3d.canvas);
      sphereSprite.texture = sphereTex;
      sphere3d.onFrame = () => sphereTex.source.update();
    }
    sphereSprite.setSize(window.innerWidth, window.innerHeight);
    sphereTex.source.update();
  }
  let orbitDrag: { x: number; y: number } | null = null; // right-drag (mouse) — 3D orbit
  let panDrag: { x: number; y: number } | null = null; // left-drag (mouse) — 3D pan
  // 3D rotation: held rotate-keys + drag-release momentum, applied each frame by the ticker so
  // the orbit is smooth/continuous (not one step per pointer event).
  const heldRot = new Set<string>();
  let momVx = 0;
  let momVy = 0;
  let lastDragD = { x: 0, y: 0 };
  pixi.ticker.add(() => {
    if (!view3D) return;
    let vx = 0;
    let vy = 0;
    if (heldRot.has("arrowleft") || heldRot.has("a")) vx -= KEY_ROT;
    if (heldRot.has("arrowright") || heldRot.has("d")) vx += KEY_ROT;
    if (heldRot.has("arrowup") || heldRot.has("w")) vy -= KEY_ROT;
    if (heldRot.has("arrowdown") || heldRot.has("s")) vy += KEY_ROT;
    vx += momVx;
    vy += momVy;
    if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) sphere3d.orbit(vx, vy);
    momVx = Math.abs(momVx) < 0.05 ? 0 : momVx * MOM_DECAY;
    momVy = Math.abs(momVy) < 0.05 ? 0 : momVy * MOM_DECAY;
  });
  // Drive the pooled Zoo preview's spin from Pixi's ticker (not its own rAF) so the Three-canvas
  // mutation and the Pixi texture upload share a frame — a private rAF left the texture stale.
  pixi.ticker.add((tk: { deltaMS: number }) => spherePreview.tick(tk.deltaMS));
  let view3D = false;
  // The term the 3D view renders: the same EXPANDED display the 2D tree shows (undiscovered S/K/I
  // as ι-trees, and every combinator when "Expand ι-trees" is on), so 3D follows that setting.
  const display3D = (): Node | null => (focus ? expandDisplay(focus.node, { expandAll, isDiscovered }) : null);
  // Re-render the open 3D view after a setting changes the displayed term (Expand toggle, a
  // discovery). Keeps the camera; the term may have grown/shrunk but re-framing here is jarring.
  // If the new display blows past the node cap (e.g. Expand on a big tree), back out to 2D.
  function rerender3D(): void {
    if (!view3D) return;
    const disp = display3D();
    if (disp && exceedsNodes(disp, NODE_CAP)) {
      toggleView3D(); // exits 3D
      return toast.show(`tree too large for 3D (over ${NODE_CAP} nodes)`);
    }
    sphere3d.update(disp, true);
  }
  function toggleView3D(): void {
    if (view3D) {
      view3D = false;
      sphereLayer.visible = false;
      world.visible = true;
      sphere3d.hide();
      heldRot.clear(); // drop any still-held rotate-keys so they don't resume on re-entry
      pinch = null; // a 2-finger 3D gesture exited mid-flight mustn't bleed into the 2D pinch
      updateHints();
      paintRail();
      return;
    }
    // Entering: preflight (iterative exceedsNodes — deep-tree-safe) so a too-big / unfocused tree
    // never enters 3D, and the message shows on the visible 2D HUD. Checks the EXPANDED display.
    const disp = display3D();
    if (!disp) return toast.show("focus a tree to view it in 3D");
    if (exceedsNodes(disp, NODE_CAP)) return toast.show(`tree too large for 3D (over ${NODE_CAP} nodes)`);
    if (gameMode) setGameMode(false); // contexts are mutually exclusive
    view3D = true;
    world.visible = false;
    sphereLayer.visible = true;
    updateHints();
    paintRail();
    void sphere3d
      .show(disp, window.innerWidth, window.innerHeight)
      .then(() => fitSphereSprite())
      .catch((e: unknown) => {
        view3D = false; // Three failed to load / no WebGL — back out visibly
        sphereLayer.visible = false;
        world.visible = true;
        sphere3d.hide();
        updateHints();
        paintRail();
        toast.show("3D view unavailable — WebGL not supported here");
        console.warn("sphere3d:", e);
      });
  }

  // Set the layout for every tree (and trees spawned afterward). Picking a 2D layout leaves 3D.
  const setLayoutMode = (fn: LayoutFn): void => {
    if (view3D) toggleView3D(); // a 2D layout choice exits the 3D view
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

  // Game mode's spatial buckets (ADR 17): a stable horizontal strip BUCKET_SPACING apart, keyed by k.
  const BUCKET_SPACING = 640;
  // Centre the camera on a bucket's world x at a fixed "region" zoom so the neighbours (±spacing)
  // peek faded at the screen edges — the faded-neighbour spatial cue. Anchors sit at world y=0; we
  // drop the focus a little above centre so the tree has room to grow downward over the hotbar.
  function frameBucketAt(x: number): void {
    const z = Math.min(1.3, window.innerWidth / (BUCKET_SPACING * 2.3));
    world.scale.set(z);
    world.position.set(window.innerWidth / 2 - x * z, window.innerHeight * 0.44);
  }

  // Toggle the "expand everything to ι" view (read by TreeView.expand).
  function toggleExpand(): void {
    expandAll = !expandAll;
    for (const t of trees) t.refresh();
    rerender3D(); // the 3D view follows the Expand setting too
    paintRail();
  }

  // ---- top menu bar (System 1 Macintosh): the old left rail folded into
  // pull-downs. Reuses the action callbacks below; a ✓ marks an active toggle,
  // a • the selected option in a group. paintRail() (kept for its many callers)
  // now just refreshes the open pull-down's checkmarks. ----
  const about = new About();
  const optimize = new OptimizePanel();

  // ---- game mode (ADR 17): keyboard/controller play via a bucket tray + hand ----
  let gameMode = false;
  const tray = new BucketTray();
  hud.addChild(tray.container);
  const hintBar = new HintBar();
  hud.addChild(hintBar.container);
  hintBar.place(window.innerWidth, window.innerHeight);
  // The active interaction context: Inspect (3D) and Build (the tray) own the discrete input; the
  // free canvas is mouse/touch + the desktop shortcuts. The two are mutually exclusive.
  function currentContext(): "free" | Context {
    return view3D ? "inspect" : gameMode ? "build" : "free";
  }
  function updateHints(): void {
    const c = currentContext();
    hintBar.setContext(c === "free" ? null : c);
  }
  onDeviceChange(() => hintBar.refresh()); // last-input-wins → swap keyboard/pad glyphs
  const labelFor = (node: Node): string => {
    const s = readout.exprOf(node);
    return s.length > 14 ? s.slice(0, 13) + "…" : s;
  };
  const gameInput = new GameInputController({
    hotbar,
    tray,
    freshNode: spawnFor,
    labelOf: labelFor,
    bucketAnchor: (k) => ({ x: k * BUCKET_SPACING, y: 0 }), // an unbounded strip of world anchors
    spawnAt: (node, w) => spawnTreeWorld(node, w.x, w.y),
    applyTerms: (fn, arg, w, from) => applyTerms(fn, arg, w, from),
    captureWorld: (tree) => tree.nodeWorldPositions(),
    removeTree,
    frameBucketAt: (x) => frameBucketAt(x),
    pan: (dx, dy) => world.position.set(world.position.x + dx, world.position.y + dy),
    zoom: (factor) => zoomTo(world.scale.x * factor, window.innerWidth / 2, window.innerHeight / 2),
    setSpeed: (lvl) => reduce.setSpeedLevel(lvl),
    getSpeedLevel: () => reduce.speedLevel,
    openMenu: () => menuBar?.openMenuBar(),
    toast: (m) => toast.show(m),
  });
  // Gamepad: a third input producer (polled from the ticker), routed by the active context.
  new GamepadController(pixi.ticker, {
    // Always poll: a pad must be detectable in the free canvas too, so Start can enter Build and
    // Y can enter 3D (the free context maps to the Build button-map, which carries the globals).
    enabled: () => true,
    context: () => (view3D ? "inspect" : "build"),
    dispatch: (i) => dispatchPadIntent(i),
    leftStick: (sx, sy, dt) => {
      if (view3D) sphere3d.orbit(sx * PAD_ORBIT * dt, sy * PAD_ORBIT * dt); // inspect: orbit
    },
    rightStick: (sx, sy, dt) => {
      if (gameMode) gameInput.panBy(-sx * PAD_PAN * dt, -sy * PAD_PAN * dt); // build: pan the camera
      else if (view3D) sphere3d.pan(sx * PAD_PAN3D * dt, sy * PAD_PAN3D * dt); // inspect: pan the look-at
    },
    zoomBy: (f) => (view3D ? sphere3d.zoomBy(f) : gameInput.zoomBy(f)),
    note: () => notePad(),
    toast: (m) => toast.show(m),
  });
  // A pad unplugging must drop the pad hint glyphs immediately (don't strand them on screen) —
  // fall back to keyboard until the next real input. The hint bar refreshes via onDeviceChange.
  window.addEventListener("gamepaddisconnected", () => noteKbm());
  // A pad's discrete intent, routed by the active context (Build → the tray controller; Inspect →
  // the 3D camera; the global toggles either way). The keyboard routes the same intents below.
  function dispatchPadIntent(intent: Intent): void {
    switch (intent) {
      case "toggleBuild":
        return setGameMode(!gameMode);
      case "enterInspect":
      case "exitInspect":
        return void toggleView3D();
      case "recenter":
        return sphere3d.recenter();
      case "rotLeft":
        return sphere3d.orbit(-PAD_ROT_STEP, 0);
      case "rotRight":
        return sphere3d.orbit(PAD_ROT_STEP, 0);
      case "rotUp":
        return sphere3d.orbit(0, -PAD_ROT_STEP);
      case "rotDown":
        return sphere3d.orbit(0, PAD_ROT_STEP);
      case "speed":
        return gameInput.cycleSpeed();
      default:
        return gameInput.trigger(intent); // build discrete intents (move/page/pick/apply/cancel)
    }
  }
  function setGameMode(on: boolean): void {
    if (on && view3D) toggleView3D(); // contexts are mutually exclusive
    gameMode = on;
    gameInput.setEnabled(on);
    if (on) toast.show("game mode — ←/→ move between buckets (past the end = a fresh one) · Space hold/place · Q/E apply · V for 3D · Tab exits");
    updateHints();
    paintRail();
  }
  // The optimize store is the source of truth; mirror it into the reducer flags and do
  // the per-mode invalidation (carry the changed key so we invalidate only what changed).
  onOptChange((key) => {
    if (key === "rules") {
      fastMode = isOpt("rules");
      reduce.invalidateGraphers(); // graphers bake `fast` at construction
      if (focus) reduce.schedule(focus); // reschedule → reset the step count + re-estimate in the new mode (consistent bar)
    } else if (key === "graph") {
      shareMode = isOpt("graph");
      if (focus) reduce.schedule(focus);
    } else if (key === "wasm") {
      // Turbo toggled: preload the wasm (so the next reduction can use it), drop any stale
      // sessions, and re-decide turbo-vs-TS for the focused tree.
      if (isOpt("wasm")) {
        const armed = focus; // re-check on resolve: Turbo still on AND the same tree still focused
        void loadWasmReducer().then(() => {
          if (isOpt("wasm") && armed && focus === armed && trees.includes(armed)) reduce.schedule(armed);
        });
      }
      reduce.invalidateSessions();
      if (focus) reduce.schedule(focus);
    } else if (key === "nativeNumbers" || key === "nativeLists" || key === "nativeBooleans") {
      // A wasm session bakes the native opts at creation (number kernels / turbo eligibility),
      // so a native-toggle change needs a fresh session.
      reduce.invalidateSessions();
      if (focus) reduce.schedule(focus);
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
      { kind: "toggle", label: "Sphere (3D) ✦", checked: () => view3D, run: () => toggleView3D() },
      { kind: "sep" },
      { kind: "toggle", label: "Expand ι-trees", accel: "X", checked: () => expandAll, run: () => toggleExpand() },
      { kind: "toggle", label: "Type lens", checked: () => readout.isTypeOn, run: () => readout.toggleType() },
      { kind: "toggle", label: "Re-fold lens", accel: "F", checked: () => readout.isRefoldOn, run: () => readout.toggleRefold() },
      { kind: "sep" },
      { kind: "toggle", label: "Dark mode", checked: () => currentMode() === "dark", run: () => toggleMode() },
      { kind: "toggle", label: "Color (4096)", checked: () => colorOn(), run: () => toggleColor() },
      { kind: "sep" },
      { kind: "toggle", label: "FPS counter", checked: () => fpsOn, run: () => toggleFps() },
    ] },
    { title: "Reduce", items: [
      { kind: "radio", label: "Pause", on: () => reduce.mode === "pause", run: () => reduce.setTransport("pause") },
      { kind: "radio", label: "Play", on: () => reduce.mode === "play", run: () => reduce.setTransport("play") },
      { kind: "radio", label: "Fast-forward", on: () => reduce.mode === "ff", run: () => reduce.setTransport("ff") },
      { kind: "action", label: "Step", run: () => reduce.stepOnce() },
      { kind: "sep" },
      { kind: "action", label: "Optimizations…", run: () => optimize.open() },
      { kind: "sep" },
      { kind: "toggle", label: "Sound", checked: () => sound.enabled, run: () => sound.toggle() },
    ] },
    { title: "Special", items: [
      { kind: "toggle", label: "Game mode", checked: () => gameMode, run: () => setGameMode(!gameMode) },
      { kind: "sep" },
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
    refold: readout.isRefoldOn || undefined,
    type: readout.isTypeOn || undefined,
    expand: expandAll || undefined,
    page: hotbar.page,
    transport: reduce.mode,
  });

  /** Restore a tree's accompanying display modes (the inverse of currentModes). */
  function applyModes(m: Modes): void {
    expandAll = !!m.expand;
    setOpt("rules", !!m.optimize, false); // permalink modes are tree-local — drive the reducer, don't persist as a preference
    setOpt("graph", !!m.graph, false);
    readout.applyModes(m);
    if (m.page) hotbar.selectPage(m.page);
    if (m.transport) reduce.setTransport(m.transport);
    readout.invalidate(); // force a read-out recompute
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
      reduce.schedule(t);
      hint.visible = false;
      toast.show("restored from link");
    }
  }

  // The keyboard's discrete intents, routed per context (the gamepad routes the same via
  // dispatchPadIntent). Inspect holds rotate-keys for the orbit ticker; Build defers to the tray.
  function dispatchInspectKey(intent: Intent, k: string): void {
    switch (intent) {
      case "rotLeft":
      case "rotRight":
      case "rotUp":
      case "rotDown":
        heldRot.add(k); // the orbit ticker reads heldRot for continuous rotation
        return;
      case "zoomIn":
        return sphere3d.zoomBy(0.9);
      case "zoomOut":
        return sphere3d.zoomBy(1 / 0.9);
      case "recenter":
        return sphere3d.recenter();
      case "exitInspect":
        return void toggleView3D();
      case "toggleBuild":
        return setGameMode(true); // Tab from 3D → Build (mutual exclusion exits 3D)
    }
  }
  function dispatchBuildKey(intent: Intent, key: string): void {
    if (intent === "enterInspect") return void toggleView3D();
    if (intent === "toggleBuild") return setGameMode(false);
    if (intent === "speed") return reduce.setSpeedLevel(parseInt(key, 10));
    gameInput.trigger(intent);
  }

  window.addEventListener("keydown", (e) => {
    if (zoo.isOpen) {
      if (e.key === "ArrowDown") return e.preventDefault(), zoo.move(1);
      if (e.key === "ArrowUp") return e.preventDefault(), zoo.move(-1);
      if (e.key === "ArrowRight") return e.preventDefault(), zoo.cyclePage(1);
      if (e.key === "ArrowLeft") return e.preventDefault(), zoo.cyclePage(-1);
      if (e.key === "Escape") return zoo.close();
    }
    // A context OWNS the keyboard (ADR 17): in Build / Inspect the bound keys act and every other
    // desktop letter-shortcut below is suspended (so e.g. `r` can't wipe the canvas mid-play) — the
    // menu bar (Esc / mouse) still reaches them. Never while an overlay or text field is up, and
    // modifier combos (Ctrl/Cmd/Alt — browser shortcuts like Ctrl-R) always pass through.
    const typing = (el: Element | null): boolean => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
    const overlayUp = (): boolean => zoo.isOpen || challenges.isOpen || [...document.querySelectorAll<HTMLElement>(".md-root")].some((el) => el.style.display === "flex");
    const blocked = e.ctrlKey || e.metaKey || e.altKey || overlayUp() || typing(document.activeElement);
    if (blocked) return; // typing / an overlay / a modifier combo → leave it to the browser + modals
    noteKbm(); // keyboard activity → keyboard hint glyphs (last-input-wins)
    const ctx = currentContext();
    // INSPECT (3D) owns the keyboard: rotate (held) / zoom / recenter / exit.
    if (ctx === "inspect") {
      const intent = intentForKey("inspect", e.key);
      if (intent) {
        dispatchInspectKey(intent, e.key.toLowerCase());
        e.preventDefault();
      }
      return;
    }
    // BUILD owns the keyboard: tray nav / pick / apply / cancel / speed / enter-3D / exit.
    if (ctx === "build") {
      const intent = intentForKey("build", e.key);
      if (intent) {
        dispatchBuildKey(intent, e.key);
        e.preventDefault();
      }
      return;
    }
    // FREE: the global enter-keys (Tab → Build, V → 3D), then the desktop shortcuts below.
    const g = intentForKey("build", e.key); // the build map carries the global Tab + the V enter
    if (g === "toggleBuild") return setGameMode(true), e.preventDefault();
    if (g === "enterInspect") return toggleView3D(), e.preventDefault();
    if (e.key === "r" || e.key === "R") clearCanvas();
    else if (e.key === "t" || e.key === "T") toggleLayout();
    else if (e.key === "u" || e.key === "U") unlockAll();
    else if (e.key === "x" || e.key === "X") toggleExpand();
    else if (e.key === "f" || e.key === "F") readout.toggleRefold();
    else if (e.key === "z" || e.key === "Z") zoo.toggle();
    else if (e.key === "g" || e.key === "G") challenges.toggle();
    else if (e.key === "d" || e.key === "D") setAuthorMode("define");
    else if (e.key === "a" || e.key === "A") setAuthorMode("abstract");
  });
  window.addEventListener("keyup", (e) => heldRot.delete(e.key.toLowerCase())); // release a 3D rotate-key

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
  await readout.ensureRefolder();
  if (isOpt("wasm")) void loadWasmReducer(); // persisted Turbo → warm the wasm so the first reduction uses it
  void preloadSphere3D(); // warm the Three.js chunk so the first 3D view is instant
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
      discover: (sym: string) => { const l = CATALOG.find((x) => x.sym === sym); if (l) discover(l); }, // dev seam: fire the discovery flow (card + chirp)
      mode: () => (layoutFn === layoutAuto ? "auto" : layoutFn === layoutRadial ? "radial" : "topdown"),
      toggleLayout: () => toggleLayout(),
      view3d: { on: () => view3D, toggle: () => toggleView3D(), info: () => ({ count: sphere3d.lastCount, capped: sphere3d.lastCapped, buildMs: sphere3d.lastBuildMs, drawMs: sphere3d.lastDrawMs, az: sphere3d.azimuth, pan: sphere3d.panSum }) },
      transport: { mode: () => reduce.mode, set: (m: string) => reduce.setTransport(m as Transport), cycle: () => reduce.cycleTransport(), step: () => reduce.stepOnce() },
      autoSteps: () => reduce.totalSteps(),
      est: () => ({ ...reduce.estimate, shown: reduce.focusedSteps() }),
      run: () => { if (focus) reduce.schedule(focus); },
      game: { on: () => gameMode, set: (b: boolean) => setGameMode(b), state: () => gameInput.debugState },
      fast: { on: () => isOpt("rules"), set: (b: boolean) => setOpt("rules", b) },
      graph: { on: () => isOpt("graph"), set: (b: boolean) => setOpt("graph", b), eval: (s: string) => sexp(evalShared(fromEgg(s), 500000, fastMode).term) },
      expr: () => exprText.text,
      page: () => hotbar.page,
      setPage: (name: string) => hotbar.selectPage(name),
      type: { on: () => readout.isTypeOn, toggle: () => readout.toggleType(), of: (s: string) => inferType(fromEgg(s)) },
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
        on: () => readout.isRefoldOn,
        ready: () => readout.refolderReady,
        init: () => readout.ensureRefolder(),
        toggle: () => readout.toggleRefold(),
        raw: (s: string) => readout.rawRefold(s),
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
      // wasm turbo reducer (ADR 15): load + drive a resident session to NF, for tests.
      wasm: {
        load: async () => !!(await loadWasmReducer()),
        ready: () => wasmReady(),
        nf: async (s: string, batch = 5000): Promise<string | null> => {
          if (!(await loadWasmReducer())) return null;
          const sess = new WasmSession(fromEgg(s));
          while (!sess.isDone) if (sess.stepBudget(batch) === 0) break;
          const out = sexp(sess.snapshot());
          sess.free();
          return out;
        },
      },
    };
  }
}
