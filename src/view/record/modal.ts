/**
 * The MP4 recording UI (ADR 24): a System-1 modal that gathers record settings
 * and a lightweight preview window that shows the offline render as frames land.
 */
import type { Node } from "../../core/term";
import type { NativeOpts } from "../../core/native";
import { Modal } from "../modal";
import type { LayoutKey } from "../layoutControls";
import { currentMode, ensureFont, INK, MONO, onThemeChange, PAPER, type Mode } from "../theme";
import { probeSupport } from "./encoder";
import { precount } from "./precount";
import type { CodecSupport, RecordPlan, RecordProgress, RecordSettings } from "./types";

const MAX_STEPS = 2000;
const GRAPH_MAX_STEPS = 100_000;
const RESOLUTIONS = [
  { label: "1920×1080", width: 1920, height: 1080 },
  { label: "1280×720", width: 1280, height: 720 },
  { label: "1080×1080", width: 1080, height: 1080 },
] as const;
const BASE_NOTES = [
  { label: "C2", midi: 36 },
  { label: "G2", midi: 43 },
  { label: "C3", midi: 48 },
  { label: "G3", midi: 55 },
  { label: "C4", midi: 60 },
] as const;

const PALETTE: Record<Mode, { paper: string; ink: string; shadow: string; red: string; dim: string }> = {
  light: { paper: PAPER.light, ink: INK.light, shadow: "rgba(0,0,0,0.65)", red: "#b42318", dim: "rgba(27,31,36,0.62)" },
  dark: { paper: PAPER.dark, ink: INK.dark, shadow: "rgba(0,0,0,0.85)", red: "#ff6b5f", dim: "rgba(240,246,252,0.62)" },
};

let modalStylesInjected = false;
function injectModalStyles(): void {
  if (modalStylesInjected) return;
  modalStylesInjected = true;
  const css = `
.rm-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 11px; font-size: 13px; }
.rm-body [hidden] { display: none !important; }
.rm-empty { padding: 18px 4px 4px; line-height: 1.45; opacity: 0.72; }
.rm-form { display: flex; flex-direction: column; gap: 11px; }
.rm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.rm-section { border: 1px solid color-mix(in srgb, var(--md-ink) 60%, transparent); padding: 8px 9px 9px; display: flex; flex-direction: column; gap: 7px; }
.rm-section.wide { grid-column: 1 / -1; }
.rm-title { font-weight: 700; font-size: 12px; letter-spacing: 0.02em; }
.rm-row { display: flex; flex-wrap: wrap; gap: 9px 12px; align-items: center; }
.rm-choice { display: inline-flex; align-items: center; gap: 5px; min-height: 21px; white-space: nowrap; }
.rm-choice.disabled { opacity: 0.52; }
.rm-note { color: var(--rm-dim); font-size: 11.5px; line-height: 1.35; }
.rm-check, .rm-radio { accent-color: var(--md-ink); }
.rm-input, .rm-select { font: inherit; color: var(--md-ink); background: var(--md-paper); border: 1px solid var(--md-ink);
  padding: 3px 5px; min-height: 24px; box-sizing: border-box; outline: none; }
.rm-input { width: 84px; }
.rm-select { min-width: 104px; }
.rm-input:disabled, .rm-select:disabled { opacity: 0.5; }
.rm-footer { border-top: 1px solid color-mix(in srgb, var(--md-ink) 35%, transparent); padding-top: 10px; display: flex; flex-direction: column; gap: 7px; }
.rm-est, .rm-codec, .rm-warning { min-height: 1.25em; font-size: 12px; line-height: 1.35; }
.rm-warning { color: var(--rm-red); }
.rm-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
.rm-btn { font-family: inherit; font-size: 13px; font-weight: 700; padding: 4px 15px; cursor: pointer; border: 1px solid var(--md-ink); }
.rm-cancel { color: var(--md-ink); background: var(--md-paper); }
.rm-record { color: var(--md-paper); background: var(--md-ink); }
.rm-record:disabled { opacity: 0.45; cursor: default; }
@media (max-width: 560px) {
  .rm-grid { grid-template-columns: 1fr; }
}
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

let previewStylesInjected = false;
function injectPreviewStyles(): void {
  if (previewStylesInjected) return;
  previewStylesInjected = true;
  ensureFont();
  const css = `
.rp-root { position: fixed; inset: 0; z-index: 59; display: none; align-items: center; justify-content: center;
  font-family: ${MONO}; pointer-events: auto; }
.rp-card { width: min(940px, 92vw); max-height: calc(100vh - 56px); display: flex; flex-direction: column;
  background: var(--rp-paper); color: var(--rp-ink); border: 1px solid var(--rp-ink); box-shadow: 2px 2px 0 var(--rp-shadow); }
.rp-title { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: var(--rp-ink); color: var(--rp-paper);
  font-size: 14px; font-weight: 700; }
.rp-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--rp-red); flex: 0 0 auto; }
.rp-canvas-wrap { padding: 10px; min-height: 0; display: flex; justify-content: center; background: var(--rp-ink); }
.rp-canvas { display: block; max-width: 100%; max-height: 66vh; width: auto; height: auto; background: #000; }
.rp-footer { padding: 8px 10px 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center; }
.rp-frame { font-size: 12px; }
.rp-bar { height: 4px; border: 1px solid var(--rp-ink); background: var(--rp-paper); grid-column: 1 / -1; }
.rp-fill { height: 100%; width: 0%; background: var(--rp-red); }
.rp-cancel { font-family: inherit; font-size: 13px; font-weight: 700; padding: 4px 15px; color: var(--rp-paper); background: var(--rp-ink);
  border: 1px solid var(--rp-ink); cursor: pointer; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** State getters and callbacks the shell provides to the record modal. */
export interface RecordModalDeps {
  is3D: () => boolean;
  layout: () => LayoutKey;
  expandIota: () => boolean;
  rules: () => boolean;
  graph: () => boolean;
  primitives: () => boolean;
  onRecord: (term: Node, settings: RecordSettings, plan: RecordPlan) => void;
  onError: (message: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function label(text: string, input: HTMLInputElement, extra?: string): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "rm-choice";
  el.append(input, document.createTextNode(text));
  if (extra) {
    const note = document.createElement("span");
    note.className = "rm-note";
    note.textContent = extra;
    el.append(note);
  }
  return el;
}

function radio(name: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "rm-radio";
  input.type = "radio";
  input.name = name;
  input.value = value;
  return input;
}

function checkbox(): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "rm-check";
  input.type = "checkbox";
  return input;
}

function section(title: string, wide = false): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `rm-section${wide ? " wide" : ""}`;
  const h = document.createElement("div");
  h.className = "rm-title";
  h.textContent = title;
  el.append(h);
  return el;
}

function selectOption(value: string, text: string, selected = false): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  opt.selected = selected;
  return opt;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "-";
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return minutes > 0 ? `${minutes}:${seconds.toFixed(0).padStart(2, "0")}` : `${seconds.toFixed(1)}s`;
}

/** Modal for choosing deterministic offline MP4 recording settings. */
export class RecordModal extends Modal {
  private readonly empty = document.createElement("div");
  private readonly form = document.createElement("div");
  private readonly view2d = radio("rm-view", "2d");
  private readonly view3d = radio("rm-view", "3d");
  private readonly layoutRadios = new Map<LayoutKey, HTMLInputElement>();
  private readonly expand = checkbox();
  private readonly rules = checkbox();
  private readonly graph = checkbox();
  private readonly primitives = checkbox();
  private readonly primitivesLabel: HTMLLabelElement;
  private readonly primitivesNote = document.createElement("div");
  private readonly resolution = document.createElement("select");
  private readonly fps = document.createElement("select");
  private readonly stepMs = document.createElement("input");
  private readonly holdMs = document.createElement("input");
  private readonly baseNote = document.createElement("select");
  private readonly audio = checkbox();
  private readonly estimate = document.createElement("div");
  private readonly warning = document.createElement("div");
  private readonly codecStatus = document.createElement("div");
  private readonly record = document.createElement("button");
  private term: Node | null = null;
  private plan: RecordPlan | null = null;
  private codec: CodecSupport | undefined;
  private codecError = "";
  private probeSeq = 0;
  private planTimer: number | undefined;

  constructor(private readonly deps: RecordModalDeps) {
    super({ title: "Record MP4", width: "min(560px, 94vw)" });
    injectModalStyles();
    this.body.classList.add("rm-body");
    this.applyRecordPalette();
    onThemeChange(() => this.applyRecordPalette());

    this.empty.className = "rm-empty";
    this.empty.textContent = "Nothing to record. Focus a tree first.";

    this.form.className = "rm-form";
    const grid = document.createElement("div");
    grid.className = "rm-grid";

    const view = section("View");
    this.view3d.disabled = true;
    view.append(label("2D", this.view2d), label("3D", this.view3d, "(soon)"));

    const layout = section("Layout");
    const layoutRow = document.createElement("div");
    layoutRow.className = "rm-row";
    for (const [key, text] of [
      ["auto", "Auto"],
      ["topdown", "Top-Down"],
      ["radial", "Radial"],
      ["htree", "H-Tree"],
    ] as const) {
      const input = radio("rm-layout", key);
      this.layoutRadios.set(key, input);
      layoutRow.append(label(text, input));
    }
    layout.append(layoutRow);

    const display = section("Display");
    display.append(label("Expand-ι", this.expand));

    const engines = section("Engines", true);
    const engineRow = document.createElement("div");
    engineRow.className = "rm-row";
    this.primitivesLabel = label("Primitives", this.primitives);
    engineRow.append(label("Rules", this.rules), label("Graph", this.graph), this.primitivesLabel);
    this.primitivesNote.className = "rm-note";
    engines.append(engineRow, this.primitivesNote);

    const video = section("Video");
    this.resolution.className = "rm-select";
    for (const r of RESOLUTIONS) this.resolution.append(selectOption(`${r.width}x${r.height}`, r.label, r.width === 1920));
    this.fps.className = "rm-select";
    this.fps.append(selectOption("30", "30 fps"), selectOption("60", "60 fps", true));
    video.append(this.resolution, this.fps);

    const pacing = section("Pacing");
    this.stepMs.className = "rm-input";
    this.stepMs.type = "number";
    this.stepMs.min = "1";
    this.stepMs.step = "50";
    this.stepMs.value = "300";
    this.holdMs.className = "rm-input";
    this.holdMs.type = "number";
    this.holdMs.min = "0";
    this.holdMs.step = "100";
    this.holdMs.value = "1000";
    pacing.append(this.field("Step ms", this.stepMs), this.field("Hold ms", this.holdMs));

    const sound = section("Audio");
    this.baseNote.className = "rm-select";
    for (const n of BASE_NOTES) this.baseNote.append(selectOption(String(n.midi), n.label, n.midi === 48));
    sound.append(this.field("Base note", this.baseNote), label("Audio", this.audio));

    grid.append(view, layout, display, video, pacing, sound, engines);

    const footer = document.createElement("div");
    footer.className = "rm-footer";
    this.estimate.className = "rm-est";
    this.warning.className = "rm-warning";
    this.codecStatus.className = "rm-codec";
    const actions = document.createElement("div");
    actions.className = "rm-actions";
    const cancel = document.createElement("button");
    cancel.className = "rm-btn rm-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("pointerdown", () => this.close());
    this.record.className = "rm-btn rm-record";
    this.record.textContent = "Record";
    this.record.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.submit();
    });
    actions.append(cancel, this.record);
    footer.append(this.estimate, this.warning, this.codecStatus, actions);

    this.form.append(grid, footer);
    this.body.append(this.empty, this.form);
    this.installListeners();
  }

  /** Open with the already-snapshotted focused term, or null for the empty state. */
  openFor(term: Node | null): void {
    this.term = term;
    super.open();
  }

  protected override onOpen(): void {
    this.prefill();
    this.syncGraphNative();
    this.showTermState();
    this.refreshCodec();
    this.refreshPlan();
  }

  private field(text: string, control: HTMLElement): HTMLLabelElement {
    const el = document.createElement("label");
    el.className = "rm-choice";
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span, control);
    return el;
  }

  private installListeners(): void {
    const controls: HTMLElement[] = [
      this.view2d,
      this.view3d,
      ...this.layoutRadios.values(),
      this.expand,
      this.rules,
      this.graph,
      this.primitives,
      this.resolution,
      this.fps,
      this.stepMs,
      this.holdMs,
      this.baseNote,
      this.audio,
    ];
    for (const el of controls) {
      el.addEventListener("change", () => this.settingsChanged());
      el.addEventListener("input", () => this.settingsChanged());
    }
  }

  private settingsChanged(): void {
    this.syncGraphNative();
    this.queuePlanRefresh();
    this.paintAvailability();
  }

  private prefill(): void {
    const is3D = this.deps.is3D();
    this.view2d.checked = !is3D;
    this.view3d.checked = is3D;
    this.layoutRadios.get(this.deps.layout())!.checked = true;
    this.expand.checked = this.deps.expandIota();
    this.rules.checked = this.deps.rules();
    this.graph.checked = this.deps.graph();
    this.primitives.checked = this.deps.primitives();
    this.audio.checked = true;
    this.resolution.value = "1920x1080";
    this.fps.value = "60";
    this.stepMs.value = "300";
    this.holdMs.value = "1000";
    this.baseNote.value = "48";
  }

  private showTermState(): void {
    const hasTerm = this.term !== null;
    this.empty.hidden = hasTerm;
    this.form.hidden = !hasTerm;
  }

  private syncGraphNative(): void {
    const graphOn = this.graph.checked;
    this.primitives.disabled = graphOn;
    this.primitivesLabel.classList.toggle("disabled", graphOn);
    this.primitivesNote.textContent = graphOn ? "Graph mode ignores primitives, matching live reduction." : "";
  }

  private queuePlanRefresh(): void {
    if (this.planTimer !== undefined) window.clearTimeout(this.planTimer);
    this.planTimer = window.setTimeout(() => {
      this.planTimer = undefined;
      this.refreshPlan();
    }, 80);
  }

  private refreshPlan(): void {
    if (!this.term) {
      this.plan = null;
      this.estimate.textContent = "Estimated length: -";
      this.warning.textContent = "";
      this.paintAvailability();
      return;
    }
    const settings = this.settings();
    try {
      this.plan = precount(this.term, settings);
      this.estimate.textContent = `Estimated length: ${formatDuration(this.plan.durationSec)} (${this.plan.totalFrames} frames)`;
      this.warning.textContent = this.plan.capped ? `no normal form within ${settings.maxSteps} steps - records the first ${settings.maxSteps}` : "";
    } catch {
      this.plan = null;
      this.estimate.textContent = "Estimated length: -";
      this.warning.textContent = "";
    }
    this.paintAvailability();
  }

  private refreshCodec(): void {
    const seq = ++this.probeSeq;
    this.codec = undefined;
    this.codecError = "";
    this.codecStatus.textContent = "Codec: checking...";
    this.paintAvailability();
    void probeSupport()
      .then((support) => {
        if (seq !== this.probeSeq) return;
        this.codec = support;
        this.paintAvailability();
      })
      .catch((err: unknown) => {
        if (seq !== this.probeSeq) return;
        this.codec = { video: null, audio: null };
        this.codecError = messageOf(err);
        this.codecStatus.textContent = `Codec: ${this.codecError}`;
        this.paintAvailability();
      });
  }

  private settings(): RecordSettings {
    const [width, height] = this.resolution.value.split("x").map((n) => Number(n));
    const graph = this.graph.checked;
    const primitiveNative: NativeOpts = this.primitives.checked && !graph ? { numbers: true, lists: true, booleans: true } : {};
    const stepMs = Math.max(1, Math.round(this.stepMs.valueAsNumber || 300));
    const holdMs = Math.max(0, Math.round(this.holdMs.valueAsNumber || 0));
    return {
      view: this.view3d.checked ? "3d" : "2d",
      layout: this.selectedLayout(),
      expandIota: this.expand.checked,
      rules: this.rules.checked,
      graph,
      native: primitiveNative,
      width,
      height,
      fps: this.fps.value === "30" ? 30 : 60,
      stepMs,
      holdMs,
      baseNote: Number(this.baseNote.value),
      audio: this.audio.checked,
      maxSteps: graph ? GRAPH_MAX_STEPS : MAX_STEPS,
    };
  }

  private selectedLayout(): LayoutKey {
    for (const [key, input] of this.layoutRadios) if (input.checked) return key;
    return "auto";
  }

  private paintAvailability(): void {
    if (!this.term) {
      this.record.disabled = true;
      return;
    }
    const settings = this.settings();
    let disabled = false;
    let codecText = this.codecStatus.textContent || "";
    if (settings.view === "3d") {
      disabled = true;
      codecText = "3D recording is coming soon.";
    } else if (this.codec === undefined) {
      disabled = true;
      codecText = "Codec: checking...";
    } else if (!this.codec.video) {
      disabled = true;
      codecText = this.codecError ? `Codec: ${this.codecError}` : "Codec: recording unavailable - no supported video encoder.";
    } else if (settings.audio && !this.codec.audio) {
      disabled = true;
      codecText = "Codec: video ok; audio encoder unavailable. Turn Audio off for silent video.";
    } else {
      codecText = `Codec: ${this.codec.video}${settings.audio ? ` + ${this.codec.audio}` : ""}`;
    }
    if (!this.plan) disabled = true;
    this.codecStatus.textContent = codecText;
    this.record.disabled = disabled;
  }

  private submit(): void {
    if (!this.term) return;
    const settings = this.settings();
    if (!this.plan) {
      try {
        this.plan = precount(this.term, settings);
      } catch (err) {
        this.deps.onError(messageOf(err));
        return;
      }
    }
    if (!this.plan || this.record.disabled) return;
    const term = this.term;
    const plan = this.plan;
    this.close();
    this.deps.onRecord(term, settings, plan);
  }

  private applyRecordPalette(): void {
    const p = PALETTE[currentMode()];
    this.root.style.setProperty("--rm-red", p.red);
    this.root.style.setProperty("--rm-dim", p.dim);
  }
}

/** System-1 preview window for an in-progress offline recording. */
export class RecordPreviewOverlay {
  private readonly root = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly frame = document.createElement("div");
  private readonly fill = document.createElement("div");
  private cancel: (() => void) | undefined;

  constructor() {
    injectPreviewStyles();
    this.root.className = "rp-root";
    this.applyPalette();
    onThemeChange(() => this.applyPalette());

    const card = document.createElement("div");
    card.className = "rp-card";
    const title = document.createElement("div");
    title.className = "rp-title";
    const dot = document.createElement("div");
    dot.className = "rp-dot";
    const titleText = document.createElement("span");
    titleText.textContent = "Recording MP4";
    title.append(dot, titleText);

    const wrap = document.createElement("div");
    wrap.className = "rp-canvas-wrap";
    this.canvas.className = "rp-canvas";
    wrap.append(this.canvas);

    const footer = document.createElement("div");
    footer.className = "rp-footer";
    this.frame.className = "rp-frame";
    const cancel = document.createElement("button");
    cancel.className = "rp-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("pointerdown", () => this.cancel?.());
    const bar = document.createElement("div");
    bar.className = "rp-bar";
    this.fill.className = "rp-fill";
    bar.append(this.fill);
    footer.append(this.frame, cancel, bar);

    card.append(title, wrap, footer);
    this.root.append(card);
    document.body.append(this.root);
  }

  /** Show a fresh preview canvas sized to the recording output. */
  show(width: number, height: number, totalFrames: number, onCancel: () => void): void {
    this.cancel = onCancel;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.aspectRatio = `${width} / ${height}`;
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
    }
    this.update({ frame: 0, totalFrames });
    this.root.style.display = "flex";
  }

  /** Blit the latest encoded frame into the preview and update progress. */
  blit(source: HTMLCanvasElement, progress: RecordProgress): void {
    if (this.canvas.width !== source.width || this.canvas.height !== source.height) {
      this.canvas.width = source.width;
      this.canvas.height = source.height;
      this.canvas.style.aspectRatio = `${source.width} / ${source.height}`;
    }
    const ctx = this.canvas.getContext("2d");
    if (ctx) ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    this.update(progress);
  }

  /** Hide the preview and drop the cancel callback. */
  close(): void {
    this.cancel = undefined;
    this.root.style.display = "none";
  }

  private update(progress: RecordProgress): void {
    const total = Math.max(1, progress.totalFrames);
    const frame = Math.max(0, Math.min(progress.frame, total));
    this.frame.textContent = `frame ${frame} / ${total}`;
    this.fill.style.width = `${Math.max(0, Math.min(100, (frame / total) * 100))}%`;
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    this.root.style.setProperty("--rp-paper", p.paper);
    this.root.style.setProperty("--rp-ink", p.ink);
    this.root.style.setProperty("--rp-shadow", p.shadow);
    this.root.style.setProperty("--rp-red", p.red);
  }
}
