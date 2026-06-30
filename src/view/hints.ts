/**
 * The contextual hint bar (ADR 17) — a bottom action-bar showing the current context's actions,
 * each as a `[glyph] label` chip ("Q Apply fn", "Ⓐ Pick"). The glyph adapts to the active input
 * device (keyboard vs gamepad, {@link activeDevice}), the video-game "E to use" affordance. Shown
 * only while a context (Build / Inspect) owns the input; hidden in the free canvas. Repaint on
 * context change and on device change (the host wires {@link onDeviceChange}).
 */
import { Container, Graphics, Text } from "pixi.js";
import { theme } from "./theme";
import { type Context, HINTS } from "./keymap";
import { activeDevice } from "./inputDevice";

const H = 26; // chip height
const PADX = 10; // chip horizontal padding
const GAP = 8; // gap between chips
const BOTTOM = 30; // distance from the bottom edge

export class HintBar {
  readonly container = new Container();
  private ctx: Context | null = null;

  constructor() {
    this.container.eventMode = "none"; // hints never eat input
    this.container.visible = false;
  }

  /** Set the active context (null = free → hidden) and repaint. */
  setContext(ctx: Context | null): void {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    this.refresh();
  }

  /** Reposition on resize (centre the row near the bottom). */
  place(width: number, height: number): void {
    this.container.position.set(width / 2, height - BOTTOM);
  }

  /** Repaint with the current device's glyphs (also call on device change). */
  refresh(): void {
    for (const c of this.container.removeChildren()) c.destroy({ children: true });
    if (!this.ctx) {
      this.container.visible = false;
      return;
    }
    this.container.visible = true;
    const pad = activeDevice() === "pad";
    const chips: Container[] = [];
    let total = 0;
    for (const hint of HINTS[this.ctx]) {
      const glyph = new Text({ text: pad ? hint.pad : hint.kbd, style: { fontFamily: "monospace", fontSize: 13, fontWeight: "700", fill: theme.text } });
      const label = new Text({ text: hint.label, style: { fontFamily: "monospace", fontSize: 13, fill: theme.textDim } });
      glyph.position.set(PADX, (H - glyph.height) / 2);
      label.position.set(glyph.x + glyph.width + 6, (H - label.height) / 2);
      const w = label.x + label.width + PADX;
      const bg = new Graphics().roundRect(0, 0, w, H, 6).fill({ color: theme.inset, alpha: 0.92 }).stroke({ width: 1, color: theme.border });
      const chip = new Container();
      chip.addChild(bg, glyph, label);
      chips.push(chip);
      total += w + GAP;
    }
    total -= GAP;
    // lay the row out centred around the container origin (placed at screen-bottom-centre)
    let x = -total / 2;
    for (const chip of chips) {
      chip.position.set(x, -H);
      this.container.addChild(chip);
      x += chip.width + GAP;
    }
  }
}
