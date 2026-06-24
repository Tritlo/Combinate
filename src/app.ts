import {
  Application,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Rectangle,
  Text,
} from "pixi.js";
import { app as mkApp, iota, sexp } from "./core/term";
import { step } from "./core/reduce";
import { TreeView, FN_EDGE, ARG_EDGE } from "./view/tree";
import { Hotbar } from "./view/hotbar";

const SNAP_R = 72; // world-space snap radius between two tree root anchors (~1.3·XS)
const AUTO_DELAY = 450; // ms a tree must sit untouched before it starts reducing (§6.4)
const STEP_MS = 300; // duration of one reduction-step tween
const STEP_GAP = 130; // pause between reduction steps

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
    text: "drag ι onto the canvas  ·  snap two trees together  ·  they reduce on their own",
    style: { fontFamily: "monospace", fontSize: 14, fill: 0x6b7a90 },
  });
  hint.position.set(16, 14);
  hud.addChild(hint);

  const legend = makeLegend();
  hud.addChild(legend);

  // ---- auto-reduce on idle (§6.4): each tree, left untouched for a beat,
  // plays itself to normal form one tween at a time; touching it cancels. A
  // per-tree generation token invalidates pending callbacks on cancel. ----
  const auto = new Map<TreeView, { gen: number; timer: number }>();

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
      a = { gen: 0, timer: 0 };
      auto.set(tree, a);
    }
    a.gen++;
    const gen = a.gen;
    a.timer = window.setTimeout(() => stepAuto(tree, gen), AUTO_DELAY);
  }

  function stepAuto(tree: TreeView, gen: number): void {
    const a = auto.get(tree);
    if (!a || a.gen !== gen) return;
    const next = step(tree.node);
    if (!next) return; // normal form — rest
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

  function spawnIota(screenX: number, screenY: number): TreeView {
    const w = screenToWorld(screenX, screenY);
    const tree = new TreeView(iota(), w.x, w.y, pixi.ticker);
    addTree(tree);
    return tree;
  }

  const hotbar = new Hotbar((e) => {
    hint.visible = false;
    drag = { kind: "spawn", tree: spawnIota(e.global.x, e.global.y) };
  });
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

  function drawGhost(dragged: TreeView, target: TreeView | null): void {
    ghost.clear();
    if (!target) return;
    const ax = (dragged.rootWorld.x + target.rootWorld.x) / 2;
    const ay = Math.min(dragged.rootWorld.y, target.rootWorld.y) - 56;
    ghost
      .moveTo(ax, ay)
      .lineTo(dragged.rootWorld.x, dragged.rootWorld.y)
      .moveTo(ax, ay)
      .lineTo(target.rootWorld.x, target.rootWorld.y)
      .stroke({ width: 2, color: 0xffffff, alpha: 0.4 });
    ghost.circle(ax, ay, 6).fill({ color: 0xffffff, alpha: 0.5 });
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
    for (const old of [dragged, target]) {
      cancelAuto(old);
      auto.delete(old);
      trees.splice(trees.indexOf(old), 1);
      old.destroy();
    }
    const merged = new TreeView(root, ax, ay, pixi.ticker);
    addTree(merged);
    scheduleAuto(merged); // the new application reduces on its own
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
  });

  // A small key explaining the two edge styles (which child is the function).
  function makeLegend(): Container {
    const c = new Container();
    const g = new Graphics();
    g.moveTo(0, 0).lineTo(26, 0).stroke({ width: 3, color: FN_EDGE });
    g.moveTo(0, 18).lineTo(26, 18).stroke({ width: 1.5, color: ARG_EDGE });
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
    };
  }
}
