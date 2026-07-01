/**
 * The transport bar (top-right): the live reduction rate + Pause / Step / Play /
 * Fast-forward as side-by-side glyph buttons (extracted from app.ts, ADR 12). A thin Pixi
 * view over the {@link ReductionController}: the buttons drive it, the rate read-out + the
 * active-mode box reflect it. The active mode is boxed in gold; Step (an action, never
 * "active") advances the focused tree one reduction.
 */
import { Container, Graphics, Rectangle, Text, type Ticker, type FederatedPointerEvent } from "pixi.js";
import { theme, onThemeChange } from "./theme";
import { type ReductionController } from "./reduction";
import { type Sound } from "./sound";

const TBTN = 26; // button-cell pitch
type TKind = "pause" | "step" | "play" | "ff";

// Draw a transport glyph centred at the origin: ‖ / |▷ / ▷ / ▷▷.
function drawTGlyph(g: Graphics, kind: TKind, color: number): void {
  g.clear();
  if (kind === "pause") g.roundRect(-6, -7, 4, 14, 1).fill({ color }).roundRect(2, -7, 4, 14, 1).fill({ color });
  else if (kind === "step") g.roundRect(-8, -7, 3, 14, 1).fill({ color }).poly([-3, -7, 6, 0, -3, 7]).fill({ color });
  else if (kind === "play") g.poly([-5, -8, 7, 0, -5, 8]).fill({ color });
  else g.poly([-8, -7, -1, 0, -8, 7]).fill({ color }).poly([0, -7, 7, 0, 0, 7]).fill({ color });
}

export class TransportBar {
  private readonly container = new Container();
  private readonly rateText = new Text({ text: "paused", style: { fontFamily: "monospace", fontSize: 12, fill: theme.textDim } });
  private readonly buttons: { kind: TKind; box: Graphics; glyph: Graphics }[];
  // ♪ sound toggle (struck/dimmed when muted), left of the transport cluster.
  private readonly soundGlyph = new Text({ text: "♪", style: { fontFamily: "monospace", fontSize: 15, fill: theme.text } });
  private readonly soundStrike = new Graphics();
  // rate read-out: an EMA of contractions/sec, sampled ~3×/s off the Pixi ticker.
  private rateAccum = 0;
  private lastTotal = 0;
  private redPerSec = 0;

  constructor(hud: Container, ticker: Ticker, private readonly reduce: ReductionController, private readonly sound: Sound) {
    hud.addChild(this.container);
    this.rateText.anchor.set(1, 0.5);
    this.container.addChild(this.rateText);
    // ♪ sound toggle: its own cell one pitch left of Pause (at -4·TBTN).
    this.soundGlyph.anchor.set(0.5);
    const soundCell = new Container();
    soundCell.position.set(-4 * TBTN, 0);
    soundCell.eventMode = "static";
    soundCell.cursor = "pointer";
    soundCell.hitArea = new Rectangle(-TBTN / 2, -13, TBTN, 26);
    soundCell.addChild(this.soundGlyph, this.soundStrike);
    soundCell.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.sound.toggle();
      this.paintSound();
    });
    this.container.addChild(soundCell);
    // Four buttons, laid out leftward from the corner: pause(-78) step(-52) play(-26) ff(0).
    this.buttons = (["pause", "step", "play", "ff"] as const).map((kind, i) => {
      const cont = new Container();
      cont.position.set(-(3 - i) * TBTN, 0);
      cont.eventMode = "static";
      cont.cursor = "pointer";
      cont.hitArea = new Rectangle(-TBTN / 2, -13, TBTN, 26);
      const box = new Graphics();
      const glyph = new Graphics();
      cont.addChild(box, glyph);
      cont.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        if (kind === "step") reduce.stepOnce();
        else reduce.setTransport(kind);
      });
      this.container.addChild(cont);
      return { kind, box, glyph };
    });
    onThemeChange(() => this.paint());
    ticker.add((tk: { deltaMS: number }) => this.tickRate(tk.deltaMS));
    this.paint();
    this.place();
  }

  /** Repaint the buttons (active mode boxed in gold). Called on transport + theme change. */
  paint(): void {
    for (const b of this.buttons) {
      const active = b.kind !== "step" && this.reduce.mode === b.kind;
      b.box.clear();
      if (active) b.box.roundRect(-11, -11, 22, 22, 5).fill({ color: theme.iota, alpha: 0.18 }).stroke({ width: 1, color: theme.iota });
      drawTGlyph(b.glyph, b.kind, active ? theme.iota : b.kind === "step" ? theme.text : theme.textDim);
    }
    this.rateText.style.fill = theme.textDim;
    this.paintSound();
  }

  /** Recolour the ♪ button for the current mute state: dimmed + struck through when off. */
  private paintSound(): void {
    const on = this.sound.enabled;
    this.soundGlyph.style.fill = on ? theme.text : theme.textDim;
    this.soundStrike.clear();
    if (!on) this.soundStrike.moveTo(-8, 8).lineTo(8, -8).stroke({ width: 1.5, color: theme.textDim });
  }

  /** Re-anchor to the top-right corner (on resize). */
  place(): void {
    this.container.position.set(window.innerWidth - 18, 34);
    this.rateText.position.set(-4 * TBTN - 22, 0); // just left of the ♪ sound button
  }

  private tickRate(deltaMS: number): void {
    this.rateAccum += deltaMS;
    if (this.rateAccum < 300) return;
    const total = this.reduce.totalSteps();
    // max(0, …): an explicit resume resets per-tree step counts, so the delta (and the EMA)
    // can dip below zero — never show a negative rate.
    this.redPerSec = Math.max(0, this.redPerSec * 0.5 + ((total - this.lastTotal) / (this.rateAccum / 1000)) * 0.5);
    this.lastTotal = total;
    this.rateAccum = 0;
    this.rateText.text = this.reduce.mode === "pause" ? "paused" : `${this.redPerSec.toFixed(1)} red/s`;
  }
}
