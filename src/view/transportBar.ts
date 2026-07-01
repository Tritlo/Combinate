/**
 * The transport bar (top-right): the live reduction rate, a sliding [♪ | ✕] sound toggle, a Step
 * action, and a segmented speed bar (Pause / Play / Fast-forward …) with a paper slider that slides
 * onto the active mode. A thin DOM view over the {@link ReductionController} — the cells drive it,
 * the rate read-out + the slider reflect it. System-1 chrome to match the layout control bar (ink
 * track, paper slider), the tone toggle struck through when muted.
 */
import { type Ticker } from "pixi.js";
import { currentMode, onThemeChange, type Mode } from "./theme";
import { type ReductionController, type Transport } from "./reduction";
import { type Sound } from "./sound";

const PALETTE: Record<Mode, { paper: string; ink: string; accent: string }> = {
  light: { paper: "#ffffff", ink: "#000000", accent: "#cc2222" },
  dark: { paper: "#07090d", ink: "#f0f3f6", accent: "#ee4444" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";
const CELL = 30; // segment cell width (px)

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.tp-root { position: fixed; top: 14px; right: 16px; z-index: 41; display: flex; gap: 8px; align-items: center;
  font-family: ${MONO}; }
.tp-rate { font-size: 12px; color: var(--tp-dim); white-space: nowrap; min-width: 58px; text-align: right; }
.tp-seg { position: relative; display: flex; border: 1px solid var(--tp-ink); background: var(--tp-ink);
  box-shadow: 2px 2px 0 rgba(0,0,0,0.6); }
.tp-slider { position: absolute; top: 0; bottom: 0; width: ${CELL}px; background: var(--tp-paper);
  transition: transform 0.15s ease; pointer-events: none; }
.tp-cell { position: relative; z-index: 1; width: ${CELL}px; height: 24px; border: none; background: transparent;
  color: var(--tp-paper); cursor: pointer; font-family: ${MONO}; font-size: 13px; line-height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center; transition: color 0.15s ease; }
.tp-cell.on { color: var(--tp-ink); font-weight: 700; }
.tp-cell.act { color: var(--tp-accent); } /* the Step one-shot: an action tint, never a slider mode */
.tp-cell.muted { text-decoration: line-through; opacity: 0.7; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** A segmented control: an ink track, a paper slider that translates to the active cell, and one
 *  transparent cell per entry. Returns the element + a setter to move the slider / repaint cells. */
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

// Media glyphs. The trailing U+FE0E (text-presentation selector) forces monochrome rendering — without
// it Chrome draws ⏸ ⏩ ⏭ as colour emoji, breaking the System-1 look. Speed modes fill the slider
// segment; Step is a one-shot action.
const VS = "\uFE0E"; // text-presentation selector (forces monochrome, not colour emoji)
const STEP_GLYPH = "⏭" + VS;
const GLYPH: Record<Transport, string> = {
  pause: "⏸" + VS, // ⏸
  play: "▶" + VS, // ▶
  ff: "⏩" + VS, // ⏩
  max: "▶▶▶", // ▶▶▶
};

export class TransportBar {
  private readonly root = document.createElement("div");
  private readonly rateEl = document.createElement("div");
  private readonly modes: Transport[];
  private readonly speed: ReturnType<typeof segment>;
  private readonly sound: ReturnType<typeof segment>;
  private readonly stepBtn: HTMLButtonElement;
  private rateAccum = 0;
  private lastTotal = 0;
  private redPerSec = 0;

  constructor(ticker: Ticker, private readonly reduce: ReductionController, private readonly snd: Sound) {
    injectStyles();
    this.modes = reduce.transportModes();
    this.root.className = "tp-root";
    this.applyPalette();

    this.rateEl.className = "tp-rate";
    this.rateEl.textContent = "paused";

    // Sound: a two-cell [♪ | ✕] slider — ♪ = on, ✕ = muted.
    this.sound = segment(["♪", "✕"]);
    this.sound.cells[0].title = "Sound on — a tone per reduction";
    this.sound.cells[1].title = "Mute";
    this.sound.cells[0].addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (!this.snd.enabled) this.snd.toggle();
      this.paint();
    });
    this.sound.cells[1].addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (this.snd.enabled) this.snd.toggle();
      this.paint();
    });

    // Step: a lone action cell (its own segment so the chrome matches), never a slider mode.
    const stepSeg = segment([STEP_GLYPH]);
    stepSeg.slider.remove(); // no slider — Step doesn't stay "on"
    this.stepBtn = stepSeg.cells[0];
    this.stepBtn.title = "Step once — advance the focused tree by one reduction";
    this.stepBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.reduce.stepOnce();
    });

    // Speed: the segmented playback modes with a sliding paper knob on the active one.
    this.speed = segment(this.modes.map((m) => GLYPH[m]));
    this.modes.forEach((m, i) => {
      this.speed.cells[i].title = m === "max" ? "Max speed" : m === "ff" ? "Fast-forward" : m === "play" ? "Play" : "Pause";
      this.speed.cells[i].addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.reduce.setTransport(m);
      });
    });

    this.root.append(this.rateEl, this.sound.el, stepSeg.el, this.speed.el);
    document.body.append(this.root);
    onThemeChange(() => {
      this.applyPalette();
      this.paint();
    });
    ticker.add((tk: { deltaMS: number }) => this.tickRate(tk.deltaMS));
    this.paint();
  }

  /** Reflect the transport mode + mute state: slide the speed knob onto the active mode, mark the
   *  sound cell, strike ♪ when muted. Called on transport + theme change. */
  paint(): void {
    const mode = this.reduce.mode;
    const i = Math.max(0, this.modes.indexOf(mode));
    this.speed.slider.style.transform = `translateX(${i * CELL}px)`;
    this.speed.cells.forEach((c, j) => c.classList.toggle("on", j === i));
    const on = this.snd.enabled;
    this.sound.slider.style.transform = `translateX(${on ? 0 : CELL}px)`;
    this.sound.cells[0].classList.toggle("on", on);
    this.sound.cells[0].classList.toggle("muted", !on);
    this.sound.cells[1].classList.toggle("on", !on);
  }

  /** CSS handles the fixed top-right position — kept as a no-op for the resize call site. */
  place(): void {}

  private tickRate(deltaMS: number): void {
    this.rateAccum += deltaMS;
    if (this.rateAccum < 300) return;
    const total = this.reduce.totalSteps();
    this.redPerSec = Math.max(0, this.redPerSec * 0.5 + ((total - this.lastTotal) / (this.rateAccum / 1000)) * 0.5);
    this.lastTotal = total;
    this.rateAccum = 0;
    this.rateEl.textContent = this.reduce.mode === "pause" ? "paused" : `${this.redPerSec.toFixed(1)} red/s`;
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    this.root.style.setProperty("--tp-paper", p.paper);
    this.root.style.setProperty("--tp-ink", p.ink);
    this.root.style.setProperty("--tp-accent", p.accent);
    this.root.style.setProperty("--tp-dim", currentMode() === "dark" ? "#9aa3ad" : "#5a5a5a");
  }
}
