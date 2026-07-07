import { Container, Graphics, Text, type Ticker } from "pixi.js";
import { theme } from "./theme";

const IN = 220;
const HOLD = 1900;
const OUT = 450;

/** Discovery toast (§7.4): fades in, holds, fades out. Lives in the HUD (screen
 * space), centered below the read-out + its sub-line so it doesn't collide with
 * the menu bar / expression at the top. */
export class Toast {
  readonly container = new Container();
  private elapsed = 0;
  private active = false;
  private baseY = 124;
  private readonly cb = (tk: Ticker): void => this.advance(tk.deltaMS);

  constructor(private readonly ticker: Ticker) {
    this.container.visible = false;
  }

  show(text: string): void {
    for (const c of this.container.removeChildren()) c.destroy({ children: true });
    // System-1 chrome: paper panel, square ink border, a hard drop shadow, ink text (no accent color).
    const t = new Text({ text, style: { fontFamily: "monospace", fontSize: 18, fill: theme.text } });
    t.anchor.set(0.5);
    t.roundPixels = true; // snap to whole pixels — a fractional center (odd text width / window) blurs the glyphs
    const w = t.width + 40;
    const h = t.height + 20;
    const shadow = new Graphics().rect(-w / 2 + 3, -h / 2 + 3, w, h).fill({ color: 0x000000, alpha: 0.2 });
    const bg = new Graphics().rect(-w / 2, -h / 2, w, h).fill({ color: theme.panel }).stroke({ width: 1.5, color: theme.border });
    this.container.addChild(shadow, bg, t);
    this.container.visible = true;
    this.layout();
    this.elapsed = 0;
    if (!this.active) {
      this.ticker.add(this.cb);
      this.active = true;
    }
  }

  /** Center horizontally for the current screen size. */
  layout(): void {
    this.container.x = Math.round(window.innerWidth / 2);
    this.container.y = Math.round(this.baseY);
  }

  private advance(deltaMS: number): void {
    this.elapsed += deltaMS;
    const total = IN + HOLD + OUT;
    if (this.elapsed >= total) {
      this.container.visible = false;
      this.ticker.remove(this.cb);
      this.active = false;
      return;
    }
    let alpha = 1;
    let dy = 0;
    if (this.elapsed < IN) {
      const p = this.elapsed / IN;
      alpha = p;
      dy = -12 * (1 - p);
    } else if (this.elapsed >= IN + HOLD) {
      alpha = 1 - (this.elapsed - IN - HOLD) / OUT;
    }
    this.container.alpha = alpha;
    this.container.y = Math.round(this.baseY + dy);
  }
}
