import {
  Application,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Rectangle,
  Text,
} from "pixi.js";
import { app as mkApp, comb, decode, iota, type Node, type NodeId, sexp } from "./core/term";
import { step } from "./core/reduce";
import { type Law } from "./core/catalog";
import { recognize } from "./core/probe";
import { TreeView, FN_EDGE, ARG_EDGE } from "./view/tree";
import { Hotbar } from "./view/hotbar";
import { Toast } from "./view/toast";

const SNAP_R = 72; // world-space snap radius between two tree root anchors (~1.3·XS)
const AUTO_DELAY = 450; // ms a tree must sit untouched before it starts reducing (§6.4)
const STEP_MS = 300; // duration of one reduction-step tween
const STEP_GAP = 130; // pause between reduction steps
const STEP_CAP = 2000; // non-termination guard: stop auto-reducing past this many steps
const COLLAPSE_MS = 340; // morph from a recognised normal form into its named node
const ATTACH_MS = 280; // glide two trees together when snapped

type Drag =
  | { kind: "tree"; tree: TreeView; offX: number; offY: number }
  | { kind: "spawn"; tree: TreeView }
  | { kind: "pan"; startX: number; startY: number; worldX: number; worldY: number }
  | null;

/** Wire the functional core to a Pixi scene: hotbar → spawn, drag → move/snap,
 * auto-reduce on idle (cancelled on touch), plus a pannable/zoomable camera
 * (§5.3, §6). */
export async function mountApp(): Promise<void> {
  const pixi = new Application();
  await pixi.init({ background: 0x0b0f17, resizeTo: window, antialias: true });
  document.body.appendChild(pixi.canvas);

  const world = new Container();
  const ghostLayer = new Container();
  const hud = new Container();
  world.addChild(ghostLayer);
  pixi.stage.addChild(world, hud);

  const ghost = new Graphics();
  ghostLayer.addChild(ghost);

  const trees: TreeView[] = [];
  let drag: Drag = null;
  let snapTarget: TreeView | null = null;

  const hint = new Text({
    text: "drag ι onto the canvas  ·  snap two trees together  ·  they reduce on their own  ·  R clears",
    style: { fontFamily: "monospace", fontSize: 14, fill: 0x6b7a90 },
  });
  hint.position.set(16, 14);
  hud.addChild(hint);

  const legend = makeLegend();
  hud.addChild(legend);

  const toast = new Toast(pixi.ticker);
  hud.addChild(toast.container);

  // ---- discovery (§7): the set of combinators found so far. Drives the
  // behavioural probe (what to still look for) and the masking of transient
  // S/K/I nodes (undiscovered ones render as "?", revealed on discovery). ----
  const discovered = new Set<string>();
  const isDiscovered = (sym: string): boolean => discovered.has(sym);

  // I/K/S reduce by built-in rules; A/X (no rule) carry their ι-tree so the
  // reducer can unfold them. A collapsed node is what a recognised tree becomes.
  const BUILTIN = new Set(["I", "K", "S"]);
  const collapsedNode = (law: Law): Node =>
    comb(law.sym, BUILTIN.has(law.sym) ? undefined : decode(law.iotaCode));

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
    hotbar.addSlot({ glyph: law.sym, spawn: () => collapsedNode(law) });
    for (const t of trees) t.refresh(); // reveal newly-known combinators everywhere
  }

  // ---- auto-reduce on idle (§6.4): each tree, left untouched for a beat,
  // plays itself to normal form one tween at a time; touching it cancels. A
  // per-tree generation token invalidates pending callbacks on cancel. On
  // reaching normal form, probe it for a discovery (§7.1). ----
  const auto = new Map<TreeView, { gen: number; timer: number; steps: number }>();

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
    const gen = a.gen;
    a.timer = window.setTimeout(() => stepAuto(tree, gen), AUTO_DELAY);
  }

  function stepAuto(tree: TreeView, gen: number): void {
    const a = auto.get(tree);
    if (!a || a.gen !== gen) return;
    if (a.steps >= STEP_CAP) return; // still reducing — bail (non-termination guard)
    const next = step(tree.node);
    if (!next) {
      settle(tree); // normal form reached — recognise + collapse to a named node
      return;
    }
    a.steps++;
    tree.animateTo(next, STEP_MS, () => {
      const a2 = auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      a2.timer = window.setTimeout(() => stepAuto(tree, gen), STEP_GAP);
    });
  }

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
  }

  function spawnTree(node: Node, screenX: number, screenY: number): TreeView {
    const w = screenToWorld(screenX, screenY);
    const tree = new TreeView(node, w.x, w.y, pixi.ticker, isDiscovered);
    addTree(tree);
    return tree;
  }

  const hotbar = new Hotbar((slot, e) => {
    hint.visible = false;
    drag = { kind: "spawn", tree: spawnTree(slot.spawn(), e.global.x, e.global.y) };
  }, pixi.ticker);
  hotbar.addSlot({ glyph: "ι", spawn: () => iota() }); // slot 0, always present
  hud.addChild(hotbar.container);

  function onTreeDown(tree: TreeView, e: FederatedPointerEvent): void {
    e.stopPropagation();
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

  pixi.stage.on("pointerdown", (e: FederatedPointerEvent) => {
    if (drag) return; // a tree/slot already claimed this gesture
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
    ghost.moveTo(ax, ay).lineTo(left.rootWorld.x, left.rootWorld.y).stroke({ width: 3, color: FN_EDGE, alpha: 0.7 });
    ghost.moveTo(ax, ay).lineTo(right.rootWorld.x, right.rootWorld.y).stroke({ width: 2.5, color: ARG_EDGE, alpha: 0.7 });
    ghost.circle(ax, ay, 6).fill({ color: 0x6b7a90, alpha: 0.7 });
  }

  function clearGhost(): void {
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
    const merged = new TreeView(root, ax, ay, pixi.ticker, isDiscovered);
    addTree(merged);
    merged.animateAttachFrom(fromWorld, ATTACH_MS); // smooth merge into the app tree
    scheduleAuto(merged); // then it reduces on its own
  }

  // Zoom toward the cursor.
  pixi.canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      const local = world.toLocal({ x: ev.clientX, y: ev.clientY });
      world.scale.set(Math.max(0.2, Math.min(4, world.scale.x * factor)));
      world.position.set(ev.clientX - local.x * world.scale.x, ev.clientY - local.y * world.scale.y);
    },
    { passive: false },
  );

  const placeLegend = () => legend.position.set(16, window.innerHeight - 64);
  placeLegend();

  window.addEventListener("resize", () => {
    fitStage();
    hotbar.layout();
    placeLegend();
    toast.layout();
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
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") clearCanvas();
  });

  // A small key explaining the two edge styles (which child is the function).
  function makeLegend(): Container {
    const c = new Container();
    const g = new Graphics();
    g.moveTo(0, 0).lineTo(26, 0).stroke({ width: 3, color: FN_EDGE });
    g.moveTo(0, 18).lineTo(26, 18).stroke({ width: 2.5, color: ARG_EDGE });
    c.addChild(g);
    const style = { fontFamily: "monospace", fontSize: 12, fill: 0x8a97ad };
    const l1 = new Text({ text: "function (left)", style });
    l1.position.set(34, -7);
    const l2 = new Text({ text: "argument (right)", style });
    l2.position.set(34, 11);
    c.addChild(l1, l2);
    return c;
  }

  // Dev-only test seam (stripped from production builds): expose tree state so
  // an end-to-end driver can assert on spawn/snap/reduce.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    (globalThis as Record<string, unknown>).__combinate = {
      trees,
      sexps: () => trees.map((t) => sexp(t.node)),
      roots: () => trees.map((t) => t.rootWorld),
      discovered: () => [...discovered],
    };
  }
}
