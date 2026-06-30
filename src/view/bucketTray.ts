/**
 * The game-mode held-term badge (ADR 17). Game mode's buckets are now spatial regions on the canvas
 * (you pan between them; the focused one is bright, neighbours fade) — NOT explicit slot-chips. So
 * this is just a small "✋ <term>" badge, top-centre, telling you what you're carrying. Pure view;
 * the {@link GameInputController} drives it via {@link setHand}.
 */
import { Container, Text } from "pixi.js";
import { onThemeChange, theme } from "./theme";

export class BucketTray {
  readonly container = new Container();
  private readonly hand = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 14, fontWeight: "600", fill: theme.iota } });

  constructor() {
    this.hand.anchor.set(0.5, 0.5);
    this.container.addChild(this.hand);
    this.container.visible = false;
    onThemeChange(() => this.layout());
  }

  show(): void {
    this.container.visible = true;
    this.layout();
  }
  hide(): void {
    this.container.visible = false;
  }

  /** Show/hide the held-term badge (✋ <label>), or clear it (null). */
  setHand(label: string | null): void {
    this.hand.style.fill = theme.iota;
    this.hand.text = label ? `✋ ${label}` : "";
    this.hand.visible = !!label;
    this.layout();
  }

  /** Re-centre on resize. */
  layout(): void {
    this.hand.position.set(window.innerWidth / 2, 92);
  }
}
