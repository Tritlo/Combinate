/**
 * DragController — the pointer-drag FSM for the 2D workspace: carrying a spawned/grabbed tree, the
 * camera pan, and the snap-to-apply preview. It owns the `drag` state machine + the nearest-root snap
 * search + the `snapTarget`, and reports semantic OUTCOMES (snap-apply / drop-free) for the shell to
 * commit. It does NOT own trees, focus, tree birth/death, reduction, or the ghost's *rendering* —
 * those stay in mountApp.
 *
 * The shell decides which interactions reach here (it never calls these while the 3D view is open or
 * a pinch gesture is active) and calls {@link DragController.cancel} when such a mode takes over.
 */
import { type TreeView } from "./tree";
import { type Camera } from "./camera";

const SNAP_R = 72; // world-space snap radius between two tree root anchors (~1.3·XS)

type Drag =
  | { kind: "tree"; tree: TreeView; offX: number; offY: number }
  | { kind: "spawn"; tree: TreeView }
  | { kind: "pan"; startX: number; startY: number; worldX: number; worldY: number }
  | null;

/** What a drop resolves to — the shell commits it (apply two trees, or let a freely-placed tree reduce). */
export type DropOutcome =
  | { kind: "snapApply"; dragged: TreeView; target: TreeView }
  | { kind: "dropFree"; tree: TreeView }
  | { kind: "none" };

export interface DragControllerDeps {
  camera: Camera;
  /** Live view of the current trees, for the snap search (read-only). */
  trees: () => readonly TreeView[];
  /** Render the snap preview between the dragged tree and its (nullable) target. */
  drawGhost: (dragged: TreeView, target: TreeView | null) => void;
  /** Clear the snap-preview graphics. */
  clearGhost: () => void;
}

export class DragController {
  private drag: Drag = null;
  private snapTarget: TreeView | null = null;

  constructor(private readonly deps: DragControllerDeps) {}

  /** Carrying a to-be-placed tree (a hotbar grab / copy / a grabbed existing tree) — not a camera pan. */
  carrying(): boolean {
    return this.drag !== null && this.drag.kind !== "pan";
  }
  /** Any drag in progress (carry / grabbed tree / camera pan). */
  active(): boolean {
    return this.drag !== null;
  }

  /** Begin carrying a freshly spawned/copied tree (the shell already spawned it + made it passive). */
  carry(tree: TreeView): void {
    this.drag = { kind: "spawn", tree };
  }
  /** Begin dragging an existing tree the user grabbed (shell already focused + raised it to the front). */
  grab(tree: TreeView, screenX: number, screenY: number): void {
    const w = this.deps.camera.screenToWorld(screenX, screenY);
    this.drag = { kind: "tree", tree, offX: tree.container.position.x - w.x, offY: tree.container.position.y - w.y };
  }
  /** Begin a camera pan from a stage press. */
  beginPan(screenX: number, screenY: number): void {
    const t = this.deps.camera.transform();
    this.drag = { kind: "pan", startX: screenX, startY: screenY, worldX: t.x, worldY: t.y };
  }

  /** Pointer move: pan the camera, or move the carried/grabbed tree and refresh the snap preview. No-op when idle. */
  moveTo(screenX: number, screenY: number): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === "pan") {
      this.deps.camera.moveTo(drag.worldX + (screenX - drag.startX), drag.worldY + (screenY - drag.startY));
      return;
    }
    const w = this.deps.camera.screenToWorld(screenX, screenY);
    if (drag.kind === "tree") drag.tree.container.position.set(w.x + drag.offX, w.y + drag.offY);
    else drag.tree.container.position.set(w.x, w.y);
    this.updateSnap(drag.tree);
  }

  /** Drop the carried tree (2nd click of the carry model): apply to `target` (or the snap target), else
   *  drop it free. Returns the outcome for the shell to commit. No-op during a pan. */
  drop(target?: TreeView): DropOutcome {
    const drag = this.drag;
    if (!drag || drag.kind === "pan") return { kind: "none" };
    const tree = drag.tree;
    const tgt = target ?? this.snapTarget;
    this.deps.clearGhost();
    this.snapTarget = null;
    this.drag = null;
    return tgt && tgt !== tree ? { kind: "snapApply", dragged: tree, target: tgt } : { kind: "dropFree", tree };
  }

  /** End a camera pan (pointerup); a carried tree keeps following until the next click. */
  endPan(): void {
    if (this.drag?.kind === "pan") this.drag = null;
  }

  /** Drop everything without committing — the shell calls this when a pinch / 3D view / canvas-clear takes over. */
  cancel(): void {
    this.deps.clearGhost();
    this.snapTarget = null;
    this.drag = null;
  }

  /** Nearest other-tree root within SNAP_R becomes the snap target; refresh the preview. */
  private updateSnap(dragged: TreeView): void {
    let best: TreeView | null = null;
    let bestDist = SNAP_R;
    for (const other of this.deps.trees()) {
      if (other === dragged) continue;
      const d = Math.hypot(other.rootWorld.x - dragged.rootWorld.x, other.rootWorld.y - dragged.rootWorld.y);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    this.snapTarget = best;
    this.deps.drawGhost(dragged, best);
  }
}
