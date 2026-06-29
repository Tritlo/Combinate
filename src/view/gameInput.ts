/**
 * The game-mode input controller (ADR 17): a keyboard/controller state machine over the
 * "register tray + hand" model. It owns the discrete game state — which surface the cursor is
 * on (the toolbar or the buckets), the selected bucket, and the held term ("hand") — and turns
 * key intents ({@link keymap}) into scene actions through an injected {@link GameScene}. The
 * buckets' actual terms are world-space `TreeView`s the scene creates/destroys; this just
 * tracks which slot holds which, mirrors it into the {@link BucketTray}, and keeps the camera
 * framing the selected bucket. Mouse input stays fully live; grabbing a bucket tree with the
 * mouse detaches it (see {@link detach}).
 */
import { type Node } from "../core/term";
import { type TreeView } from "./tree";
import { type BucketTray, type TrayState } from "./bucketTray";
import { type Hotbar } from "./hotbar";
import { intentForKey, type Intent } from "./keymap";

const N_BUCKETS = 5;
const ZOOM_STEP = 1.12;
const PAN_STEP = 90; // world px per pan key

/** The scene primitives the controller drives (provided by app.ts). */
export interface GameScene {
  hotbar: Hotbar;
  tray: BucketTray;
  /** A fresh term for a toolbar symbol (ι or a collapsed combinator). */
  freshNode: (sym: string) => Node;
  /** A short label for the tray/hand (the read-out's s-expression / value). */
  labelOf: (node: Node) => string;
  /** World anchor for bucket `i` (a horizontal row). */
  bucketAnchor: (i: number) => { x: number; y: number };
  /** Create a reducing `TreeView` for `node` at a world anchor; focus it. */
  spawnAt: (node: Node, world: { x: number; y: number }) => TreeView;
  /** Build `app(fn, arg)` at a world anchor (the factored, non-spatial apply); focus it. */
  applyTerms: (fn: Node, arg: Node, world: { x: number; y: number }, fromWorld?: Map<number, { x: number; y: number }>) => TreeView;
  /** Capture a tree's node world-positions (to glide the merge). */
  captureWorld: (tree: TreeView) => Map<number, { x: number; y: number }>;
  /** Forget + remove + destroy a tree. */
  removeTree: (tree: TreeView) => void;
  /** Frame a tree to fill the viewport. */
  fit: (tree: TreeView) => void;
  pan: (dx: number, dy: number) => void;
  zoom: (factor: number) => void;
  setSpeed: (level: number) => void;
  /** Esc with an empty hand opens the menu bar. */
  openMenu: () => void;
  toast: (msg: string) => void;
}

type Hand = { node: Node; label: string; origin: number | null }; // origin = the bucket it was picked from (for cancel)

export class GameInputController {
  private on = false;
  private zone: "hotbar" | "buckets" = "hotbar";
  private selected = 0;
  private hand: Hand | null = null;
  private readonly buckets: (TreeView | null)[] = Array(N_BUCKETS).fill(null);

  constructor(private readonly scene: GameScene) {}

  get enabled(): boolean {
    return this.on;
  }

  /** Game state for the dev seam / E2E (not used by the UI). */
  get debugState(): { enabled: boolean; zone: string; selected: number; hand: string | null; buckets: boolean[] } {
    return { enabled: this.on, zone: this.zone, selected: this.selected, hand: this.hand?.label ?? null, buckets: this.buckets.map((b) => !!b) };
  }

  /** Turn game mode on/off: show/hide the tray + the toolbar cursor. */
  setEnabled(on: boolean): void {
    this.on = on;
    if (on) {
      this.zone = "hotbar";
      this.scene.hotbar.setGameCursor(0);
      this.scene.tray.show();
      this.render();
    } else {
      this.scene.hotbar.setGameCursor(null);
      this.scene.tray.hide();
    }
  }

  /** A bucket tree was grabbed/removed by the mouse — release the slot (the one desync rule). */
  detach(tree: TreeView): void {
    const i = this.buckets.indexOf(tree);
    if (i >= 0) {
      this.buckets[i] = null;
      if (this.on) this.render();
    }
  }

  /** Handle a keydown in game mode. Returns true if consumed (caller preventDefaults). */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.on) return false;
    const intent = intentForKey(e.key);
    if (!intent) return false;
    this.dispatch(intent, e.key);
    return true;
  }

  private dispatch(intent: Intent, key: string): void {
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
      case "panUp":
        return this.scene.pan(0, PAN_STEP);
      case "panDown":
        return this.scene.pan(0, -PAN_STEP);
      case "panLeft":
        return this.scene.pan(PAN_STEP, 0);
      case "panRight":
        return this.scene.pan(-PAN_STEP, 0);
      case "zoomIn":
        return this.scene.zoom(ZOOM_STEP);
      case "zoomOut":
        return this.scene.zoom(1 / ZOOM_STEP);
      case "speed":
        return this.scene.setSpeed(parseInt(key, 10));
    }
  }

  // ---- navigation ----
  private move(d: number): void {
    if (this.zone === "hotbar") {
      this.scene.hotbar.moveGameCursor(d);
    } else {
      this.selected = Math.max(0, Math.min(N_BUCKETS - 1, this.selected + d));
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
  // Frame the selected bucket's tree (camera follows the selection).
  private frameSelected(): void {
    const t = this.buckets[this.selected];
    if (t) this.scene.fit(t);
  }

  // ---- pick / place / drop (the A button) ----
  private pickPlace(): void {
    if (this.zone === "hotbar") return this.pickFromHotbar();
    const t = this.buckets[this.selected];
    if (this.hand) {
      if (!t) this.placeHand(this.selected); // into an empty bucket
      else this.scene.toast("bucket full — Q/E to apply, or pick an empty bucket");
    } else if (t) {
      this.pickFromBucket(this.selected); // pick up the term (a move)
    }
  }
  private pickFromHotbar(): void {
    if (this.hand) return this.scene.toast("already holding — place it (↓) or cancel (Esc)");
    const sym = this.scene.hotbar.gameCursorSym();
    if (!sym) return;
    const node = this.scene.freshNode(sym);
    this.hand = { node, label: this.scene.labelOf(node), origin: null };
    this.render();
  }
  private pickFromBucket(i: number): void {
    const t = this.buckets[i]!;
    this.hand = { node: t.node, label: this.scene.labelOf(t.node), origin: i };
    this.scene.removeTree(t);
    this.buckets[i] = null;
    this.render();
  }
  private placeHand(i: number): void {
    const h = this.hand!;
    this.buckets[i] = this.scene.spawnAt(h.node, this.scene.bucketAnchor(i));
    this.hand = null;
    this.frameSelected();
    this.render();
  }

  // ---- apply held term into the selected bucket (X = fn, Y = arg) ----
  private apply(asFn: boolean): void {
    if (this.zone !== "buckets" || !this.hand) return;
    const i = this.selected;
    const t = this.buckets[i];
    if (!t) return this.scene.toast("empty bucket — Space to place the held term");
    const held = this.hand.node;
    const bucketNode = t.node;
    const from = this.scene.captureWorld(t);
    this.scene.removeTree(t);
    const merged = asFn
      ? this.scene.applyTerms(held, bucketNode, this.scene.bucketAnchor(i), from) // held is the function
      : this.scene.applyTerms(bucketNode, held, this.scene.bucketAnchor(i), from); // held is the argument
    this.buckets[i] = merged;
    this.hand = null;
    this.scene.fit(merged);
    this.render();
  }

  // ---- cancel (the B button / Esc) ----
  private cancel(): void {
    if (!this.hand) return this.scene.openMenu();
    const h = this.hand;
    this.hand = null;
    if (h.origin !== null && !this.buckets[h.origin]) {
      // restore a term picked up from a bucket
      this.buckets[h.origin] = this.scene.spawnAt(h.node, this.scene.bucketAnchor(h.origin));
    }
    this.render();
  }

  // ---- tray mirror ----
  private render(): void {
    const state: TrayState = {
      buckets: this.buckets.map((t) => (t ? this.scene.labelOf(t.node) : null)),
      selected: this.selected,
      zone: this.zone,
      hand: this.hand?.label ?? null,
      hint: this.hint(),
    };
    this.scene.tray.render(state);
  }
  private hint(): string {
    if (this.zone === "hotbar") {
      return this.hand ? "✋ holding · ↓ to a bucket to place · Esc cancel" : "← → choose · Space hold · ↓ buckets · [ ] page";
    }
    const occupied = !!this.buckets[this.selected];
    if (this.hand) return occupied ? "Q apply as fn (left) · E apply as arg (right) · Esc cancel" : "Space place here · ← → move · Esc cancel";
    return occupied ? "Space pick up · ← → move · ↑ toolbar · 0-4 speed" : "← → move · ↑ toolbar to grab a combinator";
  }
}
