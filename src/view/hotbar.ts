import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text, type Ticker } from "pixi.js";
import { type Node } from "../core/term";
import { tween } from "./anim";

const SLOT = 56;
const GAP = 10;
const MARGIN = 80; // keep the row clear of the screen edges
const ARROW = 30; // width of a ◀ / ▶ page button

/** A hotbar entry: a glyph and a factory for the tree it stamps onto the canvas. */
export interface Slot {
  glyph: string;
  spawn: () => Node;
}

/**
 * The Minecraft-style hotbar (§8.1), bottom-centre in screen space. Slot 0 is ι
 * (always pinned at the left); discovered laws append slots that stamp their
 * canonical ι-tree (§7.3). The combinator slots are paginated with ◀ / ▶ once
 * there are more than fit in one row. Dragging *out* of a slot spawns.
 */
export class Hotbar {
  readonly container = new Container();
  private readonly views: Container[] = [];
  private readonly prevBtn: Container;
  private readonly nextBtn: Container;
  private readonly pageLabel = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 12, fill: 0x8a97ad } });
  private page = 0;

  constructor(
    private readonly onSpawnStart: (slot: Slot, e: FederatedPointerEvent) => void,
    private readonly ticker: Ticker,
  ) {
    this.prevBtn = this.makeArrow("‹", () => this.flip(-1));
    this.nextBtn = this.makeArrow("›", () => this.flip(1));
    this.pageLabel.anchor.set(0.5);
    this.container.addChild(this.prevBtn, this.nextBtn, this.pageLabel);
  }

  addSlot(slot: Slot): void {
    const isIota = this.views.length === 0;
    const accent = isIota ? 0xffe08a : 0x9fc0ff;
    const view = new Container();
    view.addChild(
      new Graphics()
        .roundRect(-SLOT / 2, -SLOT / 2, SLOT, SLOT, 8)
        .fill({ color: 0x1a2233 })
        .stroke({ width: 2, color: accent }),
    );
    const glyph = new Text({ text: slot.glyph, style: { fontFamily: "monospace", fontSize: 24, fill: accent } });
    glyph.anchor.set(0.5);
    const maxW = SLOT - 10; // shrink long glyphs (e.g. "Succ") to fit the slot
    if (glyph.width > maxW) glyph.scale.set(maxW / glyph.width);
    view.addChild(glyph);

    view.eventMode = "static";
    view.cursor = "grab";
    view.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.onSpawnStart(slot, e);
    });

    this.container.addChild(view);
    this.views.push(view);
    this.page = Number.MAX_SAFE_INTEGER; // jump to the last page so the new slot is shown
    this.layout();

    // pop in (the new slot is on the now-current last page, so it's visible)
    view.scale.set(0.2);
    tween(this.ticker, 260, (t) => view.scale.set(0.2 + 0.8 * t));
  }

  /** Combinator slots (excluding ι) that fit in one row at the current width. */
  private pageSize(): number {
    const avail = window.innerWidth - 2 * MARGIN - SLOT - 2 * (ARROW + GAP) - GAP;
    return Math.max(1, Math.floor((avail + GAP) / (SLOT + GAP)));
  }

  private flip(delta: number): void {
    this.page += delta; // layout() clamps to the valid range
    this.layout();
  }

  /** Pin ι at the left; show one page of combinator slots, flanked by ◀ / ▶. */
  layout(): void {
    const n = this.views.length;
    const y = window.innerHeight - SLOT;
    const ps = this.pageSize();
    const combs = n - 1; // slots after ι
    const pageCount = Math.max(1, Math.ceil(combs / ps));
    this.page = Math.max(0, Math.min(this.page, pageCount - 1));
    const paged = pageCount > 1;
    const start = 1 + this.page * ps;
    const end = Math.min(n, start + ps);

    for (let i = 1; i < n; i++) this.views[i].visible = i >= start && i < end;
    this.prevBtn.visible = this.nextBtn.visible = this.pageLabel.visible = paged;

    // ordered row: ι, [◀], this page's slots, [▶]
    const row: Array<{ w: number; node: Container }> = [{ w: SLOT, node: this.views[0] }];
    if (paged) row.push({ w: ARROW, node: this.prevBtn });
    for (let i = start; i < end; i++) row.push({ w: SLOT, node: this.views[i] });
    if (paged) row.push({ w: ARROW, node: this.nextBtn });

    const total = row.reduce((s, it) => s + it.w, 0) + GAP * (row.length - 1);
    let left = window.innerWidth / 2 - total / 2;
    for (const it of row) {
      it.node.position.set(left + it.w / 2, y);
      left += it.w + GAP;
    }

    if (paged) {
      this.prevBtn.alpha = this.page > 0 ? 1 : 0.3;
      this.nextBtn.alpha = this.page < pageCount - 1 ? 1 : 0.3;
      this.pageLabel.text = `${this.page + 1}/${pageCount}`;
      this.pageLabel.position.set(window.innerWidth / 2, y - SLOT / 2 - 12);
    }
  }

  private makeArrow(label: string, onClick: () => void): Container {
    const c = new Container();
    const t = new Text({ text: label, style: { fontFamily: "monospace", fontSize: 30, fill: 0x9fc0ff } });
    t.anchor.set(0.5);
    c.addChild(t);
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new Rectangle(-ARROW / 2, -SLOT / 2, ARROW, SLOT);
    c.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      onClick();
    });
    return c;
  }
}
