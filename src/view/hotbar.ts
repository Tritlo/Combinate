import { Container, type FederatedPointerEvent, Graphics, Text, type Ticker } from "pixi.js";
import { type Node } from "../core/term";
import { tween } from "./anim";

const SLOT = 56;
const GAP = 10;
const MARGIN = 80; // keep the row clear of the screen edges

/** A hotbar entry: a glyph and a factory for the tree it stamps onto the canvas. */
export interface Slot {
  glyph: string;
  spawn: () => Node;
}

/**
 * The Minecraft-style hotbar (§8.1), bottom-centre in screen space. Slot 0 is ι
 * (always present); discovered laws append slots that stamp their canonical
 * ι-tree (§7.3). Dragging *out* of a slot spawns, via {@link onSpawnStart}.
 */
export class Hotbar {
  readonly container = new Container();
  private readonly views: Container[] = [];

  constructor(
    private readonly onSpawnStart: (slot: Slot, e: FederatedPointerEvent) => void,
    private readonly ticker: Ticker,
  ) {}

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
    view.addChild(glyph);

    view.eventMode = "static";
    view.cursor = "grab";
    view.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.onSpawnStart(slot, e);
    });

    this.container.addChild(view);
    this.views.push(view);
    this.layout();

    // pop in
    view.scale.set(0.2);
    tween(this.ticker, 260, (t) => view.scale.set(0.2 + 0.8 * t));
  }

  /** Lay out the slots in centred rows at the bottom of the screen, wrapping to
   *  rows that stack upward as the inventory grows (slot 0 = ι stays bottom-left). */
  layout(): void {
    const n = this.views.length;
    const perRow = Math.max(1, Math.floor((window.innerWidth - 2 * MARGIN + GAP) / (SLOT + GAP)));
    this.views.forEach((view, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, n - row * perRow);
      const rowW = inRow * SLOT + (inRow - 1) * GAP;
      const startX = window.innerWidth / 2 - rowW / 2 + SLOT / 2;
      const x = startX + col * (SLOT + GAP);
      const y = window.innerHeight - SLOT - row * (SLOT + GAP); // row 0 (ι) at the bottom, rows grow up
      view.position.set(x, y);
    });
  }
}
