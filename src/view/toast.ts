import { Container, Graphics, Text, type Ticker } from "pixi.js";
import { theme } from "./theme";

const IN = 220;
const HOLD = 1900;
const OUT = 450;

/** Top-of-screen discovery toast (§7.4): fades in, holds, fades out. Lives in
 * the HUD (screen space). */
export class Toast {
  readonly container = new Container();
  private elapsed = 0;
  private active = false;
  private baseY = 64;
  private readonly cb = (tk: Ticker): void => this.advance(tk.deltaMS);

  constructor(private readonly ticker: Ticker) {
    this.container.visible = false;
  }

  show(text: string): void {
    for (const c of this.container.removeChildren()) c.destroy({ children: true });
    const t = new Text({ text, style: { fontFamily: "monospace", fontSize: 20, fill: theme.iota } });
    t.anchor.set(0.5);
    const w = t.width + 44;
    const h = t.height + 24;
    const bg = new Graphics()
      .roundRect(-w / 2, -h / 2, w, h, 10)
      .fill({ color: theme.panel })
      .stroke({ width: 2, color: theme.iota, alpha: 0.5 });
    this.container.addChild(bg, t);
    this.container.visible = true;
    this.layout();
    this.elapsed = 0;
    if (!this.active) {
      this.ticker.add(this.cb);
      this.active = true;
    }
  }

  /** Centre horizontally for the current screen size. */
  layout(): void {
    this.container.x = window.innerWidth / 2;
    this.container.y = this.baseY;
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
    this.container.y = this.baseY + dy;
  }
}
