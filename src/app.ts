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
import { TreeView } from "./view/tree";
import { Hotbar } from "./view/hotbar";

const SNAP_R = 72; // world-space snap radius between two tree root anchors (~1.3·XS)
const TAP_MOVE = 6; // px of pointer travel below which a tree gesture counts as a tap

type Drag =
  | { kind: "tree"; tree: TreeView; offX: number; offY: number; startX: number; startY: number; moved: boolean }
  | { kind: "spawn"; tree: TreeView }
  | { kind: "pan"; startX: number; startY: number; worldX: number; worldY: number }
  | null;

/** Wire the functional core to a Pixi scene: hotbar → spawn, drag → move/snap,
 * tap → single-step reduce, plus a pannable/zoomable world camera (§5.3, §6). */
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
    text: "drag ι onto the canvas  ·  snap two trees together  ·  tap a tree to reduce",
    style: { fontFamily: "monospace", fontSize: 14, fill: 0x6b7a90 },
  });
  hint.position.set(16, 14);
  hud.addChild(hint);

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
    const tree = new TreeView(iota(), w.x, w.y);
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
    const w = screenToWorld(e.global.x, e.global.y);
    world.addChild(tree.container); // bring to front
    drag = {
      kind: "tree",
      tree,
      offX: tree.container.position.x - w.x,
      offY: tree.container.position.y - w.y,
      startX: e.global.x,
      startY: e.global.y,
      moved: false,
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
      if (Math.abs(e.global.x - drag.startX) + Math.abs(e.global.y - drag.startY) > TAP_MOVE) {
        drag.moved = true;
      }
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
      } else if (drag.kind === "tree" && !drag.moved) {
        const next = step(tree.node); // tap → one leftmost-outermost step
        if (next) tree.setNode(next);
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
      trees.splice(trees.indexOf(old), 1);
      old.destroy();
    }
    addTree(new TreeView(root, ax, ay));
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

  window.addEventListener("resize", () => {
    fitStage();
    hotbar.layout();
  });

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
