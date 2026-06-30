/**
 * The game-mode input controller (ADR 17): a keyboard/controller state machine over the
 * "regions + hand" model. It owns the discrete game state — which surface the cursor is on (the
 * toolbar or the buckets), the focused bucket, and the held term ("hand") — and turns key intents
 * ({@link keymap}) into scene actions through an injected {@link GameScene}.
 *
 * Buckets are spatial regions on the canvas, NOT explicit slots: an unbounded horizontal strip
 * keyed by a stable integer `k` (world x = k · spacing; k may be negative). You start on bucket 0;
 * arrowing ←/→ pans to the neighbour, and arrowing past an end simply focuses a fresh empty bucket
 * (so "adding a bucket" is implicit). The focused bucket renders bright; its neighbours fade to
 * {@link DIM} — the spatial "there's more ←/→" cue (they peek faded at the screen edges). Each
 * bucket's term is a world-space `TreeView` the scene creates/destroys; this tracks which k holds
 * which + keeps the camera framing the focused one. Mouse input stays fully live; grabbing a bucket
 * tree with the mouse detaches it (see {@link detach}).
 */
import { type Node } from "../core/term";
import { type TreeView } from "./tree";
import { type BucketTray } from "./bucketTray";
import { type Hotbar } from "./hotbar";
import { type Intent } from "./keymap";

const DIM = 0.3; // faded-neighbour opacity (the focused bucket stays at 1)

/** The scene primitives the controller drives (provided by app.ts). */
export interface GameScene {
  hotbar: Hotbar;
  tray: BucketTray;
  /** A fresh term for a toolbar symbol (ι or a collapsed combinator). */
  freshNode: (sym: string) => Node;
  /** A short label for the held badge (the read-out's s-expression / value). */
  labelOf: (node: Node) => string;
  /** World anchor for bucket `k` (a horizontal row; k may be negative). */
  bucketAnchor: (k: number) => { x: number; y: number };
  /** Create a reducing `TreeView` for `node` at a world anchor; focus it. */
  spawnAt: (node: Node, world: { x: number; y: number }) => TreeView;
  /** A dimmed, NON-reducing render of `node` at a world anchor — the held-term preview shown on
   *  the focused bucket while building. Not scheduled/focused/tracked; tear down with {@link unpreview}. */
  preview: (node: Node, world: { x: number; y: number }) => TreeView;
  /** Remove + destroy a preview tree (see {@link preview}). */
  unpreview: (tree: TreeView) => void;
  /** Build `app(fn, arg)` at a world anchor (the factored, non-spatial apply); focus it. */
  applyTerms: (fn: Node, arg: Node, world: { x: number; y: number }, fromWorld?: Map<number, { x: number; y: number }>) => TreeView;
  /** Capture a tree's node world-positions (to glide the merge). */
  captureWorld: (tree: TreeView) => Map<number, { x: number; y: number }>;
  /** Forget + remove + destroy a tree. */
  removeTree: (tree: TreeView) => void;
  /** Centre the camera on a bucket's world x (faded-neighbour framing — neighbours peek at the edges). */
  frameBucketAt: (x: number) => void;
  pan: (dx: number, dy: number) => void;
  zoom: (factor: number) => void;
  setSpeed: (level: number) => void;
  /** The current reduction speed level 0-4 (for the gamepad's Select-cycles). */
  getSpeedLevel: () => number;
  /** Esc with an empty hand opens the menu bar. */
  openMenu: () => void;
  toast: (msg: string) => void;
}

type Hand = { node: Node; label: string; origin: number | null }; // origin = the bucket k it was picked from (for cancel)

export class GameInputController {
  private on = false;
  private zone: "hotbar" | "buckets" = "hotbar";
  private selected = 0; // the focused bucket's stable key k (world x = k · spacing); unbounded, can be negative
  private hand: Hand | null = null;
  private applySide: "left" | "right" = "left"; // when walking onto an occupied bucket: attach the held as fn (left) or arg (right)
  private preview: TreeView | null = null; // the dimmed, non-reducing ghost of the held term on the focused bucket
  private readonly buckets = new Map<number, TreeView>(); // occupied buckets only, keyed by k

  constructor(private readonly scene: GameScene) {}

  get enabled(): boolean {
    return this.on;
  }

  /** Whether a term is currently held (the host keeps the controls' visuals up while holding). */
  get hasHand(): boolean {
    return this.hand !== null;
  }

  /** Game state for the dev seam / E2E (not used by the UI). */
  get debugState(): { enabled: boolean; zone: string; selected: number; hand: string | null; buckets: number[] } {
    return { enabled: this.on, zone: this.zone, selected: this.selected, hand: this.hand?.label ?? null, buckets: [...this.buckets.keys()].sort((a, b) => a - b) };
  }

  /** Show/hide the DEVICE-gated visual — the toolbar's game cursor — and nothing else. The four
   *  controls' visuals are split by what gates each (a device switch must not lurch the camera or
   *  re-dim trees): the cursor is device-gated (here); the held badge is hand-gated (see
   *  {@link render}); the camera framing + the faded-neighbour strip are navigation-gated (see
   *  {@link frameSelected}). So this toggles only the cursor, un-fades on the way out, and lets the
   *  badge follow the hand — it never frames a bucket. Build state (zone/selected/hand) is preserved. */
  setEnabled(on: boolean): void {
    this.on = on;
    if (on) {
      this.scene.hotbar.setGameCursor(this.zone === "hotbar" ? 0 : null);
      this.renderPreview(); // re-show the held ghost if we re-enter mid-build (no-op when empty-handed)
    } else {
      this.scene.hotbar.setGameCursor(null);
      this.applyFade(true); // restore full opacity when the keyboard/pad cursor leaves
      this.clearPreview(); // a device switch / 3D entry must never strand a preview ghost
    }
    this.render(); // the held badge follows the hand (device-agnostic); 3D entry hides it explicitly
  }

  /** A bucket tree was grabbed/removed by the mouse — release the slot (the one desync rule). */
  detach(tree: TreeView): void {
    for (const [k, t] of this.buckets) {
      if (t === tree) {
        t.container.alpha = 1; // it's leaving the faded-neighbour strip — restore full opacity
        this.buckets.delete(k);
        if (this.on) this.render();
        return;
      }
    }
  }

  // ---- the input sink (ADR 17): the same intents, plus analog pan/zoom + a speed cycle. These
  // ALWAYS act (they're only ever called in 2D); the `on` flag gates VISUALS, not actions — it
  // must, since the gamepad layer fires dispatch before note(), so `on` may still be stale here. ----
  /** Fire a discrete intent (move/page/pick/apply/cancel). */
  trigger(intent: Intent): void {
    this.dispatch(intent, "");
  }
  /** Pan the camera by a (world-space) delta — the right stick, magnitude-scaled. */
  panBy(dx: number, dy: number): void {
    this.scene.pan(dx, dy);
  }
  /** Zoom the camera by a factor — the triggers, time-scaled. */
  zoomBy(factor: number): void {
    this.scene.zoom(factor);
  }
  /** Cycle the reduction speed 0→1→2→3→4→0 (the Select button). */
  cycleSpeed(): void {
    this.scene.setSpeed((this.scene.getSpeedLevel() + 1) % 5);
  }

  private dispatch(intent: Intent, key: string): void {
    // While holding, the inputs change meaning (ADR 17 redesign): ←/→ WALK the held term along the
    // strip (and flip the apply side on an occupied bucket), Space COMMITS it, Esc DROPS it, and ↑/↓
    // are ignored (no escaping back to the hotbar mid-carry). Empty-handed, they navigate as before.
    if (this.hand) {
      switch (intent) {
        case "moveLeft":
          return this.walk(-1);
        case "moveRight":
          return this.walk(1);
        case "moveUp":
        case "moveDown":
          return; // holding: no returning to the hotbar
        case "pickPlace":
          return this.commit();
        case "cancel":
          return this.drop();
      }
    }
    switch (intent) {
      case "moveLeft":
        return this.move(-1);
      case "moveRight":
        return this.move(1);
      case "moveUp":
        return this.toZone("hotbar");
      case "moveDown":
        return this.toZone("buckets");
      case "pagePrev":
        return this.page(-1);
      case "pageNext":
        return this.page(1);
      case "pickPlace":
        return this.pickPlace();
      case "applyFn":
        return this.apply(true);
      case "applyArg":
        return this.apply(false);
      case "cancel":
        return this.cancel();
      case "speed":
        return this.scene.setSpeed(parseInt(key, 10));
    }
  }

  // ---- navigation ----
  private move(d: number): void {
    if (this.zone === "hotbar") {
      // d-pad/arrows page the toolbar by pushing past its edge (the gamepad has no spare
      // button for paging, ADR 17); otherwise step the cursor within the page.
      const i = this.scene.hotbar.gameCursorIndex();
      const n = this.scene.hotbar.visibleSyms().length;
      if (d < 0 && i <= 0) this.scene.hotbar.cycleTab(-1);
      else if (d > 0 && n > 0 && i >= n - 1) this.scene.hotbar.cycleTab(1);
      else this.scene.hotbar.moveGameCursor(d);
    } else {
      this.selected += d; // unbounded — arrowing past the end focuses a fresh empty bucket
      this.frameSelected();
    }
    this.render();
  }
  private toZone(zone: "hotbar" | "buckets"): void {
    this.zone = zone;
    this.scene.hotbar.setGameCursor(zone === "hotbar" ? 0 : null);
    if (zone === "buckets") this.frameSelected();
    this.render();
  }
  private page(d: number): void {
    this.scene.hotbar.cycleTab(d);
    if (this.zone !== "hotbar") this.toZone("hotbar");
    else this.render();
  }
  // Frame the focused bucket (camera centres on it; neighbours peek faded) + refresh the fade.
  private frameSelected(): void {
    this.scene.frameBucketAt(this.scene.bucketAnchor(this.selected).x);
    this.applyFade();
  }

  /** Walk the held term one step along the strip (←/→ WHILE HOLDING). On an occupied bucket we first
   *  flip the apply side (so → reads as "attach to the right" before advancing past it, and ← as
   *  "attach to the left"); otherwise we step to the neighbouring bucket and re-frame. The preview
   *  ghost follows. `d` is +1 (right) or -1 (left). */
  private walk(d: number): void {
    const occupied = this.buckets.has(this.selected);
    if (d > 0) {
      if (occupied && this.applySide === "left") this.applySide = "right";
      else {
        this.selected += 1;
        this.applySide = "left";
        this.frameSelected();
      }
    } else {
      if (occupied && this.applySide === "right") this.applySide = "left";
      else {
        this.selected -= 1;
        this.applySide = this.buckets.has(this.selected) ? "right" : "left"; // entering from the right of an occupied bucket
        this.frameSelected();
      }
    }
    this.renderPreview();
  }

  // ---- pick up (empty-handed Space): from the toolbar or from a bucket. Picking up enters the
  // bucket strip and raises the held ghost; from there ←/→ walk it and Space commits it. ----
  private pickPlace(): void {
    if (this.zone === "hotbar") return this.pickFromHotbar();
    if (this.buckets.has(this.selected)) this.pickFromBucket(this.selected); // pick up the bucket's term (a move)
  }
  private pickFromHotbar(): void {
    const sym = this.scene.hotbar.gameCursorSym();
    if (!sym) return;
    const node = this.scene.freshNode(sym);
    this.hand = { node, label: this.scene.labelOf(node), origin: null };
    this.applySide = "left";
    this.toZone("buckets"); // leave the hotbar to carry it over the strip
    this.renderPreview();
    this.render();
  }
  private pickFromBucket(k: number): void {
    const t = this.buckets.get(k)!;
    this.hand = { node: t.node, label: this.scene.labelOf(t.node), origin: k };
    this.applySide = "left";
    this.scene.removeTree(t);
    this.buckets.delete(k);
    this.renderPreview();
    this.render();
  }
  private placeHand(k: number): void {
    const h = this.hand!;
    this.buckets.set(k, this.scene.spawnAt(h.node, this.scene.bucketAnchor(k)));
    this.hand = null;
    this.frameSelected();
    this.render();
  }

  // ---- commit / drop the held term (Space / Esc WHILE HOLDING) ----
  /** Space while holding: place the held term into the focused bucket if it's empty, else APPLY it
   *  to the bucket's tree on the current side (left = held is the function, right = the argument).
   *  placeHand/apply both null the hand and re-frame; we then reset the side and tear down the ghost. */
  private commit(): void {
    if (this.buckets.has(this.selected)) this.apply(this.applySide === "left");
    else this.placeHand(this.selected);
    this.applySide = "left";
    this.clearPreview();
  }
  /** Esc while holding: drop the held term — restore a bucket-origin term to its bucket (the cancel
   *  hand-restore), then tear down the ghost and reset the side. (Empty-handed, Esc opens the menu.) */
  private drop(): void {
    this.cancel(); // restores a bucket-origin term + nulls the hand + renders
    this.applySide = "left";
    this.clearPreview();
  }

  // ---- apply the held term to the focused bucket's tree (commit, left = fn / right = arg) ----
  private apply(asFn: boolean): void {
    if (this.zone !== "buckets" || !this.hand) return;
    const k = this.selected;
    const t = this.buckets.get(k);
    if (!t) return this.scene.toast("empty bucket — Space to place the held term");
    const held = this.hand.node;
    const bucketNode = t.node;
    const from = this.scene.captureWorld(t);
    this.scene.removeTree(t);
    const merged = asFn
      ? this.scene.applyTerms(held, bucketNode, this.scene.bucketAnchor(k), from) // held is the function
      : this.scene.applyTerms(bucketNode, held, this.scene.bucketAnchor(k), from); // held is the argument
    this.buckets.set(k, merged);
    this.hand = null;
    this.frameSelected();
    this.render();
  }

  // ---- cancel (Esc / the B button): empty-handed it opens the menu; the held-hand restore is
  // reused by drop() to put a bucket-origin term back. ----
  private cancel(): void {
    if (!this.hand) return this.scene.openMenu();
    const h = this.hand;
    this.hand = null;
    if (h.origin !== null && !this.buckets.has(h.origin)) {
      // restore a term picked up from a bucket
      this.buckets.set(h.origin, this.scene.spawnAt(h.node, this.scene.bucketAnchor(h.origin)));
    }
    this.render();
  }

  // ---- view sync: the HAND-gated held badge (device-agnostic; the faded strip is applied
  // separately, from navigation, in applyFade) ----
  private render(): void {
    const label = this.hand?.label ?? null;
    if (label) this.scene.tray.show();
    else this.scene.tray.hide();
    this.scene.tray.setHand(label);
  }
  /** Focused bucket bright, the rest faded — the spatial cue. NAVIGATION-gated (called from
   *  {@link frameSelected}); `restore` = all bright (the keyboard/pad cursor left, or 3D entry). */
  private applyFade(restore = false): void {
    for (const [k, t] of this.buckets) t.container.alpha = restore || k === this.selected ? 1 : DIM;
  }

  // ---- the held-term preview: a dimmed, non-reducing ghost of the held node ON the focused bucket,
  // so "what you're about to build" reads directly in place. Exists only while holding (keyboard/pad
  // only), so it's already device-gated; setEnabled/3D-entry tear it down so it can't linger. ----
  /** (Re)draw the preview ghost on the focused bucket: at the anchor when empty, else offset to the
   *  apply side so it reads as attaching left (fn) / right (arg) of the bucket's existing tree. */
  private renderPreview(): void {
    this.clearPreview();
    if (!this.hand) return;
    const a = this.scene.bucketAnchor(this.selected);
    const pos = this.buckets.has(this.selected) ? { x: a.x + (this.applySide === "left" ? -140 : 140), y: a.y - 90 } : a;
    this.preview = this.scene.preview(this.hand.node, pos);
    this.preview.container.alpha = 0.5; // dimmed — it's a ghost, not a placed tree
  }
  /** Tear down the preview ghost (no-op if none). */
  private clearPreview(): void {
    if (this.preview) {
      this.scene.unpreview(this.preview);
      this.preview = null;
    }
  }
}
