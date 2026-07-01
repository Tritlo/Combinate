/**
 * The transport bar (top-right): a single [♪] sound on/off toggle, a Step action, a segmented speed
 * bar (Pause / Play / Fast-forward / Max) with a paper slider that slides onto the active mode, and a
 * System-1 "display" panel showing the live reduction rate — sitting to the RIGHT of the speed
 * controls. A thin DOM view over the {@link ReductionController}: the cells drive it, the slider +
 * the rate panel reflect it. System-1 chrome (ink track, paper slider) to match the layout bar.
 *
 * Glyphs are SOLID geometric shapes (▶ ▮ from the U+25xx block), not the ⏸/⏩ media-control emoji —
 * the emoji render thin/hollow and vanish on the white slider; the solid shapes flip cleanly between
 * paper-on-ink (idle) and ink-on-paper (selected) so the active mode is always legible.
 */
import { type Ticker } from "pixi.js";
import { currentMode, onThemeChange, type Mode } from "./theme";
import { type ReductionController, type Transport } from "./reduction";
import { type Sound } from "./sound";

const PALETTE: Record<Mode, { paper: string; ink: string }> = {
  light: { paper: "#ffffff", ink: "#000000" },
  dark: { paper: "#07090d", ink: "#f0f3f6" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";
const CELL = 30; // segment cell width (px) — the slider steps by this, so every cell is CELL wide

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.tp-root { position: fixed; top: 14px; right: 16px; z-index: 41; display: flex; gap: 8px; align-items: center;
  font-family: ${MONO}; }
.tp-seg { position: relative; display: flex; border: 1px solid var(--tp-ink); background: var(--tp-ink);
  box-shadow: 2px 2px 0 rgba(0,0,0,0.6); }
.tp-slider { position: absolute; top: 0; bottom: 0; width: ${CELL}px; background: var(--tp-paper);
  transition: transform 0.15s ease; pointer-events: none; }
.tp-cell { position: relative; z-index: 1; width: ${CELL}px; height: 24px; border: none; background: transparent;
  color: var(--tp-paper); cursor: pointer; font-family: ${MONO}; font-size: 12px; line-height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center; letter-spacing: -1px; transition: color 0.15s ease, background 0.15s ease; }
.tp-cell.on { color: var(--tp-ink); font-weight: 700; }
.tp-cell.fill.on { background: var(--tp-paper); } /* single toggles fill (no sliding knob) */
.tp-cell.muted { color: var(--tp-paper); opacity: 0.5; text-decoration: line-through; }
.tp-rate { display: flex; align-items: center; justify-content: flex-end; height: 26px; min-width: 74px; padding: 0 9px;
  border: 1px solid var(--tp-ink); background: var(--tp-paper); color: var(--tp-ink); box-shadow: 2px 2px 0 rgba(0,0,0,0.6);
  font-family: ${MONO}; font-size: 11px; letter-spacing: 0.04em; white-space: nowrap; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** A segmented control: an ink track, a paper slider that translates to the active cell, and one
 *  transparent cell per entry. Returns the element + the cells + the slider. */
function segment(labels: string[]): { el: HTMLDivElement; cells: HTMLButtonElement[]; slider: HTMLDivElement } {
  const el = document.createElement("div");
  el.className = "tp-seg";
  const slider = document.createElement("div");
  slider.className = "tp-slider";
  el.append(slider);
  const cells = labels.map((label) => {
    const b = document.createElement("button");
    b.className = "tp-cell";
    b.textContent = label;
    el.append(b);
    return b;
  });
  return { el, cells, slider };
}

// Solid geometric glyphs (▶ = U+25B6, ▮ = U+25AE) — filled shapes that render bold on either background.
const STEP_GLYPH = "▶▮"; // play-to-bar: advance one step
const GLYPH: Record<Transport, string> = { pause: "▮▮", play: "▶", ff: "▶▶", max: "▶▶▶" };

/** Rate as compact SI so the display width stays stable as it grows: 3.0, 42, 999, 1.1K, 12K, 1.0M, … */
function siRate(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "K";
  if (n >= 10) return n.toFixed(0);
  return n.toFixed(1);
}

export class TransportBar {
  private readonly root = document.createElement("div");
  private readonly rateEl = document.createElement("div");
  private readonly modes: Transport[];
  private readonly speed: ReturnType<typeof segment>;
  private readonly soundCell: HTMLButtonElement;
  private rateAccum = 0;
  private lastTotal = 0;
  private redPerSec = 0;

  constructor(ticker: Ticker, private readonly reduce: ReductionController, private readonly snd: Sound) {
    injectStyles();
    this.modes = reduce.transportModes();
    this.root.className = "tp-root";
    this.applyPalette();

    // Sound: a single [♪] on/off toggle — fills when on, struck through when muted.
    const soundSeg = segment(["♪"]);
    soundSeg.slider.remove();
    this.soundCell = soundSeg.cells[0];
    this.soundCell.classList.add("fill");
    this.soundCell.title = "Sound — a tone per reduction";
    this.soundCell.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.snd.toggle();
      this.paint();
    });

    // Step: a lone action cell (its own segment so the chrome matches), never a slider mode.
    const stepSeg = segment([STEP_GLYPH]);
    stepSeg.slider.remove();
    stepSeg.cells[0].title = "Step once — advance the focused tree by one reduction";
    stepSeg.cells[0].addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.reduce.stepOnce();
    });

    // Speed: the segmented playback modes with a sliding paper knob on the active one.
    this.speed = segment(this.modes.map((m) => GLYPH[m]));
    this.modes.forEach((m, i) => {
      this.speed.cells[i].title =
        m === "max" ? "Max speed" : m === "ff" ? "Fast-forward (≈3/s)" : m === "play" ? "Play (≈1/s)" : "Pause";
      this.speed.cells[i].addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.reduce.setTransport(m);
      });
    });

    // Rate: a System-1 display panel, to the RIGHT of the speed controls.
    this.rateEl.className = "tp-rate";
    this.rateEl.textContent = "paused";

    this.root.append(soundSeg.el, stepSeg.el, this.speed.el, this.rateEl);
    document.body.append(this.root);
    onThemeChange(() => {
      this.applyPalette();
      this.paint();
    });
    ticker.add((tk: { deltaMS: number }) => this.tickRate(tk.deltaMS));
    this.paint();
  }

  /** Reflect the transport mode + mute state: slide the speed knob onto the active mode, mark the
   *  sound toggle. Called on transport + theme change. */
  paint(): void {
    const mode = this.reduce.mode;
    const i = Math.max(0, this.modes.indexOf(mode));
    this.speed.slider.style.transform = `translateX(${i * CELL}px)`;
    this.speed.cells.forEach((c, j) => c.classList.toggle("on", j === i));
    const on = this.snd.enabled;
    this.soundCell.classList.toggle("on", on);
    this.soundCell.classList.toggle("muted", !on);
  }

  /** CSS handles the fixed top-right position — kept as a no-op for the resize call site. */
  place(): void {}

  /** The root element — so the mobile Controls card can host it (reparent) instead of the standalone bar. */
  get el(): HTMLElement {
    return this.root;
  }

  private tickRate(deltaMS: number): void {
    this.rateAccum += deltaMS;
    if (this.rateAccum < 300) return;
    const total = this.reduce.totalSteps();
    this.redPerSec = Math.max(0, this.redPerSec * 0.5 + ((total - this.lastTotal) / (this.rateAccum / 1000)) * 0.5);
    this.lastTotal = total;
    this.rateAccum = 0;
    this.rateEl.textContent = this.reduce.mode === "pause" ? "paused" : `${siRate(this.redPerSec)} red/s`;
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    this.root.style.setProperty("--tp-paper", p.paper);
    this.root.style.setProperty("--tp-ink", p.ink);
  }
}
