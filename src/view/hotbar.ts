import { Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";

const SLOT = 56;

/**
 * The Minecraft-style hotbar (§8.1). Phase 0: a single ι slot, bottom-centre, in
 * screen space (HUD, not world). Dragging *out* of the slot spawns an ι — the
 * app wires that via {@link onSpawnStart}, fired on pointerdown over the slot.
 */
export class Hotbar {
  readonly container = new Container();
  private readonly slot = new Container();

  constructor(private readonly onSpawnStart: (e: FederatedPointerEvent) => void) {
    const bg = new Graphics()
      .roundRect(-SLOT / 2, -SLOT / 2, SLOT, SLOT, 8)
      .fill({ color: 0x1a2233 })
      .stroke({ width: 2, color: 0x3b78e8 });
    const disc = new Graphics().circle(0, -2, 11).fill({ color: 0xffe08a, alpha: 0.25 });
    const glyph = new Text({
      text: "ι",
      style: { fontFamily: "monospace", fontSize: 24, fill: 0xffe08a },
    });
    glyph.anchor.set(0.5);
    glyph.position.set(0, -1);

    this.slot.addChild(bg, disc, glyph);
    this.slot.eventMode = "static";
    this.slot.cursor = "grab";
    this.slot.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.onSpawnStart(e);
    });

    this.container.addChild(this.slot);
    this.layout();
  }

  /** Reposition for the current screen size. */
  layout(): void {
    this.slot.position.set(window.innerWidth / 2, window.innerHeight - SLOT);
  }
}
