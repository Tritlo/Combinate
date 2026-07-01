import {
  Application,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Rectangle,
  Text,
} from "pixi.js";
import { app as mkApp, cloneTerm, comb, decode, freeVar, iota, type Node, type NodeId, removeSubtree, sexp } from "./core/term";
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
import { layoutAuto, layoutRadial, layoutHTree, layoutTopDown, type LayoutFn } from "./core/layout";
import { layoutHTree3D, layoutSphere } from "./core/layout3d";
import { recognizeDeep, fromEgg, parseComb, toEgg } from "./core/refold";
import { read, render, type Ty } from "./core/types";
import { inferType } from "./core/infer";
import { defineCombinator, defineRule, findSubtree, isNameTaken, parseRule, replaceSubtree, validateName } from "./core/authoring";
import { TreeView, dashedSegment } from "./view/tree";
import { Hotbar } from "./view/hotbar";
import { Toast } from "./view/toast";
import { Zoo } from "./view/zoo";
import { MhsPanel } from "./view/mhs/panel";
import { AddRule } from "./view/addRule";
import { ReadoutLens } from "./view/readoutLens";
import { ReadoutBox } from "./view/readoutBox";
import { loadWasmReducer, wasmReady, WasmSession } from "./view/wasmReducer";
import { ReductionController, type Transport } from "./view/reduction";
import { TransportBar } from "./view/transportBar";
import { LayoutControls } from "./view/layoutControls";
import { preloadCompiler } from "./view/mhs/compiler";
import { theme, initTheme, toggleMode, currentMode, colorOn, toggleColor, onThemeChange, edgeTierColor } from "./view/theme";
import { MenuBar, type Menu, type MenuItem } from "./view/menubar";
import { About } from "./view/about";
import { Help } from "./view/help";
import { withMotion } from "./view/motion";
import { OPT_SETTINGS, isOpt, setOpt, onOptChange, type OptKey } from "./view/optimize";
import { type NativeOpts } from "./core/native";
import { GameInputController } from "./view/gameInput";
import { ContextMenu } from "./view/contextMenu";
import { NameKeyboard } from "./view/nameKeyboard";
import { GamepadController } from "./view/gamepad";
import { preloadSphere3D } from "./view/sphere3d";
import { SphereController } from "./view/sphereController";
import { Camera } from "./view/camera";
import { DragController } from "./view/dragController";
import { HintBar } from "./view/hints";
import { DiscoveryCard } from "./view/discovery";
import { type Context, type Intent, intentForKey } from "./view/keymap";
import { activeDevice, noteKeyboard, noteMouse, notePad, onDeviceChange } from "./view/inputDevice";

const PAD_ORBIT = 320; // 3D orbit: px-equivalent/sec at full left-stick deflection
const PAD_PAN = 1100; // build camera pan: world-px/sec at full right-stick deflection
const PAD_PAN3D = 600; // 3D pan: px-equivalent/sec at full right-stick deflection
const PAD_ROT_STEP = 22; // 3D orbit: px-equivalent per gamepad d-pad step
const COLLAPSE_MS = 340; // morph from a recognised normal form into its named node
const ATTACH_MS = 280; // glide two trees together when snapped
const DELETE_MS = 240; // fade out a right-clicked subtree

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
  onStep("renderer"); // splash step 1/4

  const world = new Container();
  const ghostLayer = new Container();
  const hud = new Container();
  const camera = new Camera(world);
  // The camera transform, read live so TreeView can viewport-cull edges.
  const cameraTransform = (): { x: number; y: number; scale: number } => camera.transform();
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
  // The pointer-drag FSM (carry a tree / camera pan / snap-to-apply). Owns `drag` + `snapTarget`;
  // the shell gates it (never called while 3D or a pinch is active) and commits its drop outcomes.
  const drag = new DragController({ camera, trees: () => trees, drawGhost, clearGhost });
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

  // (The old "drag ι · snap trees…" description moved into the Help window — ι menu ▸ How to play,
  // and shown on first launch.) The edge legend stays as a compact on-canvas key.
  const legend = new Container();
  paintLegend(legend);
  hud.addChild(legend);

  const toast = new Toast(pixi.ticker);
  hud.addChild(toast.container);
  const discoveryCard = new DiscoveryCard(); // DOM card on discovery (a rotating 3D mini-view) — replaces the discovery toast

  // Live read-out of the focused tree's current expression — a small clickable System-1 box,
  // top-centre. Its title bar cycles the view (combinators / named + native / Barker 0/1); the
  // ReadoutLens below polls the box's view each frame and owns the compute. The box is DOM
  // (matches the quest tracker / discovery card chrome) and themes itself.
  const readoutBox = new ReadoutBox();
  // (Quest hints live in the Quest tracker + the Quest window — not on the main canvas.)

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
  onStep("catalog"); // splash step 2/4

  // The read-out lens (ADR 12): the focused tree's live expression in the read-out box, with the
  // cyclable views + the orthogonal type badge. Owns the lens state, `exprOf`, and the per-frame
  // render; the box owns the chrome/placement. Created here so `isDiscovered` exists.
  const readout = new ReadoutLens({
    ticker: pixi.ticker,
    box: readoutBox,
    focusNode: () => (focus && trees.includes(focus) ? focus.node : null),
    readPage: () => hotbar.page,
    isDiscovered,
    onToggle: () => paintRail(),
    toast,
  });
  void readout.ensureRefolder(true); // load the re-folder wasm at boot (no lazy load); quiet — a missing wasm just keeps the behavioural fallback

  // Layout: auto by default (§5.1); the other layouts are reachable via the View menu or
  // toggleLayout() (the __combinate.toggleLayout dev seam) — no key is bound to either.
  let layoutFn: LayoutFn = layoutAuto;
  let layoutControls: LayoutControls | undefined; // the top-right toggle bar (wired once the shell is built)

  // What a recognised tree collapses into: a single named node. I/K/S reduce by
  // built-in rules; the rest carry their definition (law.def) for the reducer
  // to unfold when applied.
  const collapsedNode = (law: Law): Node => comb(law.sym, law.def?.(), law.arity);

  const sound = new Sound();
  // Sound is on by default, but the browser keeps the AudioContext suspended until a user gesture —
  // resume it on the first pointer/key interaction so tones play without a manual toggle.
  const unlockAudio = (): void => sound.unlock();
  window.addEventListener("pointerdown", unlockAudio, { once: true });
  window.addEventListener("keydown", unlockAudio, { once: true });
  const zoo = new Zoo(isDiscovered, (sym) => sound.play(sym)); // added to the HUD last (below) so it overlays everything

  // Reveal every combinator at once (the Edit-menu "Unlock All Combinators" item + the dev seam).
  function unlockAll(): void {
    for (const law of CATALOG) discovered.add(law.sym);
    saveDiscovered();
    hotbar.refresh();
    for (const t of trees) t.refresh();
    sphere.rerender(); // the 3D view follows the discovery mask too
    zoo.refresh();
    readout.invalidate(); // the read-out's combinator-masking depends on the discovery set
    paintRail();
  }

  // Reset progress (wired to the Quest modal's Reset button): forget the discovered
  // combinators — but keep the player's own authored combos — and refresh everything.
  // The Quest stage is reset by the panel itself; this clears the discovery side.
  function resetProgress(): void {
    discovered.clear();
    for (const n of authoredNames) discovered.add(n);
    saveDiscovered();
    readout.invalidate(); // unmasked combinators changed → recompute the read-out
    hotbar.refresh();
    for (const t of trees) t.refresh();
    sphere.rerender(); // the 3D view follows the discovery mask too
    zoo.refresh();
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
    readout.invalidate(); // a newly-known combinator unmasks in the read-out too
    sphere.rerender(); // a newly-known combinator changes the 3D discovery mask too
    zoo.refresh();
    paintRail();
  }

  // ---- authoring verb (ADR 0006): Define (name a subtree → a new block). The player-facing path is
  // right-click → "Name combinator" (the on-screen keyboard); this armed select-mode + window.prompt
  // path stays for the dev/e2e seam (author.setMode). ----
  type AuthorMode = "define" | null;
  let authorMode: AuthorMode = null;

  function setAuthorMode(mode: AuthorMode): void {
    authorMode = authorMode === mode ? null : mode;
    paintRail();
    if (authorMode === "define") toast.show("Define: click a subtree to name it as a new block");
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
  // reveal it in the hotbar, and seed the Zoo. Used by Define.
  function register(name: string, body: Node): Law {
    const law = defineCombinator(name, body);
    discovered.add(name);
    authoredNames.add(name);
    saveDiscovered();
    void store.putDefinition({ name, egg: toEgg(body) });
    hotbar.refresh();
    hotbar.reveal(name);
    zoo.rebuild();
    readout.invalidate(); // a newly-authored combinator can appear named in the read-out
    paintRail();
    return law;
  }

  // Reveal a freshly-authored *rule* combinator (Add Rule): mark it discovered and
  // refresh the hotbar/Zoo so it shows. `defineRule` already pushed the law + RULES
  // entry; this is the shell-side reveal (no egg persistence — rules don't serialize).
  function revealRule(name: string): void {
    discovered.add(name);
    authoredNames.add(name);
    saveDiscovered();
    hotbar.refresh();
    hotbar.reveal(name);
    zoo.rebuild();
    readout.invalidate();
    paintRail();
  }

  // Collapse the selected subtree into a freshly-named block, in place. Shared by the dev-seam
  // armed-mode path (window.prompt) and the player-facing on-screen keyboard.
  function commitName(tree: TreeView, id: NodeId, sub: Node, name: string): void {
    const law = register(name, sub);
    reduce.cancel(tree);
    tree.animateTo(replaceSubtree(tree.node, id, collapsedNode(law)), COLLAPSE_MS, () => {});
    focus = tree;
    toast.show(`defined ${name}`);
  }

  // Define (dev/e2e seam): name a subtree via window.prompt.
  function doDefine(tree: TreeView, id: NodeId): void {
    const sub = findSubtree(tree.node, id);
    if (!sub) return;
    const name = promptName();
    if (!name) return;
    commitName(tree, id, sub, name);
  }

  // "Name combinator" (right-click / M menu): promote a subtree to a named block via the System-1
  // on-screen keyboard, so a gamepad/keyboard can name it with no text field. Validates on Done and
  // keeps the keyboard open on a bad name.
  function nameCombinator(tree: TreeView, id: NodeId): void {
    const sub = findSubtree(tree.node, id);
    if (!sub) return;
    nameKeyboard.show("", (raw) => {
      const err = validateName(raw);
      if (err) {
        toast.show(err);
        return false; // keep the keyboard open
      }
      commitName(tree, id, sub, raw.trim());
      return true;
    });
  }

  // ---- auto-reduce + transport (extracted to view/reduction.ts, ADR 12). The Pixi
  // side effects (the transport bar) stay here and are injected. ----
  const reduce = new ReductionController({
    getFast: () => fastMode,
    getShare: () => shareMode,
    getNative: () => nativeOpts(),
    getTurbo: () => isOpt("wasm"),
    makeSession: (term) => (wasmReady() ? new WasmSession(term, nativeOpts(), fastMode) : null), // Turbo honours rules (fast) + native
    focusedLive: () => (focus && trees.includes(focus) ? focus : null),
    settle: (tree) => settle(tree),
    onNormalForm: (source) => {
      void challenges.onNormalForm(source);
      quest.onNormalForm(source); // guided progression
    },
    tickSound: (sym) => sound.tick(sym),
    notify: (msg) => toast.show(msg),
    escalateOnBalloon: () => {
      // A ballooning reduction escalates one tier — raw → rules+native (reduce by law + native value ops,
      // the cheapest mode per benchmarks) → graph (call-by-need sharing, which never clones). setOpt
      // reschedules the focus via onOptChange.
      if (!isOpt("rules")) {
        setOpt("rules", true);
        setAllNative(true);
        return "Rule-based + native reduction";
      }
      if (!isOpt("graph")) { setOpt("graph", true); return "Graph reduction"; }
      return null;
    },
    onTransportChange: () => {
      paintRail();
      transportBar.paint();
    },
    morph3D: (tree, node, dur) => sphere.morph(tree, node, dur),
    settleMorph3D: () => sphere.settleMorph(),
    is3DPacing: (tree) => sphere.isPacing(tree), // 3D hides the 2D view → pace this tree to its morph
    morph3DActive: () => sphere.morphing(),
  });

  // Transport bar (top-right): rate read-out + Pause/Step/Play/FF — a thin view over the
  // ReductionController (extracted to view/transportBar.ts, ADR 12).
  const transportBar = new TransportBar(pixi.ticker, reduce, sound);

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


  // The Delete/Copy context popup (mouse right-click + the keyboard "c" / pad-X build bind).
  const ctxMenu = new ContextMenu();
  // The on-screen keyboard for "Name combinator" (no text field — gamepad/keyboard navigable).
  const nameKeyboard = new NameKeyboard();

  function addTree(tree: TreeView): void {
    trees.push(tree);
    world.addChild(tree.container);
    tree.container.on("pointerdown", (e: FederatedPointerEvent) => onTreeDown(tree, e));
    tree.container.on("rightdown", (e: FederatedPointerEvent) => onTreeRightDown(tree, e));
  }

  function spawnTree(node: Node, screenX: number, screenY: number): TreeView {
    const w = camera.screenToWorld(screenX, screenY);
    const tree = new TreeView(node, w.x, w.y, pixi.ticker, isDiscovered, layoutFn, () => expandAll, cameraTransform);
    addTree(tree);
    focus = tree;
    if (withMotion()) tree.popIn(); // grab/spawn pop is always on (only reduced-motion suppresses it)
    return tree;
  }

  const spawnFor = (sym: string): Node => (sym === "ι" ? iota() : collapsedNode(CATALOG.find((l) => l.sym === sym)!));
  // The tone for a grabbed tree: its leftmost-spine atom (a single combinator → itself). Iterative —
  // a deep left-associated spine must not overflow the stack on a mere pickup.
  const headSym = (node: Node): string => {
    let n = node;
    while (n.kind === "app") n = n.fn;
    return n.kind === "comb" ? n.sym : n.kind === "iota" ? "ι" : n.name;
  };
  const hotbar = new Hotbar(
    (node, e) => {
      if (drag.active()) return; // already carrying — put it down first
      if (sound.enabled) sound.play(headSym(node)); // grabbing a combinator off the hotbar plays its tone
      const t = spawnTree(node, e.global.x, e.global.y);
      t.container.eventMode = "none"; // passive while carried
      drag.carry(t);
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
    questTracker.refresh(); // quest hints live in the tracker + the Quest window
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
      // numbers stay opt-in via the Optimizations menu). Compiled programs get big, so lay out as an
      // H-tree (path-local → incremental O(changed) reflow, ADR 18) + zoom to fit; the progress bar
      // shows how the reduction is going.
      setLayoutMode(layoutHTree);
      const view = spawnTree(tree, window.innerWidth / 2, window.innerHeight / 2);
      if (read) hotbar.selectPage(TY_PAGE[read]);
      fitTree(view);
      reduce.schedule(view); // start it reducing under the current settings (was a side effect of the old auto-Turbo)
      toast.show("compiled from Haskell");
    },
    () => paintRail(),
  );

  function onTreeDown(tree: TreeView, e: FederatedPointerEvent): void {
    if (e.button !== 0) return; // left-drag only; right-click is handled separately
    e.stopPropagation();
    // An armed authoring mode consumes the click on a picked node instead of dragging.
    if (authorMode) {
      const id = tree.pickNode(e.global);
      if (id !== null) doDefine(tree, id);
      authorMode = null;
      paintRail();
      return;
    }
    if (drag.carrying()) return commitDrop(tree); // already carrying → this click drops it onto this tree (apply)
    focus = tree;
    reduce.cancel(tree); // touching a tree freezes it (§6.4)
    gameInput?.detach(tree); // grabbing a bucket tree with the mouse releases its slot (ADR 17)
    world.addChild(tree.container); // bring to front
    tree.container.eventMode = "none"; // passive while carried, so the next click reaches what's underneath
    drag.grab(tree, e.global.x, e.global.y);
  }

  // Right-click a node to open a Delete/Copy menu on its subtree (the deepest node under the cursor).
  function onTreeRightDown(tree: TreeView, e: FederatedPointerEvent): void {
    e.stopPropagation();
    const id = tree.pickNode(e.global);
    if (id === null) return;
    const sx = e.global.x;
    const sy = e.global.y;
    ctxMenu.show(sx, sy, [
      { label: "Name Combinator", run: () => nameCombinator(tree, id) },
      { label: "Delete", run: () => deleteNode(tree, id) },
      { label: "Copy", run: () => copyNode(tree, id, sx, sy) },
    ]);
  }

  /** Delete a node's subtree, promoting its sibling (§6.2); deleting the root removes the whole tree. */
  function deleteNode(tree: TreeView, id: NodeId): void {
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

  /** Deep-clone a node's subtree (fresh ids) and PICK THE COPY UP — like a fresh hotbar grab, it
   *  follows the cursor and the next click places it (drop free, or snap-apply onto a tree). */
  function copyNode(tree: TreeView, id: NodeId, sx: number, sy: number): void {
    if (drag.active()) return; // already carrying — ignore (defensive; the menu shouldn't open mid-carry)
    const sub = findSubtree(tree.node, id);
    if (!sub) return;
    const t = spawnTree(cloneTerm(sub), sx, sy);
    t.container.eventMode = "none"; // passive while carried, so the placing click reaches what's underneath
    drag.carry(t);
  }

  /** Commit a DragController drop: snap-apply onto `target`/the snap target (commitSnap picks fn vs
   *  arg by the carried root's side, left = fn), else let the freely-placed tree reduce where it sits. */
  function commitDrop(target?: TreeView): void {
    const o = drag.drop(target);
    if (o.kind === "snapApply") commitSnap(o.dragged, o.target);
    else if (o.kind === "dropFree") {
      o.tree.container.eventMode = "static"; // restore interactivity now it's placed
      reduce.schedule(o.tree); // free placement → reduces where it was dropped
    }
  }

  pixi.stage.on("pointerdown", (e: FederatedPointerEvent) => {
    if (sphere.active()) {
      if (e.pointerType === "touch") return; // touch is handled at the canvas level (1-finger pan / 2-finger orbit)
      if (e.button === 0) sphere.beginDrag("pan", e.global.x, e.global.y); // 3D: left-drag pans
      else if (e.button === 2) sphere.beginDrag("orbit", e.global.x, e.global.y); // 3D: right-drag orbits
      return;
    }
    if (pinch || e.button !== 0) return; // pinching, or a right-click (the menu)
    if (drag.active()) { if (drag.carrying()) commitDrop(); return; } // carrying → drop it here (free, or snap if near a tree)
    drag.beginPan(e.global.x, e.global.y);
  });

  pixi.stage.on("globalpointermove", (e: FederatedPointerEvent) => {
    if (sphere.active()) {
      sphere.dragTo(e.global.x, e.global.y);
      return;
    }
    drag.moveTo(e.global.x, e.global.y); // no-op when idle; pans the camera or moves the carried tree + snap preview
  });

  const onUp = () => {
    sphere.endDrag(); // end a 3D drag (imparts release momentum); no-op in 2D
    drag.endPan(); // end a camera pan; a carried tree keeps following until the next click
  };
  pixi.stage.on("pointerup", onUp);
  pixi.stage.on("pointerupoutside", onUp);

  // Preview the application about to form, with the same fn/arg edge colours as
  // the committed result so you can see which side becomes the function.
  function drawGhost(dragged: TreeView, target: TreeView | null): void {
    ghost.clear();
    if (!target) return;
    const left = dragged.rootWorld.x <= target.rootWorld.x ? dragged : target;
    const right = left === dragged ? target : dragged;
    const ax = (left.rootWorld.x + right.rootWorld.x) / 2;
    const ay = Math.min(left.rootWorld.y, right.rootWorld.y) - 56;
    // the preview is a new depth-0 junction → tier-0 (ink) edges; solid function, dashed argument
    ghost.moveTo(ax, ay).lineTo(left.rootWorld.x, left.rootWorld.y).stroke({ width: 3, color: edgeTierColor(0), alpha: 0.7 }); // function: solid
    dashedSegment(ghost, ax, ay, right.rootWorld.x, right.rootWorld.y); // argument: dashed, matching the committed tree
    ghost.stroke({ width: 2.5, color: edgeTierColor(0), alpha: 0.7 });
    ghost.circle(ax, ay, 6).fill({ color: theme.mutedDot, alpha: 0.7 });
    // preview the resulting expression (left is the function), masked like the rest
    ghostLabel.text = `(${readout.exprOf(left.node)} ${readout.exprOf(right.node)})`;
    ghostLabel.position.set(ax, ay - 12);
    ghostLabel.visible = true;
  }

  function clearGhost(): void {
    ghostLabel.visible = false;
    ghost.clear();
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

  /** A dimmed, NON-reducing render of the held term on the focused bucket (game controller): a bare
   *  `TreeView` added straight to `world` — NOT scheduled, focused, or tracked in `trees`, so the
   *  reducer never touches it. Non-interactive (it's just a ghost). Tear down with {@link unpreview}. */
  function preview(node: Node, wx: number, wy: number): TreeView {
    const tree = new TreeView(node, wx, wy, pixi.ticker, isDiscovered, layoutFn, () => expandAll, cameraTransform);
    tree.container.eventMode = "none"; // a passive ghost — never steals pointer events
    world.addChild(tree.container);
    return tree;
  }

  /** Remove + destroy a preview tree (see {@link preview}). */
  function unpreview(tree: TreeView): void {
    world.removeChild(tree.container);
    tree.destroy();
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
  pixi.canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      noteMouse(); // wheel is a mouse action → hide the controls' visuals/hints
      if (zoo.isOpen || challenges.isOpen) return; // an open overlay owns the wheel (its list scrolls instead of zooming the canvas behind it)
      if (sphere.active()) return sphere.zoomBy(ev.deltaY < 0 ? 0.9 : 1 / 0.9); // 3D: wheel orbits-zoom
      camera.zoomBy(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY);
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
    noteMouse(); // mouse/touch on the canvas → hide the controls' visuals/hints (last-input-wins)
    if (sphere.active() && ev.pointerType !== "touch") return; // 3D MOUSE is handled on the stage (left-pan / right-orbit) — don't double-handle
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (sphere.active()) {
      if (pointers.size === 2) pinch = pinchMetrics(); // 3D: two fingers orbit + pinch-zoom
      return; // 3D: one finger pans (handled in move)
    }
    if (pointers.size === 2) {
      drag.cancel(); // hand control to the pinch (also clears the snap ghost)
      pinch = pinchMetrics();
    }
  });
  pixi.canvas.addEventListener("pointermove", (ev) => {
    if (sphere.active() && ev.pointerType !== "touch") return; // 3D MOUSE handled on the stage
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    const px = p.x; // previous position, before this move
    const py = p.y;
    p.x = ev.clientX;
    p.y = ev.clientY;
    if (sphere.active()) {
      if (pointers.size === 1) {
        sphere.panBy(ev.clientX - px, ev.clientY - py); // one finger pans the look-at
      } else if (pointers.size >= 2 && pinch) {
        const cur = pinchMetrics();
        sphere.orbitBy(cur.cx - pinch.cx, cur.cy - pinch.cy); // two-finger centroid drag → orbit
        if (cur.d !== pinch.d) sphere.zoomBy(pinch.d / cur.d); // spread/pinch → zoom
        pinch = cur;
      }
      return;
    }
    if (pointers.size >= 2 && pinch) {
      const cur = pinchMetrics();
      camera.panBy(cur.cx - pinch.cx, cur.cy - pinch.cy);
      camera.zoomBy(cur.d / pinch.d, cur.cx, cur.cy);
      pinch = cur;
    }
  });
  const endPointer = (ev: PointerEvent): void => {
    pointers.delete(ev.pointerId);
    pinch = pointers.size >= 2 ? pinchMetrics() : null;
  };
  pixi.canvas.addEventListener("pointerup", endPointer);
  pixi.canvas.addEventListener("pointercancel", endPointer);

  // Top-left, just under the menu bar (the old description line is gone — it's in Help now). Hidden
  // on phones, where the top-right control bars would sit on top of it (it's just an edge key).
  const placeLegend = () => {
    legend.position.set(16, 34);
    legend.visible = window.innerWidth > 600;
  };
  placeLegend();
  zoo.layout();

  // Repaint the whole scene when the theme changes (OS change or menu toggle). The
  // menu bar restyles itself via its own onThemeChange listener.
  function applyTheme(): void {
    pixi.renderer.background.color = theme.bg;
    ghostLabel.style.fill = theme.text;
    fpsText.style.fill = theme.textDim;
    paintLegend(legend);
    // (the transport bar self-subscribes to theme changes)
    hotbar.refresh();
    zoo.applyTheme();
    challenges.applyTheme();
    for (const t of trees) t.refresh();
    sphere.retheme(); // no-op when the 3D view is closed
  }
  onThemeChange(applyTheme);

  window.addEventListener("resize", () => {
    fitStage();
    hotbar.layout();
    placeLegend();
    positionPhoneOverlays();
    placeFps();
    toast.layout();
    zoo.layout();
    challenges.layout();
    hintBar.place(window.innerWidth, hotbar.topEdge);
    sphere.resize(window.innerWidth, window.innerHeight);
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
    drag.cancel();
    focus = null;
  }

  /** Wipe all persisted player progress — quest stage + tracker, discovered combinators, and
   *  user-defined combinators (the `Store`'s `definitions`) — behind a confirm, then reload for a
   *  clean slate (the simplest correct reset). Prefix-matched so a future store-key version bump
   *  still clears. Known gap: under `?store=duckdb` definitions live in DuckDB, not localStorage,
   *  so they survive this reset. */
  function resetProgression(): void {
    if (!confirm("Reset all progress? This permanently clears your quest, discovered combinators, and custom combinators.")) return;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("combinate:quest") || k.startsWith("combinate:discovered") || k === "combinate:v1:definitions") localStorage.removeItem(k);
    }
    location.reload();
  }

  // ---- 3D "packed sphere" view (ADR 20): a lazy Three.js render of the focused term ----
  // The whole subsystem lives in SphereController: it owns the view3D flag, the Sphere3D renderer +
  // its Pixi-composited sprite (a layer between `world` and `hud`), orbit/momentum state, and the
  // orbit ticker. The shell forwards raw input, supplies the display term / 3D layout / toasts, and
  // re-syncs its own controls (cursor visuals, hints, rail) whenever 3D opens or closes.
  const sphere = new SphereController({
    stage: pixi.stage,
    hud,
    world,
    ticker: pixi.ticker,
    focus: () => focus,
    display: (node) => expandDisplay(node, { expandAll, isDiscovered }),
    layout3: () => (layoutFn === layoutRadial ? layoutSphere : layoutHTree3D), // 3D defaults to the cubic H-tree; the packed sphere only for the explicit radial layout
    notify: (msg) => toast.show(msg),
    onActiveChange: (active) => {
      if (!active) pinch = null; // a 2-finger 3D gesture exited mid-flight mustn't bleed into the 2D pinch
      syncControls(); // hide the build visuals on enter / restore them on exit (per the active device)
      updateHints();
      paintRail();
    },
  });

  // Set the layout for every tree (and trees spawned afterward). Picking a 2D layout leaves 3D.
  const setLayoutMode = (fn: LayoutFn): void => {
    if (sphere.active()) sphere.exit(); // a 2D layout choice exits the 3D view
    if (layoutFn !== fn) {
      layoutFn = fn;
      for (const t of trees) t.setLayout(fn);
      paintRail();
    }
    layoutControls?.refresh();
  };
  // The active layout's name (layoutControls' toggle bar + the dev seam's mode()).
  const layoutName = (): "auto" | "topdown" | "radial" | "htree" =>
    layoutFn === layoutAuto ? "auto" : layoutFn === layoutTopDown ? "topdown" : layoutFn === layoutRadial ? "radial" : "htree";
  // Cycles auto → top-down → radial → H-tree → auto. No key is bound to this — reachable only
  // via the __combinate.toggleLayout dev seam.
  function toggleLayout(): void {
    setLayoutMode(
      layoutFn === layoutAuto
        ? layoutTopDown
        : layoutFn === layoutTopDown
          ? layoutRadial
          : layoutFn === layoutRadial
            ? layoutHTree
            : layoutAuto,
    );
  }

  /** Frame a tree to fill the viewport (zoom + centre) — from its layout bbox. */
  function fitTree(tree: TreeView): void {
    const b = tree.worldBounds();
    const margin = 0.82;
    const scale = Math.max(0.04, Math.min(2.5, Math.min((window.innerWidth * margin) / Math.max(b.w, 1), (window.innerHeight * margin) / Math.max(b.h, 1))));
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    camera.place(cx, cy, scale, window.innerWidth / 2, window.innerHeight / 2);
  }

  // Game mode's spatial buckets (ADR 17): a stable horizontal strip BUCKET_SPACING apart, keyed by k.
  const BUCKET_SPACING = 640;
  // Centre the camera on a bucket's world x at a fixed "region" zoom so the neighbours (±spacing)
  // peek faded at the screen edges — the faded-neighbour spatial cue. Anchors sit at world y=0; we
  // drop the focus a little above centre so the tree has room to grow downward over the hotbar.
  function frameBucketAt(x: number): void {
    const z = Math.min(1.3, window.innerWidth / (BUCKET_SPACING * 2.3));
    camera.place(x, 0, z, window.innerWidth / 2, window.innerHeight * 0.5);
  }

  // Toggle the "expand everything to ι" view (read by TreeView.expand).
  function toggleExpand(): void {
    expandAll = !expandAll;
    for (const t of trees) t.refresh();
    sphere.rerender(); // the 3D view follows the Expand setting too
    paintRail();
    layoutControls?.refresh(); // the ι toggle in the control bar
  }

  // ---- top menu bar (System 1 Macintosh): the old left rail folded into
  // pull-downs. Reuses the action callbacks below; a ✓ marks an active toggle,
  // a • the selected option in a group. paintRail() (kept for its many callers)
  // now just refreshes the open pull-down's checkmarks. ----
  const about = new About();
  const help = new Help();
  const addRule = new AddRule({ reveal: revealRule, toast: (m) => toast.show(m) });

  // ---- controls (ADR 17): keyboard/controller play via a hand cursor, always live in 2D.
  // The visuals adapt to the active input device; "Show controls" (default on) gates the hints. ----
  let showControls = localStorage.getItem("combinate.showControls") !== "0";
  const hintBar = new HintBar();
  hud.addChild(hintBar.container);
  hintBar.place(window.innerWidth, hotbar.topEdge);
  // The active interaction context: 2D is always Build (the tray), 3D is Inspect. The controls are
  // always live in 2D; only their visuals/hints adapt to the active input device.
  function currentContext(): Context {
    return sphere.active() ? "inspect" : "build";
  }
  function updateHints(): void {
    hintBar.setContext(currentContext());
  }
  /** Keep the controls' visuals in sync with the active device: the toolbar's game cursor shows
   *  for keyboard/gamepad (not mouse) and not in 3D. Actions stay live regardless; this is visuals. */
  function syncControls(): void {
    gameInput.setEnabled(activeDevice() !== "mouse" && !sphere.active());
    layoutControls?.refresh(); // keep the toggle bar in sync (3D on/off, layout changes)
  }
  /** View ▸ "Show controls": gate the on-screen hints only (persisted; visuals/actions unaffected). */
  function setShowControls(v: boolean): void {
    showControls = v;
    localStorage.setItem("combinate.showControls", v ? "1" : "0");
    hintBar.setShowControls(v);
    paintRail();
  }
  onDeviceChange(() => {
    syncControls();
    hintBar.refresh();
  }); // last-input-wins → swap the controls' visuals + the hint glyphs
  const labelFor = (node: Node): string => {
    const s = readout.exprOf(node);
    return s.length > 14 ? s.slice(0, 13) + "…" : s;
  };
  const gameInput = new GameInputController({
    hotbar,
    freshNode: spawnFor,
    labelOf: labelFor,
    bucketAnchor: (k) => ({ x: k * BUCKET_SPACING, y: 0 }), // an unbounded strip of world anchors
    spawnAt: (node, w) => spawnTreeWorld(node, w.x, w.y),
    preview: (node, w) => preview(node, w.x, w.y),
    unpreview: (tree) => unpreview(tree),
    applyTerms: (fn, arg, w, from) => applyTerms(fn, arg, w, from),
    captureWorld: (tree) => tree.nodeWorldPositions(),
    removeTree,
    frameBucketAt: (x) => frameBucketAt(x),
    pan: (dx, dy) => camera.panBy(dx, dy),
    zoom: (factor) => camera.zoomBy(factor, window.innerWidth / 2, window.innerHeight / 2),
    setSpeed: (lvl) => reduce.setSpeedLevel(lvl),
    getSpeedLevel: () => reduce.speedLevel,
    openMenu: () => menuBar?.openMenuBar(),
    allTrees: () => trees,
    toast: (m) => toast.show(m),
  });
  // Wire the initial controls state: the hints follow the "Show controls" pref, the visuals follow
  // the active device (mouse on load → hidden), and the hint bar shows the current context.
  hintBar.setShowControls(showControls);
  syncControls();
  updateHints();
  // The three native-value opts presented as one toggle: on iff all three are on; flips all three.
  // Declared here (not just before the Optimizations menu) because LayoutControls' "Primitives"
  // cell reads it immediately on construction, below.
  const NATIVE_KEYS = ["nativeNumbers", "nativeLists", "nativeBooleans"] as const;
  const nativeAllOn = (): boolean => NATIVE_KEYS.every((k) => isOpt(k));
  const setAllNative = (on: boolean): void => {
    for (const k of NATIVE_KEYS) setOpt(k, on);
  };
  // The top-right layout toggle bar (under the transport): [2D|3D], [Top-Down|Radial|H-tree], [Auto].
  layoutControls = new LayoutControls({
    is3D: () => sphere.active(),
    set3D: (on) => {
      if (on !== sphere.active()) sphere.toggle();
    },
    layout: () => layoutName(),
    setLayout: (k) => setLayoutMode(k === "auto" ? layoutAuto : k === "topdown" ? layoutTopDown : k === "radial" ? layoutRadial : layoutHTree),
    iotaTree: () => expandAll,
    toggleIotaTree: () => toggleExpand(),
    opt: (k) => (k === "primitives" ? nativeAllOn() : k === "turbo" ? isOpt("wasm") : isOpt(k)),
    toggleOpt: (k) => {
      if (k === "primitives") setAllNative(!nativeAllOn());
      else if (k === "turbo") setOpt("wasm", !isOpt("wasm"));
      else setOpt(k, !isOpt(k)); // rules | graph
    },
    transportEl: transportBar.el, // hosted inside the Controls card on phones
  });
  // Phone: the transport + toggles collapse into the Controls card, whose height varies (collapsed vs
  // expanded), so stack the combinator read-out just beneath it. On wider screens it keeps its CSS spot.
  const positionPhoneOverlays = (): void => {
    if (window.innerWidth > 600) return readoutBox.setTop(null);
    const b = layoutControls?.mobileBottom() ?? 0;
    readoutBox.setTop(b > 0 ? Math.round(b) + 8 : 52);
  };
  if (layoutControls) layoutControls.onLayout = positionPhoneOverlays;
  positionPhoneOverlays();
  // Gamepad: a third input producer (polled from the ticker), routed by the active context.
  new GamepadController(pixi.ticker, {
    context: () => (sphere.active() ? "inspect" : "build"),
    dispatch: (i) => dispatchPadIntent(i),
    leftStick: (sx, sy, dt) => {
      if (sphere.active()) sphere.orbitBy(sx * PAD_ORBIT * dt, sy * PAD_ORBIT * dt); // inspect: orbit
    },
    rightStick: (sx, sy, dt) => {
      if (!sphere.active()) gameInput.panBy(-sx * PAD_PAN * dt, -sy * PAD_PAN * dt); // build: pan the camera
      else sphere.panBy(sx * PAD_PAN3D * dt, sy * PAD_PAN3D * dt); // inspect: pan the look-at
    },
    zoomBy: (f) => (sphere.active() ? sphere.zoomBy(f) : gameInput.zoomBy(f)),
    note: () => notePad(),
    toast: (m) => toast.show(m),
  });
  // A pad unplugging must drop the pad hint glyphs immediately (don't strand them on screen) —
  // fall back to mouse until the next real input. The hint bar refreshes via onDeviceChange.
  window.addEventListener("gamepaddisconnected", () => noteMouse());
  // A pad's discrete intent, routed by the active context (Build → the tray controller; Inspect →
  // the 3D camera). The keyboard routes the same intents below.
  function dispatchPadIntent(intent: Intent): void {
    if (nameKeyboard.isOpen) return routeNameKbNav(intent); // the on-screen keyboard owns the pad (✚/A/B)
    if (menuBar?.isOpen) return routeMenuBarNav(intent); // an open menu bar owns the pad (✚/A/B)
    if (ctxMenu.isOpen) return routeCtxNav(intent); // an open popup owns the pad (↑/↓/A/B/X)
    switch (intent) {
      case "context":
        return openBucketContext();
      case "transportPrev":
        return stepTransport(-1); // LB: toward Pause
      case "transportNext":
        return stepTransport(1); // RB: toward Fast-forward
      case "enterInspect":
      case "exitInspect":
        return sphere.toggle();
      case "recenter":
        return sphere.recenter();
      case "rotLeft":
        return sphere.orbitBy(-PAD_ROT_STEP, 0);
      case "rotRight":
        return sphere.orbitBy(PAD_ROT_STEP, 0);
      case "rotUp":
        return sphere.orbitBy(0, -PAD_ROT_STEP);
      case "rotDown":
        return sphere.orbitBy(0, PAD_ROT_STEP);
      case "speed":
        return gameInput.cycleSpeed();
      default:
        return gameInput.trigger(intent); // build discrete intents (move/page/pick/apply/cancel)
    }
  }
  // The optimize store is the source of truth; mirror it into the reducer flags and do
  // the per-mode invalidation (carry the changed key so we invalidate only what changed).
  onOptChange((key) => {
    if (key === "rules") {
      fastMode = isOpt("rules");
      reduce.invalidateGraphers(); // graphers bake `fast` at construction
      reduce.invalidateSessions(); // a wasm session bakes `fast` too → rebuild it under the new mode
      if (focus) reduce.schedule(focus); // reschedule → reset the step count + re-estimate in the new mode (consistent bar)
    } else if (key === "graph") {
      shareMode = isOpt("graph");
      if (focus) {
        // Graph snapshots read back as a shared DAG (stable ids). Turning graph OFF must drop that
        // shared view — clone the current term to fresh ids so each occurrence draws separately —
        // and rebuild the display, else the tree keeps rendering the DAG. (ON needs nothing:
        // sharing only accrues as the graph reduces.)
        if (!shareMode) {
          focus.node = cloneTerm(focus.node);
          focus.refresh();
        }
        reduce.schedule(focus);
      }
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
    layoutControls?.refresh(); // the optimizations row reflects isOpt
  });
  // One Optimizations row for a single opt key (label + description from OPT_SETTINGS).
  const optItem = (key: OptKey): MenuItem => {
    const s = OPT_SETTINGS.find((o) => o.key === key)!;
    return { kind: "toggle", label: s.label, title: s.desc, checked: () => isOpt(key), run: () => setOpt(key, !isOpt(key)) };
  };
  const menus: Menu[] = [
    { title: "ι", apple: true, items: [
      { kind: "action", label: "How to Play…", title: "The basics: drag ι, snap trees, watch them reduce.", run: () => help.open() },
      { kind: "action", label: "About Combinate…", title: "What this is, and credits.", run: () => about.open() },
    ] },
    { title: "File", items: [
      { kind: "toggle", label: "Quest", title: "Your guided path — discover each bird in turn.", checked: () => quest.isOpen, run: () => quest.toggle() },
      { kind: "toggle", label: "Zoo", title: "Browse the combinators you've discovered.", checked: () => zoo.isOpen, run: () => zoo.toggle() },
      { kind: "toggle", label: "Golf", title: "Timed challenges: hit a target in the fewest ι.", checked: () => challenges.isOpen, run: () => challenges.toggle() },
      { kind: "sep" },
      { kind: "action", label: "Compile Haskell…", title: "Compile a Haskell expression into a combinator tree, using Micro Haskell.", run: () => mhsPanel.open() },
      { kind: "action", label: "Share Link", title: "Copy a permalink to the current canvas.", run: () => shareFocused() },
    ] },
    { title: "Edit", items: [
      { kind: "action", label: "Clear Canvas", title: "Remove every tree from the canvas.", run: () => clearCanvas() },
      { kind: "action", label: "Add Rule…", title: "Add a custom one-step rewrite rule, e.g. W f x = f x x.", run: () => addRule.open() },
      { kind: "sep" },
      { kind: "action", label: "Reset Progression", title: "Wipe your quest, discovered combinators, and named combinators.", run: () => resetProgression() },
      { kind: "action", label: "Unlock All Combinators", title: "Reveal every combinator in the hotbar and Zoo.", run: () => unlockAll() },
    ] },
    { title: "View", items: [
      { kind: "radio", label: "Auto Layout", title: "Lay trees out automatically.", on: () => layoutFn === layoutAuto, run: () => setLayoutMode(layoutAuto) },
      { kind: "radio", label: "Top-Down Layout", title: "Lay trees out strictly top-down.", on: () => layoutFn === layoutTopDown, run: () => setLayoutMode(layoutTopDown) },
      { kind: "radio", label: "Radial Layout", title: "Lay trees out radially.", on: () => layoutFn === layoutRadial, run: () => setLayoutMode(layoutRadial) },
      { kind: "radio", label: "H-Tree Layout", title: "Lay trees out as a nested square antenna — alternating axes, arms shrinking with depth.", on: () => layoutFn === layoutHTree, run: () => setLayoutMode(layoutHTree) },
      { kind: "toggle", label: "3D", title: "View the tree in 3D (mirrors the 2D layout — H-tree → cubic H-tree, else packed sphere).", checked: () => sphere.active(), run: () => sphere.toggle() },
      { kind: "sep" },
      { kind: "toggle", label: "Expand ι-Trees", title: "Show every combinator expanded to raw ι.", checked: () => expandAll, run: () => toggleExpand() },
      { kind: "toggle", label: "Type Lens", title: "Annotate the read-out with inferred types.", checked: () => readout.isTypeOn, run: () => readout.toggleType() },
      { kind: "radio", label: "Read-Out: Combinators", title: "Show the top read-out as raw SKI / ι.", on: () => readout.view === "ski", run: () => readoutBox.setView("ski") },
      { kind: "radio", label: "Read-Out: Named + Native", title: "Show discovered birds and native values.", on: () => readout.view === "named", run: () => readoutBox.setView("named") },
      { kind: "radio", label: "Read-Out: Barker (0/1)", title: "Show the term as Barker bit-code.", on: () => readout.view === "barker", run: () => readoutBox.setView("barker") },
      { kind: "sep" },
      { kind: "toggle", label: "Dark Mode", title: "Switch to the dark palette.", checked: () => currentMode() === "dark", run: () => toggleMode() },
      { kind: "toggle", label: "Color (4096)", title: "Enable the 4096-colour palette.", checked: () => colorOn(), run: () => toggleColor() },
      { kind: "sep" },
      { kind: "toggle", label: "Track Quest", title: "Show the quest-tracker panel.", checked: () => !quest.done && !questTracker.isHidden, run: () => { questTracker.setHidden(!questTracker.isHidden); paintRail(); } },
      { kind: "toggle", label: "Show Controls", title: "Show the on-screen control hints.", checked: () => showControls, run: () => setShowControls(!showControls) },
      { kind: "toggle", label: "FPS Counter", title: "Show the frame-rate counter.", checked: () => fpsOn, run: () => toggleFps() },
    ] },
    { title: "Optimizations", items: [
      optItem("rules"),
      optItem("graph"),
      { kind: "toggle", label: "Primitives", title: "Compute catalog numbers, lists, and booleans on recognised native values directly.", checked: () => nativeAllOn(), run: () => setAllNative(!nativeAllOn()) },
      optItem("wasm"),
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
    ...readout.modes(), // { view?, type? }
    expand: expandAll || undefined,
    page: hotbar.page,
    transport: reduce.mode === "max" ? "ff" : reduce.mode, // permalink has no "max" slot (yet) — record it as ff
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
        sphere.holdRotate(k); // the orbit ticker reads held rotate-keys for continuous rotation
        return;
      case "zoomIn":
        return sphere.zoomBy(0.9);
      case "zoomOut":
        return sphere.zoomBy(1 / 0.9);
      case "recenter":
        return sphere.recenter();
      case "exitInspect":
        return sphere.toggle();
    }
  }
  function dispatchBuildKey(intent: Intent): void {
    if (intent === "enterInspect") return sphere.toggle();
    if (intent === "context") return openBucketContext();
    // Keyboard 1-4 = the transport (the gamepad Select still cycles speed via dispatchPadIntent).
    if (intent === "transportPause") return reduce.setTransport("pause");
    if (intent === "transportStep") return reduce.stepOnce();
    if (intent === "transportPlay") return reduce.setTransport("play");
    if (intent === "transportFf") return reduce.setTransport("ff");
    gameInput.trigger(intent);
  }

  /** Open the Delete/Copy menu on the controls' focused bucket (keyboard "c" / pad X). Empty bucket
   *  or holding → nothing to act on. Delete removes the bucket's tree; Copy carries a fresh clone. */
  function openBucketContext(): void {
    if (gameInput.hasHand) return; // a carry is in progress — don't act on the bucket underneath
    const tree = gameInput.focusedTree;
    if (!tree) return;
    const s = camera.worldToScreen(gameInput.focusedKey * BUCKET_SPACING, 0);
    ctxMenu.show(s.x, s.y, [
      { label: "Name Combinator", run: () => nameCombinator(tree, tree.node.id) },
      { label: "Delete", run: () => removeTree(tree) },
      { label: "Copy", run: () => gameInput.takeToHand(cloneTerm(tree.node)) },
    ]);
  }

  /** Step the transport one notch along [pause, play, ff], clamped at the ends (gamepad LB/RB).
   *  `dir` < 0 steps toward Pause, > 0 toward Fast-forward; Step stays keyboard-only. */
  const TRANSPORT_STEPS: Transport[] = ["pause", "play", "ff"];
  function stepTransport(dir: number): void {
    const i = TRANSPORT_STEPS.indexOf(reduce.mode);
    const next = Math.max(0, Math.min(TRANSPORT_STEPS.length - 1, (i < 0 ? 0 : i) + dir));
    reduce.setTransport(TRANSPORT_STEPS[next]);
  }

  /** Route a discrete intent to the open on-screen keyboard (keyboard/gamepad nav): ✚ walks the
   *  grid, A presses the highlighted key, B cancels. Mirrors the keyboard routing in keydown. */
  function routeNameKbNav(intent: Intent): void {
    if (intent === "moveLeft") nameKeyboard.move(-1, 0);
    else if (intent === "moveRight") nameKeyboard.move(1, 0);
    else if (intent === "moveUp") nameKeyboard.move(0, -1);
    else if (intent === "moveDown") nameKeyboard.move(0, 1);
    else if (intent === "pickPlace") nameKeyboard.press();
    else if (intent === "cancel" || intent === "context") nameKeyboard.cancel();
  }

  /** Route a discrete intent to the open context popup (keyboard/gamepad nav): ↑/↓ walk, A choose,
   *  B/X cancel. Keeps the popup operable when a pad bind (not the mouse) opened it. */
  function routeCtxNav(intent: Intent): void {
    if (intent === "moveDown") ctxMenu.move(1);
    else if (intent === "moveUp") ctxMenu.move(-1);
    else if (intent === "pickPlace") ctxMenu.choose();
    else if (intent === "cancel" || intent === "context") ctxMenu.cancel();
  }

  /** Route a discrete intent to the open menu bar (gamepad nav): D-pad ←/→ switch menus, ↑/↓ walk
   *  the dropdown, A choose, B close. Mirrors the keyboard routing in the keydown handler. */
  function routeMenuBarNav(intent: Intent): void {
    if (intent === "moveLeft") menuBar?.moveMenu(-1);
    else if (intent === "moveRight") menuBar?.moveMenu(1);
    else if (intent === "moveUp") menuBar?.moveItem(-1);
    else if (intent === "moveDown") menuBar?.moveItem(1);
    else if (intent === "pickPlace") menuBar?.choose();
    else if (intent === "cancel") menuBar?.close();
  }

  window.addEventListener("keydown", (e) => {
    // The on-screen keyboard owns the keyboard while open (gates everything else): arrows walk the
    // grid, Space presses the highlighted key, a printable char types directly, Backspace deletes,
    // Enter commits (Done), Esc cancels. Modifier combos (Ctrl-R, …) pass through to the browser.
    if (nameKeyboard.isOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === "Enter") nameKeyboard.done();
      else if (e.key === "Escape") nameKeyboard.cancel();
      else if (e.key === "Backspace") nameKeyboard.backspace();
      else if (e.key === "ArrowLeft") nameKeyboard.move(-1, 0);
      else if (e.key === "ArrowRight") nameKeyboard.move(1, 0);
      else if (e.key === "ArrowUp") nameKeyboard.move(0, -1);
      else if (e.key === "ArrowDown") nameKeyboard.move(0, 1);
      else if (e.key === " ") nameKeyboard.press();
      else if (e.key.length === 1) nameKeyboard.typeChar(e.key);
      e.preventDefault();
      return;
    }
    // An open menu bar owns the keyboard: ←/→ switch menus, ↑/↓ walk the dropdown, Space/Enter
    // choose, Esc close. Like the popup below, it gates everything else (the build binds included).
    if (menuBar?.isOpen) {
      if (e.key === "ArrowLeft") menuBar.moveMenu(-1);
      else if (e.key === "ArrowRight") menuBar.moveMenu(1);
      else if (e.key === "ArrowUp") menuBar.moveItem(-1);
      else if (e.key === "ArrowDown") menuBar.moveItem(1);
      else if (e.key === " " || e.key === "Enter") menuBar.choose();
      else if (e.key === "Escape") menuBar.close();
      e.preventDefault();
      return;
    }
    // An open Delete/Copy popup owns the keyboard: ↑/↓ walk, Space/Enter choose, Esc cancel.
    if (ctxMenu.isOpen) {
      if (e.key === "ArrowDown") ctxMenu.move(1);
      else if (e.key === "ArrowUp") ctxMenu.move(-1);
      else if (e.key === " " || e.key === "Enter") ctxMenu.choose();
      else if (e.key === "Escape") ctxMenu.cancel();
      e.preventDefault();
      return;
    }
    if (zoo.isOpen) {
      if (e.key === "ArrowDown") return e.preventDefault(), zoo.move(1);
      if (e.key === "ArrowUp") return e.preventDefault(), zoo.move(-1);
      if (e.key === "ArrowRight") return e.preventDefault(), zoo.cyclePage(1);
      if (e.key === "ArrowLeft") return e.preventDefault(), zoo.cyclePage(-1);
      if (e.key === "Escape") return zoo.close();
    }
    // The keyboard belongs to the game-mode controls (ADR 17): only Build/Inspect's bound keys act,
    // and every command else lives in the menu bar (no desktop letter-accelerators). Never while an
    // overlay or text field is up, and modifier combos (Ctrl/Cmd/Alt — browser shortcuts like Ctrl-R)
    // always pass through.
    const typing = (el: Element | null): boolean => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
    const overlayUp = (): boolean => zoo.isOpen || challenges.isOpen || [...document.querySelectorAll<HTMLElement>(".md-root")].some((el) => el.style.display === "flex");
    const blocked = e.ctrlKey || e.metaKey || e.altKey || overlayUp() || typing(document.activeElement);
    if (blocked) return; // typing / an overlay / a modifier combo → leave it to the browser + modals
    noteKeyboard(); // keyboard activity → keyboard hint glyphs (last-input-wins)
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
    // BUILD (2D): a bound key drives the tray (nav / pick / apply / cancel / speed / enter-3D). An
    // unbound key does nothing — every other command lives in the menu bar.
    const intent = intentForKey("build", e.key);
    if (intent) {
      dispatchBuildKey(intent);
      e.preventDefault();
      return;
    }
  });
  window.addEventListener("keyup", (e) => sphere.releaseRotate(e.key.toLowerCase())); // release a 3D rotate-key

  // Kill the browser's native context menu everywhere — right-click opens our Delete/Copy popup, never
  // the OS one — except inside real text fields (the Haskell editor / name prompts), where it's useful.
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
  });

  // A small key for the edge encoding: STYLE = which child (solid function / dashed argument),
  // COLOUR = depth tier (red/black alternating, so a parent-edge differs from its child-edges).
  // Repainted on a theme change.
  function paintLegend(c: Container): void {
    for (const ch of c.removeChildren()) ch.destroy({ children: true });
    const ink = theme.text;
    const g = new Graphics();
    g.moveTo(0, 0).lineTo(26, 0).stroke({ width: 3, color: ink }); // function: solid
    for (let x = 0; x < 26; x += 14) g.moveTo(x, 18).lineTo(Math.min(x + 8, 26), 18); // argument: dashed
    g.stroke({ width: 2.5, color: ink });
    g.moveTo(0, 36).lineTo(12, 36).stroke({ width: 3, color: edgeTierColor(0) }); // depth tiers: ink …
    g.moveTo(14, 36).lineTo(26, 36).stroke({ width: 3, color: edgeTierColor(1) }); // … and red, alternating
    c.addChild(g);
    const style = { fontFamily: "monospace", fontSize: 12, fill: theme.textDim };
    const l1 = new Text({ text: "function (left)", style });
    l1.position.set(34, -7);
    const l2 = new Text({ text: "argument (right)", style });
    l2.position.set(34, 11);
    const l3 = new Text({ text: "colour = depth", style });
    l3.position.set(34, 29);
    c.addChild(l1, l2, l3);
  }

  // The re-folding lens wasm is already loading (readout.ensureRefolder(true), fired at boot above);
  // the behavioural-only re-folder bridges until it's ready.
  if (isOpt("wasm")) void loadWasmReducer(); // persisted Turbo → warm the wasm so the first reduction uses it
  void preloadSphere3D(); // warm the Three.js chunk so the first 3D view is instant
  onStep("lenses"); // splash step 3/4

  // Warm the MicroHs live-compile blob + cache (the 3 MB compiler), so the Haskell
  // panel is ready and its first compile doesn't pay the download. Best-effort.
  await preloadCompiler();
  onStep("compiler"); // splash step 4/4

  // First launch: open the Help window once (then never auto-open again — it stays in the ι menu).
  try {
    if (!localStorage.getItem("combinate.helpSeen")) {
      help.open();
      localStorage.setItem("combinate.helpSeen", "1");
    }
  } catch {
    /* private mode / storage disabled — just skip the one-time help */
  }

  // Dev-only test seam (stripped from production builds): expose tree state so
  // an end-to-end driver can assert on spawn/snap/reduce.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    (globalThis as Record<string, unknown>).__combinate = {
      trees,
      sexps: () => trees.map((t) => sexp(t.node)),
      roots: () => trees.map((t) => t.rootWorld),
      discovered: () => [...discovered],
      discover: (sym: string) => { const l = CATALOG.find((x) => x.sym === sym); if (l) discover(l); }, // dev seam: fire the discovery flow (card + chirp)
      place: (sym: string, x: number, y: number) => spawnTree(spawnFor(sym), x, y).rootWorld, // dev seam: place a (non-reducing) combinator tree at a screen point (drag/snap harness)
      mode: () => layoutName(),
      toggleLayout: () => toggleLayout(),
      view3d: { on: () => sphere.active(), toggle: () => sphere.toggle(), info: () => sphere.info(), morph: () => sphere.debugMorph() },
      transport: { mode: () => reduce.mode, set: (m: string) => reduce.setTransport(m as Transport), cycle: () => reduce.cycleTransport(), step: () => reduce.stepOnce() },
      autoSteps: () => reduce.totalSteps(),
      est: () => ({ ...reduce.estimate, shown: reduce.focusedSteps() }),
      run: () => { if (focus) reduce.schedule(focus); },
      incrParity: () => (focus ? focus.debugLayoutParity() : null), // dev seam: incremental-layout parity vs a full recompute
      incrActive: () => (focus ? focus.canIncremental() : false),
      // Dev seam: isolate applyPatch cost vs tree size for a FIXED small change (clause-2 O(changed)
      // proof). Builds an inert H-tree of ~2^(depth+1) free-var nodes, then alternates a 1↔3-node swap
      // at a fixed deep anchor, timing only applyPatch. Off-canvas (never rendered), destroyed after.
      benchIncr: (depth: number, iters: number): { size: number; avgApplyUs: number; fullLayoutUs: number } | { error: string } => {
        const count = (n: Node): number => { let c = 0; const s = [n]; while (s.length) { const m = s.pop()!; c++; if (m.kind === "app") s.push(m.fn, m.arg); } return c; };
        const buildBal = (d: number): Node => (d <= 0 ? freeVar("x") : mkApp(buildBal(d - 1), buildBal(d - 1)));
        const splice = (r: Node, path: number[], sub: Node, i = 0): Node => (i === path.length ? sub : r.kind !== "app" ? sub : path[i] === 0 ? { ...r, fn: splice(r.fn, path, sub, i + 1) } : { ...r, arg: splice(r.arg, path, sub, i + 1) });
        const root0 = buildBal(depth);
        const P: number[] = [];
        { let n = root0; while (n.kind === "app") { P.push(0); n = n.fn; } } // leftmost-leaf path
        const subA = freeVar("A");
        const subB = mkApp(freeVar("B"), freeVar("C"));
        let cur = splice(root0, P, subA);
        const size = count(cur);
        const view = new TreeView(cur, -1e6, -1e6, pixi.ticker, isDiscovered, layoutHTree, () => false, cameraTransform);
        if (!view.beginIncremental()) { view.destroy(); return { error: "not eligible for incremental" }; }
        let curSub = subA;
        let otherSub: Node = subB;
        let t = 0;
        for (let i = 0; i < iters; i++) {
          const root = splice(cur, P, otherSub);
          const patch = { root, sym: "bench", path: P, oldRedex: curSub, replacement: otherSub };
          const s = performance.now();
          view.applyPatch(patch);
          t += performance.now() - s;
          cur = root;
          [curSub, otherSub] = [otherSub, curSub];
        }
        view.commitIncremental();
        view.destroy();
        // For contrast: the O(n) full-layout recompute the old path did every step.
        const fl0 = performance.now();
        const reps = 20;
        for (let i = 0; i < reps; i++) layoutHTree(cur, { l0: undefined });
        const fullLayoutUs = ((performance.now() - fl0) / reps) * 1000;
        return { size, avgApplyUs: (t / iters) * 1000, fullLayoutUs };
      },
      spawn: (s: string) => { spawnTreeWorld(fromEgg(s), 0, 0); }, // dev seam: drop a reducing tree from an s-expr
      fit: () => { if (focus) fitTree(focus); }, // dev seam: frame the focused tree to the viewport

      game: { active: () => gameInput.enabled, force: (b: boolean) => gameInput.setEnabled(b), state: () => gameInput.debugState, ctxOpen: () => ctxMenu.isOpen },
      fast: { on: () => isOpt("rules"), set: (b: boolean) => setOpt("rules", b) },
      graph: { on: () => isOpt("graph"), set: (b: boolean) => setOpt("graph", b), eval: (s: string) => sexp(evalShared(fromEgg(s), 500000, fastMode).term) },
      expr: () => readout.text,
      view: { get: () => readout.view, cycle: () => readout.cycleView(), set: (v: string) => readoutBox.setView(v as "ski" | "named" | "barker"), expand: () => readoutBox.toggleExpand() },
      page: () => hotbar.page,
      setPage: (name: string) => hotbar.selectPage(name),
      type: { on: () => readout.isTypeOn, toggle: () => readout.toggleType(), of: (s: string) => inferType(fromEgg(s)) },
      unlockAll: () => unlockAll(),
      openZoo: () => zoo.open(),
      camera: () => camera.transform(),
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
        // add a one-step rule combinator from `name args = body` (returns an error or null)
        rule: (input: string): string | null => {
          const r = parseRule(input);
          if ("error" in r) return r.error;
          defineRule(r.name, r.args, r.body, r.lawText);
          revealRule(r.name);
          return null;
        },
        openRule: () => addRule.open(), // open the Add Rule modal (for screenshots / driving the form)
        defs: () => CATALOG.filter((l) => l.userDefined).map((l) => l.sym),
      },
      refold: {
        // the re-folder now backs the "named + native" read-out view (no boolean toggle)
        ready: () => readout.refolderReady,
        init: () => readout.ensureRefolder(),
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
      // wasm turbo reducer (ADR 16): load + drive a resident session to NF, for tests.
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

  // ---- console playground (always on): parse + evaluate combinator / Barker expressions ----
  // Turbo = the fast-rules graph reducer (evalShared with fast=true); reads the NF back to a native
  // value (int / list / bool) when it can, else shows the raw combinator normal form.
  const evalTurbo = (node: Node): string => {
    const nf = evalShared(node, 1_000_000, true).term;
    const v = read(nf);
    return v ? render(v) : sexp(nf);
  };
  // Run a parse/eval, but return a clean "⚠ …" string on bad input instead of throwing an
  // uncaught error into the console (with an optional format hint for the expected notation).
  const tryStr = (f: () => string, hint?: string): string => {
    try {
      return f();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return hint ? `⚠ ${hint} — ${m}` : `⚠ ${m}`;
    }
  };
  // Accept both ordinary combinator notation (`S K K`, `(S (K I))` — exactly what `parse`/`barker`
  // print, so their output feeds straight back into `eval`) AND the internal egg form (`(@ f x)`).
  const readExpr = (s: string): Node => (s.includes("(@") ? fromEgg(s) : parseComb(s));
  const EXPR = "expects a combinator expression, e.g. S K K  (or egg (@ f x))";
  const BITS = "expects Barker bit-code (1=ι, 0<fn><arg>), e.g. 011";
  const consoleApi = {
    /** Parse a combinator expression (`S K K` / `(S (K I))`, or egg `(@ f x)`) → its term (s-expr). */
    parse: (expr: string): string => tryStr(() => sexp(readExpr(expr)), EXPR),
    /** Parse Barker bit-code (`1` = ι, `0 <fn> <arg>` = app) → its term (s-expr). */
    barker: (bits: string): string => tryStr(() => sexp(decode(bits)), BITS),
    /** Parse an expression (combinator or egg) and evaluate it to NF with Turbo → value or raw NF.
     *  Accepts what `parse`/`barker` return, so e.g. `eval(parse("(@ S K)"))` round-trips. */
    eval: (expr: string): string => tryStr(() => evalTurbo(readExpr(expr)), EXPR),
    /** Parse Barker bit-code and evaluate it with Turbo → value or raw NF. */
    evalBarker: (bits: string): string => tryStr(() => evalTurbo(decode(bits)), BITS),
    /** Reprint this help. */
    help: (): void => printConsoleHelp(),
  };
  function printConsoleHelp(): void {
    console.log(
      "%ccombinate console API — window.combinate",
      "font-weight:bold",
      "\n  .eval(\"S K K K\")         parse + evaluate (Turbo) → native value, or raw NF" +
        "\n  .parse(\"S (K I)\")        parse a combinator expr (or egg (@ f x)) → term" +
        "\n  .barker(\"011\")           parse Barker bit-code (1=ι, 0<fn><arg>=app) → term" +
        "\n  .evalBarker(\"011\")       parse + evaluate Barker bit-code" +
        "\n  .help()                   this message" +
        "\n  eval accepts what parse/barker return — e.g. eval(parse(\"(@ S K)\")).",
    );
  }
  (globalThis as Record<string, unknown>).combinate = consoleApi;
  console.log("%cWelcome to combinate!", "font-size:14px;font-weight:bold");
  printConsoleHelp();
}
