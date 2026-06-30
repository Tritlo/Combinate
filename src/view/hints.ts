/**
 * The contextual hint bar (ADR 17) — a bottom action-bar showing the current context's actions,
 * each as a `[glyph] label` chip ("Q Apply fn", "Ⓐ Pick"). The glyph adapts to the active input
 * device (keyboard vs gamepad, {@link activeDevice}), the video-game "E to use" affordance. Shown
 * only when the active device is keyboard/gamepad (not mouse) AND the View ▸ "Show controls"
 * toggle is on. Repaint on context change and on device change (the host wires {@link onDeviceChange}).
 */
import { Container, Graphics, Text } from "pixi.js";
import { currentMode } from "./theme";
import { type Context, HINTS } from "./keymap";
import { activeDevice } from "./inputDevice";

const H = 26; // chip height
const PADX = 10; // chip horizontal padding
const GAP = 8; // gap between chips
const ABOVE = 12; // gap between the hint row and the toolbar's top edge

/** Mono black-and-white chrome, matching the menu bar + hotbar tooltip (System-1 box). */
function mono(): { paper: number; ink: number } {
  return currentMode() === "dark" ? { paper: 0x07090d, ink: 0xf0f3f6 } : { paper: 0xffffff, ink: 0x000000 };
}

export class HintBar {
  readonly container = new Container();
  private ctx: Context | null = null;
  private showControls = true;

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

  /** Gate the hint display on the View ▸ "Show controls" toggle (visuals only). */
  setShowControls(v: boolean): void {
    this.showControls = v;
    this.refresh();
  }

  /** Reposition: centre the row just above the toolbar's top edge (`toolbarTop`). */
  place(width: number, toolbarTop: number): void {
    this.container.position.set(width / 2, toolbarTop - ABOVE);
  }

  /** Repaint with the current device's glyphs (also call on device change). */
  refresh(): void {
    for (const c of this.container.removeChildren()) c.destroy({ children: true });
    const ctx = this.ctx;
    const visible = this.showControls && activeDevice() !== "mouse" && ctx != null;
    this.container.visible = visible;
    if (!visible || ctx == null) return;
    const { paper, ink } = mono();
    const pad = activeDevice() === "pad";
    const chips: { c: Container; w: number }[] = [];
    let total = 0;
    for (const hint of HINTS[ctx]) {
      const glyph = new Text({ text: pad ? hint.pad : hint.kbd, style: { fontFamily: "monospace", fontSize: 13, fontWeight: "700", fill: ink } });
      const label = new Text({ text: hint.label, style: { fontFamily: "monospace", fontSize: 13, fill: ink } });
      label.alpha = 0.75; // glyph/label hierarchy without leaving the ink-on-paper palette
      glyph.position.set(PADX, (H - glyph.height) / 2);
      label.position.set(glyph.x + glyph.width + 6, (H - label.height) / 2);
      const w = label.x + label.width + PADX;
      // System-1 box: a hard 1px ink frame on paper with a hard-edged drop shadow (matches the hotbar tooltip).
      const bg = new Graphics()
        .rect(3, 4, w, H)
        .fill({ color: ink, alpha: 0.16 })
        .rect(0, 0, w, H)
        .fill({ color: paper })
        .stroke({ width: 1, color: ink });
      const chip = new Container();
      chip.addChild(bg, glyph, label);
      chips.push({ c: chip, w });
      total += w + GAP;
    }
    total -= GAP;
    // lay the row out centred around the container origin (placed at screen-bottom-centre)
    let x = -total / 2;
    for (const { c, w } of chips) {
      c.position.set(x, -H);
      this.container.addChild(c);
      x += w + GAP;
    }
  }
}
