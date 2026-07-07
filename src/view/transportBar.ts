/**
 * The transport bar (top-right): a single [♪] sound on/off toggle, Step and Record actions, a segmented
 * speed bar (Pause / Play / Fast-forward / Max) with a paper slider that slides onto the active mode,
 * and a System-1 "display" panel showing the live reduction rate — sitting to the RIGHT of the speed
 * controls. A thin DOM view over the {@link ReductionController}: the cells drive it, the slider +
 * the rate panel reflect it. System-1 chrome (ink track, paper slider) to match the layout bar.
 *
 * The play/pause/step glyphs are inline SVG (a shared bar/triangle vocabulary, `fill: currentColor`
 * so they inherit the cell's paper-on-ink/ink-on-paper flip for free) rather than the Unicode ▶/▮
 * block: IoskeleyMono doesn't cover those codepoints, so they fell back to a system symbol font —
 * blurry and oversized at 12px, and synthetically bolded (changing the cell's width) on `.on`. The
 * sound toggle stays a plain [♪] text glyph (with a trailing U+FE0E — some platforms substitute a
 * colour-emoji note there otherwise) since it's the one glyph not shared with a selected/idle pair.
 */
import { type Ticker } from "pixi.js";
import { currentMode, onThemeChange, type Mode, MONO, PAPER, INK } from "./theme";
import { type ReductionController, type Transport, TRANSPORT_MODES } from "./reduction";
import { type Sound } from "./sound";
import { MENUBAR_HEIGHT } from "./menubar";

const PALETTE: Record<Mode, { paper: string; ink: string; record: string }> = {
  light: { paper: PAPER.light, ink: INK.light, record: "#b42318" },
  dark: { paper: PAPER.dark, ink: INK.dark, record: "#ff6b5f" },
};
const TOP = MENUBAR_HEIGHT + 8; // clear of the menu bar, using its existing 8px spacing rhythm

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.tp-root { position: fixed; top: ${TOP}px; right: 16px; z-index: 41; display: flex; gap: 8px; align-items: center;
  font-family: ${MONO}; }
.tp-seg { position: relative; display: flex; flex: 1 1 auto; border: 1px solid var(--tp-ink); background: var(--tp-ink);
  box-shadow: 2px 2px 0 rgba(0,0,0,0.6); } /* grows to fill tp-root's width — matched to the layout bar's, see LayoutControls.syncPhone */
.tp-seg.tp-speed { display: grid; } /* equal-width columns (count set in JS) — the knob's transform math needs true equal tracks */
.tp-slider { position: absolute; top: 0; bottom: 0; background: var(--tp-paper);
  transition: transform 0.15s ease; pointer-events: none; } /* width + transform are % (set in JS) so cells can grow */
.tp-cell { position: relative; z-index: 1; flex: 1 1 0; width: auto; height: 24px; border: none; background: transparent;
  color: var(--tp-paper); cursor: pointer; font-family: ${MONO}; font-size: 12px; line-height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center; transition: color 0.15s ease, background 0.15s ease; }
.tp-cell.on { color: var(--tp-ink); }
.tp-cell.fill.on { background: var(--tp-paper); } /* single toggles fill (no sliding knob) */
.tp-cell.muted { color: var(--tp-paper); opacity: 0.45; }
.tp-cell:not(.on):hover { background: color-mix(in srgb, var(--tp-paper) 18%, transparent); }
.tp-cell.record { color: var(--tp-record); }
.tp-cell.record:hover { background: color-mix(in srgb, var(--tp-record) 18%, transparent); }
.tp-cell.record:active { color: var(--tp-paper); background: var(--tp-record); }
.tp-icon { width: 12px; height: 12px; fill: currentColor; display: block; }
.tp-rate { display: flex; flex: 1 1 auto; align-items: center; justify-content: flex-end; height: 26px; padding: 0 9px;
  width: 124px; box-sizing: border-box; /* fixed: fits the widest SI reading ("999T red/s", 122.3px measured) so the bar never resizes between paused and running */
  border: 1px solid var(--tp-ink); background: var(--tp-paper); color: var(--tp-ink); box-shadow: 2px 2px 0 rgba(0,0,0,0.6);
  font-family: ${MONO}; font-size: 11px; letter-spacing: 0.04em; white-space: nowrap; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** An icon cell's identity — the four transport modes, plus the step and record actions. */
type IconKind = Transport | "step" | "record";

const ICON_LABEL: Record<IconKind, string> = { pause: "Pause", play: "Play", ff: "Fast-forward", max: "Max speed", step: "Step", record: "Record" };

// Each icon's shapes (rects/polygons) within a shared 0 0 16 16 viewBox — bars for pause/step,
// right-pointing triangles (1/2/3 of them) for play/ff/max/step. y spans 2..14 throughout so every
// icon sits on the same baseline; triangle width narrows as the count grows (denser = faster), the
// same reading the old ▶/▶▶/▶▶▶ text glyphs gave.
const ICON_SHAPES: Record<IconKind, string> = {
  pause: `<rect x="3" y="2" width="3" height="12"/><rect x="10" y="2" width="3" height="12"/>`,
  play: `<polygon points="3,2 3,14 13,8"/>`,
  ff: `<polygon points="1,2 1,14 7,8"/><polygon points="9,2 9,14 15,8"/>`,
  max: `<polygon points="1,2 1,14 5,8"/><polygon points="6,2 6,14 10,8"/><polygon points="11,2 11,14 15,8"/>`,
  step: `<polygon points="1,2 1,14 8,8"/><rect x="11" y="2" width="3" height="12"/>`,
  record: `<circle cx="8" cy="8" r="5"/>`,
};

/** Build the `.tp-icon` SVG for `kind` — `fill: currentColor` (set in CSS), so it inherits the
 *  cell's paper-on-ink (idle) / ink-on-paper (selected) colour flip for free. */
function icon(kind: IconKind): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "tp-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICON_SHAPES[kind];
  return svg;
}

/** The shared track frame — an ink border, a paper slider absolutely positioned inside it (translated
 *  to the active cell in %, so it tracks cells that grow/shrink). Cells are appended by the caller. */
function trackFrame(): { el: HTMLDivElement; slider: HTMLDivElement } {
  const el = document.createElement("div");
  el.className = "tp-seg";
  const slider = document.createElement("div");
  slider.className = "tp-slider";
  el.append(slider);
  return { el, slider };
}

/** A segmented control with one text cell per label — used only for the [♪] sound toggle now (the
 *  transport/step glyphs are inline SVG, see {@link iconSegment}). */
function segment(labels: string[]): { el: HTMLDivElement; cells: HTMLButtonElement[]; slider: HTMLDivElement } {
  const { el, slider } = trackFrame();
  const cells = labels.map((label) => {
    const b = document.createElement("button");
    b.className = "tp-cell";
    b.textContent = label;
    el.append(b);
    return b;
  });
  return { el, cells, slider };
}

/** A segmented control with one SVG-icon cell per kind (labelled via `aria-label`, {@link ICON_LABEL}). */
function iconSegment(kinds: IconKind[]): { el: HTMLDivElement; cells: HTMLButtonElement[]; slider: HTMLDivElement } {
  const { el, slider } = trackFrame();
  const cells = kinds.map((k) => {
    const b = document.createElement("button");
    b.className = "tp-cell";
    b.setAttribute("aria-label", ICON_LABEL[k]);
    b.append(icon(k));
    el.append(b);
    return b;
  });
  return { el, cells, slider };
}

/** Rate with a compact SI suffix so the reading stays bounded as it grows:
 *  3.0, 42, 999, 1.1K, 12K, 1.0M, …, 999T (the panel width is fixed to the widest case). */
function siRate(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(n < 1e13 ? 1 : 0) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "K";
  if (n >= 10) return n.toFixed(0);
  return n.toFixed(1);
}

export class TransportBar {
  private readonly root = document.createElement("div");
  private readonly rateEl = document.createElement("div");
  private readonly modes: Transport[];
  private readonly speed: ReturnType<typeof iconSegment>;
  private readonly soundCell: HTMLButtonElement;
  private rateAccum = 0;
  private lastTotal = 0;
  private redPerSec = 0;

  constructor(ticker: Ticker, private readonly reduce: ReductionController, private readonly snd: Sound, private readonly onRecord?: () => void) {
    injectStyles();
    this.modes = TRANSPORT_MODES;
    this.root.className = "tp-root";
    this.applyPalette();

    // Sound: a single [♪] on/off toggle — fills when on, dims (not struck through) when muted.
    const soundSeg = segment(["♪︎"]);
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
    const stepSeg = iconSegment(["step"]);
    stepSeg.slider.remove();
    stepSeg.cells[0].title = "Step once — advance the focused tree by one reduction";
    stepSeg.cells[0].addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.reduce.stepOnce();
    });

    // Record: another lone action segment, kept outside the speed grid so the slider tracks stay equal.
    const recordSeg = iconSegment(["record"]);
    recordSeg.slider.remove();
    recordSeg.cells[0].classList.add("record");
    recordSeg.cells[0].title = "Record… (MP4)";
    recordSeg.cells[0].addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.onRecord?.();
    });

    // Speed: the segmented playback modes with a sliding paper knob on the active one. `.tp-speed`
    // is a CSS grid with N equal (minmax(0,1fr)) columns — genuinely equal-width cells, unlike flex's
    // content-driven basis, which is what the knob's %-based transform math (below) requires to land
    // exactly on the active cell.
    this.speed = iconSegment(this.modes);
    this.speed.el.classList.add("tp-speed");
    this.speed.el.style.gridTemplateColumns = `repeat(${this.modes.length}, minmax(0, 1fr))`;
    this.speed.slider.style.width = `${100 / this.modes.length}%`;
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

    this.root.append(soundSeg.el, stepSeg.el, recordSeg.el, this.speed.el, this.rateEl);
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
    this.speed.slider.style.transform = `translateX(${i * 100}%)`;
    this.speed.cells.forEach((c, j) => c.classList.toggle("on", j === i));
    const on = this.snd.enabled;
    this.soundCell.classList.toggle("on", on);
    this.soundCell.classList.toggle("muted", !on);
  }

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
    this.root.style.setProperty("--tp-record", p.record);
  }
}
