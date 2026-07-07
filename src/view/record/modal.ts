/**
 * The MP4 recording UI (ADR 24): a System-1 modal that gathers record settings
 * and a lightweight preview window that shows the offline render as frames land.
 */
import type { Node } from "../../core/term";
import type { NativeOpts } from "../../core/native";
import { Modal } from "../modal";
import type { LayoutKey } from "../layoutControls";
import { currentMode, ensureFont, INK, MONO, onThemeChange, PAPER, type Mode } from "../theme";
import { renderFirstFrame } from "./driver";
import { probeSupport } from "./encoder";
import { precount } from "./precount";
import type { CodecSupport, RecordInfo, RecordPlan, RecordProgress, RecordSettings } from "./types";

type RecordLayoutKey = Exclude<LayoutKey, "auto">;

const MAX_STEPS = 2000;
const GRAPH_MAX_STEPS = 100_000;
const THUMB_W = 320;
const RESOLUTIONS = [
  { label: "1080×1080", width: 1080, height: 1080 },
  { label: "1920×1080", width: 1920, height: 1080 },
  { label: "1280×720", width: 1280, height: 720 },
] as const;
const BASE_NOTES = [
  { label: "None", value: "none" },
  { label: "C2", value: "36" },
  { label: "G2", value: "43" },
  { label: "C3", value: "48" },
  { label: "G3", value: "55" },
  { label: "C4", value: "60" },
] as const;
const SPIN_REVS = [
  { label: "1x", value: "1" },
  { label: "2x", value: "2" },
  { label: "4x", value: "4" },
] as const;

const PALETTE: Record<Mode, { paper: string; ink: string; shadow: string; red: string; dim: string }> = {
  light: { paper: PAPER.light, ink: INK.light, shadow: "rgba(0,0,0,0.65)", red: "#b42318", dim: "rgba(27,31,36,0.62)" },
  dark: { paper: PAPER.dark, ink: INK.dark, shadow: "rgba(0,0,0,0.85)", red: "#ff6b5f", dim: "rgba(240,246,252,0.62)" },
};
const LAYOUT_HINTS: Record<RecordLayoutKey, string> = {
  topdown: "Leaves line up; depth grows downward.",
  radial: "Root in the centre; depth becomes radius.",
  htree: "Compact alternating-axis H-tree layout.",
};

let modalStylesInjected = false;
function injectModalStyles(): void {
  if (modalStylesInjected) return;
  modalStylesInjected = true;
  const css = `
.rm-card { max-height: min(90vh, calc(100vh - 20px)); }
.rm-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
.rm-body [hidden] { display: none !important; }
.rm-empty { padding: 18px 4px 4px; line-height: 1.45; opacity: 0.72; }
.rm-form { display: flex; flex-direction: column; gap: 10px; }
.rm-grid { display: grid; grid-template-columns: minmax(250px, 0.92fr) minmax(310px, 1.08fr); gap: 10px 12px; align-items: start; }
.rm-col { min-width: 0; display: flex; flex-direction: column; gap: 9px; }
.rm-bottom { grid-column: 1 / -1; min-width: 0; }
.rm-section { border: 1px solid color-mix(in srgb, var(--md-ink) 60%, transparent); padding: 7px 8px 8px; display: flex; flex-direction: column; gap: 7px; }
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
.rm-preview-box { width: 100%; box-sizing: border-box; padding: 4px; border: 1px solid var(--md-ink); background: var(--md-paper);
  box-shadow: 2px 2px 0 var(--rm-shadow); }
.rm-thumb { display: block; width: 100%; height: auto; background: #000; }
.rm-footer { border-top: 1px solid color-mix(in srgb, var(--md-ink) 35%, transparent); padding-top: 8px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: end; }
.rm-est, .rm-codec, .rm-warning { min-height: 1.25em; font-size: 12px; line-height: 1.35; }
.rm-warning { color: var(--rm-red); }
.rm-actions { grid-column: 2; grid-row: 1 / 4; display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
.rm-btn { font-family: inherit; font-size: 13px; font-weight: 700; padding: 4px 15px; cursor: pointer; border: 1px solid var(--md-ink); }
.rm-cancel { color: var(--md-ink); background: var(--md-paper); }
.rm-record { color: var(--md-paper); background: var(--md-ink); }
.rm-record:disabled { opacity: 0.45; cursor: default; }
.rm-tip { position: fixed; display: none; max-width: 280px; padding: 5px 9px; z-index: 62; pointer-events: none;
  background: var(--md-paper); color: var(--md-ink); border: 1px solid var(--md-ink); box-shadow: 2px 2px 0 var(--rm-shadow);
  font-family: ${MONO}; font-size: 12px; line-height: 1.45; white-space: normal; }
@media (max-width: 560px) {
  .rm-card { width: calc(100vw - 16px); max-height: calc(100vh - 18px); }
  .rm-body { padding: 10px 11px 12px; gap: 9px; }
  .rm-grid { grid-template-columns: 1fr; }
  .rm-col { display: contents; }
  .rm-bottom { grid-column: 1; order: 8; }
  .rm-preview { order: 1; }
  .rm-view { order: 2; }
  .rm-layout { order: 3; }
  .rm-video { order: 4; }
  .rm-pacing { order: 5; }
  .rm-audio { order: 6; }
  .rm-overlays { order: 7; }
  .rm-section { padding: 8px; gap: 7px; }
  .rm-row { gap: 6px 8px; }
  .rm-choice { min-height: 40px; }
  .rm-input, .rm-select { min-height: 40px; }
  .rm-footer { display: flex; flex-direction: column; gap: 7px; }
  .rm-actions { justify-content: stretch; }
  .rm-btn { flex: 1 1 0; min-height: 40px; padding: 6px 12px; }
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
  color: () => boolean;
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
  private readonly tip = document.createElement("div");
  private readonly thumb = document.createElement("canvas");
  private readonly view2d = radio("rm-view", "2d");
  private readonly view3d = radio("rm-view", "3d");
  private readonly rotate = checkbox();
  private readonly rotateLabel: HTMLLabelElement;
  private readonly spinRevs = document.createElement("select");
  private readonly spinLabel: HTMLLabelElement;
  private readonly themeRadios = new Map<Mode, HTMLInputElement>();
  private readonly color = checkbox();
  private readonly layoutRadios = new Map<RecordLayoutKey, HTMLInputElement>();
  private readonly expand = checkbox();
  private readonly rules = checkbox();
  private readonly graph = checkbox();
  private readonly primitives = checkbox();
  private readonly primitivesLabel: HTMLLabelElement;
  private readonly primitivesNote = document.createElement("div");
  private readonly cameraRadios = new Map<RecordSettings["camera"], HTMLInputElement>();
  private readonly resolution = document.createElement("select");
  private readonly fps = document.createElement("select");
  private readonly stepMs = document.createElement("input");
  private readonly holdMs = document.createElement("input");
  private readonly baseNote = document.createElement("select");
  private readonly zen = checkbox();
  private readonly overlayInfo = checkbox();
  private readonly overlayInfoLabel: HTMLLabelElement;
  private readonly overlayStats = checkbox();
  private readonly overlayStatsLabel: HTMLLabelElement;
  private readonly estimate = document.createElement("div");
  private readonly warning = document.createElement("div");
  private readonly codecStatus = document.createElement("div");
  private readonly record = document.createElement("button");
  private term: Node | null = null;
  private info: RecordInfo | undefined;
  private plan: RecordPlan | null = null;
  private codec: CodecSupport | undefined;
  private codecError = "";
  private probeSeq = 0;
  private planTimer: number | undefined;
  private previewSeq = 0;
  private previewTimer: number | undefined;

  constructor(private readonly deps: RecordModalDeps) {
    super({ title: "Record MP4", width: "min(760px, 96vw)" });
    injectModalStyles();
    this.card.classList.add("rm-card");
    this.body.classList.add("rm-body");
    this.tip.className = "rm-tip";
    this.root.append(this.tip);
    this.applyRecordPalette();
    onThemeChange(() => this.applyRecordPalette());

    this.empty.className = "rm-empty";
    this.empty.textContent = "Nothing to record. Focus a tree first.";

    this.form.className = "rm-form";
    const grid = document.createElement("div");
    grid.className = "rm-grid";
    const leftCol = document.createElement("div");
    leftCol.className = "rm-col";
    const rightCol = document.createElement("div");
    rightCol.className = "rm-col";
    const bottom = document.createElement("div");
    bottom.className = "rm-bottom";

    const preview = section("Preview");
    preview.classList.add("rm-preview");
    const previewBox = document.createElement("div");
    previewBox.className = "rm-preview-box";
    this.thumb.className = "rm-thumb";
    previewBox.append(this.thumb);
    preview.append(previewBox);

    const view = section("View");
    view.classList.add("rm-view");
    const viewRow = document.createElement("div");
    viewRow.className = "rm-row";
    this.rotateLabel = this.hinted(label("Rotate", this.rotate), "Turntable camera orbit.");
    this.spinRevs.className = "rm-select";
    for (const spin of SPIN_REVS) this.spinRevs.append(selectOption(spin.value, spin.label, spin.value === "1"));
    this.spinLabel = this.field("Spin", this.spinRevs, "Turntable speed: revolutions per clip.");
    viewRow.append(
      this.hinted(label("2D", this.view2d), "Render the flat canvas view."),
      this.hinted(label("3D", this.view3d), "Render the 3D tree view."),
      this.rotateLabel,
      this.spinLabel,
    );
    const themeRow = document.createElement("div");
    themeRow.className = "rm-row";
    for (const mode of ["light", "dark"] as const) {
      const input = radio("rm-theme", mode);
      this.themeRadios.set(mode, input);
      themeRow.append(this.hinted(label(mode === "light" ? "Light" : "Dark", input), "Record in either theme without changing the app."));
    }
    themeRow.append(this.hinted(label("Colour", this.color), "Per-combinator hues (Colour 4096)."));
    view.append(
      viewRow,
      themeRow,
    );

    const layout = section("Layout");
    layout.classList.add("rm-layout");
    const layoutRow = document.createElement("div");
    layoutRow.className = "rm-row";
    for (const [key, text] of [
      ["topdown", "Top-Down"],
      ["radial", "Radial"],
      ["htree", "H-Tree"],
    ] as const) {
      const input = radio("rm-layout", key);
      this.layoutRadios.set(key, input);
      layoutRow.append(this.hinted(label(text, input), LAYOUT_HINTS[key]));
    }
    layout.append(layoutRow, this.hinted(label("Expand-ι", this.expand), "Expand named birds to their raw ι trees."));

    const engines = section("Engines");
    const engineRow = document.createElement("div");
    engineRow.className = "rm-row";
    this.primitivesLabel = this.hinted(label("Primitives", this.primitives), "Use native number/list/boolean kernels.");
    engineRow.append(
      this.hinted(label("Rules", this.rules), "Catalog rewrite laws fire as single steps."),
      this.hinted(label("Graph", this.graph), "Use call-by-need sharing; primitives do not apply."),
      this.primitivesLabel,
    );
    this.primitivesNote.className = "rm-note";
    engines.append(engineRow, this.primitivesNote);

    const video = section("Video");
    video.classList.add("rm-video");
    this.resolution.className = "rm-select";
    for (const r of RESOLUTIONS) this.resolution.append(selectOption(`${r.width}x${r.height}`, r.label, r.width === r.height));
    this.hinted(this.resolution, "Pick the output pixel size.");
    this.fps.className = "rm-select";
    this.fps.append(selectOption("30", "30 fps"), selectOption("60", "60 fps", true));
    this.hinted(this.fps, "Pick the output frame rate.");
    const cameraRow = document.createElement("div");
    cameraRow.className = "rm-row";
    for (const [key, text, hint] of [
      ["hold", "Hold", "One zoom for the whole clip - no rescaling."],
      ["fixed", "Fixed", "Fit the first frame only."],
      ["follow", "Follow", "Re-frame every step."],
    ] as const) {
      const input = radio("rm-camera", key);
      this.cameraRadios.set(key, input);
      cameraRow.append(this.hinted(label(text, input), hint));
    }
    video.append(this.field("Resolution", this.resolution, "Pick the output pixel size."), this.field("FPS", this.fps, "Pick the output frame rate."), cameraRow);

    const pacing = section("Pacing");
    pacing.classList.add("rm-pacing");
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
    pacing.append(
      this.field("Step ms", this.stepMs, "Output-time per reduction step."),
      this.field("Hold ms", this.holdMs, "Freeze on the final frame."),
    );

    const sound = section("Audio");
    sound.classList.add("rm-audio");
    this.baseNote.className = "rm-select";
    for (const n of BASE_NOTES) this.baseNote.append(selectOption(n.value, n.label, n.value === "48"));
    sound.append(this.field("Base note", this.baseNote, "Root pitch of the tone track; None = silent."));

    const overlays = section("Overlays");
    overlays.classList.add("rm-overlays");
    this.overlayInfoLabel = this.hinted(label("Info card", this.overlayInfo), "Burn the term's name and live value into the video.");
    this.overlayStatsLabel = this.hinted(label("Stats", this.overlayStats), "Step counter and node count, bottom-right.");
    overlays.append(
      this.hinted(label("Zen", this.zen), "Clean frames - no overlays."),
      this.overlayInfoLabel,
      this.overlayStatsLabel,
    );

    leftCol.append(preview, sound, overlays);
    rightCol.append(view, layout, video, pacing);
    bottom.append(engines);
    grid.append(leftCol, rightCol, bottom);

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
    this.hinted(cancel, "Close without recording.");
    cancel.addEventListener("pointerdown", () => this.close());
    this.record.className = "rm-btn rm-record";
    this.record.textContent = "Record";
    this.hinted(this.record, "Render and download the MP4.");
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
  openFor(term: Node | null, info?: RecordInfo): void {
    this.term = term;
    this.info = info;
    super.open();
  }

  override close(): void {
    this.hideTip();
    super.close();
  }

  protected override onOpen(): void {
    this.prefill();
    this.syncGraphNative();
    this.showTermState();
    this.refreshCodec();
    this.refreshPlan();
    this.refreshPreview();
  }

  private field(text: string, control: HTMLElement, hint: string): HTMLLabelElement {
    const el = document.createElement("label");
    el.className = "rm-choice";
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span, control);
    return this.hinted(el, hint);
  }

  private hinted<T extends HTMLElement>(el: T, text: string): T {
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch") return;
      this.showTip(text, el);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch" || this.tip.style.display !== "block") return;
      this.showTip(text, el);
    });
    el.addEventListener("pointerleave", () => this.hideTip());
    el.addEventListener("pointercancel", () => this.hideTip());
    return el;
  }

  private showTip(text: string, el: HTMLElement): void {
    this.tip.textContent = text;
    this.tip.style.display = "block";
    const r = el.getBoundingClientRect();
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    const x = r.right + 8 + w > window.innerWidth - 6 ? Math.max(6, r.left - w - 8) : r.right + 8;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${Math.max(6, Math.min(r.top, window.innerHeight - h - 6))}px`;
  }

  private hideTip(): void {
    this.tip.style.display = "none";
  }

  private installListeners(): void {
    const controls: HTMLElement[] = [
      this.view2d,
      this.view3d,
      this.rotate,
      this.spinRevs,
      ...this.themeRadios.values(),
      this.color,
      ...this.layoutRadios.values(),
      this.expand,
      this.rules,
      this.graph,
      this.primitives,
      ...this.cameraRadios.values(),
      this.resolution,
      this.fps,
      this.stepMs,
      this.holdMs,
      this.baseNote,
      this.zen,
      this.overlayInfo,
      this.overlayStats,
    ];
    for (const el of controls) {
      el.addEventListener("change", () => this.settingsChanged());
      el.addEventListener("input", () => this.settingsChanged());
    }
  }

  private settingsChanged(): void {
    this.syncViewControls();
    this.syncGraphNative();
    this.syncOverlayControls();
    this.queuePlanRefresh();
    this.queuePreviewRefresh();
    this.paintAvailability();
  }

  private prefill(): void {
    const is3D = this.deps.is3D();
    this.view2d.checked = !is3D;
    this.view3d.checked = is3D;
    this.rotate.checked = false;
    this.spinRevs.value = "1";
    this.themeRadios.get(currentMode())!.checked = true;
    this.color.checked = this.deps.color();
    this.layoutRadios.get(this.prefillLayout())!.checked = true;
    this.expand.checked = this.deps.expandIota();
    this.rules.checked = this.deps.rules();
    this.graph.checked = this.deps.graph();
    this.primitives.checked = this.deps.primitives();
    this.cameraRadios.get("hold")!.checked = true;
    this.resolution.value = "1080x1080";
    this.fps.value = "60";
    this.stepMs.value = "300";
    this.holdMs.value = "1000";
    this.baseNote.value = "48";
    this.zen.checked = false;
    this.overlayInfo.checked = false;
    this.overlayStats.checked = false;
    this.syncViewControls();
    this.syncOverlayControls();
  }

  private prefillLayout(): RecordLayoutKey {
    const current = this.deps.layout();
    if (current !== "auto") return current;
    return "htree";
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

  private syncViewControls(): void {
    const is3D = this.view3d.checked;
    this.rotate.disabled = !is3D;
    this.rotateLabel.classList.toggle("disabled", !is3D);
    const spinEnabled = is3D && this.rotate.checked;
    this.spinRevs.disabled = !spinEnabled;
    this.spinLabel.classList.toggle("disabled", !spinEnabled);
  }

  private syncOverlayControls(): void {
    const zen = this.zen.checked;
    this.overlayInfo.disabled = zen;
    this.overlayStats.disabled = zen;
    this.overlayInfoLabel.classList.toggle("disabled", zen);
    this.overlayStatsLabel.classList.toggle("disabled", zen);
  }

  private queuePlanRefresh(): void {
    if (this.planTimer !== undefined) window.clearTimeout(this.planTimer);
    this.planTimer = window.setTimeout(() => {
      this.planTimer = undefined;
      this.refreshPlan();
    }, 80);
  }

  private queuePreviewRefresh(): void {
    if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = undefined;
      this.refreshPreview();
    }, 300);
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

  private refreshPreview(): void {
    const settings = this.settings();
    const seq = ++this.previewSeq;
    this.drawPreviewPlaceholder(settings);
    if (!this.term) return;
    void renderFirstFrame(this.term, settings)
      .then((canvas) => {
        if (seq !== this.previewSeq) return;
        this.drawPreviewCanvas(canvas, settings);
      })
      .catch(() => {
        if (seq !== this.previewSeq) return;
        this.drawPreviewPlaceholder(settings);
      });
  }

  private resizeThumb(settings: RecordSettings): void {
    const w = THUMB_W;
    const h = Math.max(1, Math.round((THUMB_W * settings.height) / Math.max(1, settings.width)));
    this.thumb.width = w;
    this.thumb.height = h;
    this.thumb.style.aspectRatio = `${settings.width} / ${settings.height}`;
  }

  private drawPreviewPlaceholder(settings: RecordSettings): void {
    this.resizeThumb(settings);
    const ctx = this.thumb.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.thumb.width, this.thumb.height);
  }

  private drawPreviewCanvas(source: HTMLCanvasElement, settings: RecordSettings): void {
    this.resizeThumb(settings);
    const ctx = this.thumb.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(source, 0, 0, this.thumb.width, this.thumb.height);
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
    const audio = this.baseNote.value !== "none";
    const zen = this.zen.checked;
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
      baseNote: audio ? Number(this.baseNote.value) : 48,
      audio,
      maxSteps: graph ? GRAPH_MAX_STEPS : MAX_STEPS,
      theme: this.selectedTheme(),
      color: this.color.checked,
      spinRevs: Number(this.spinRevs.value) || 1,
      camera: this.selectedCamera(),
      rotate: this.view3d.checked && this.rotate.checked,
      overlayInfo: !zen && this.overlayInfo.checked,
      overlayStats: !zen && this.overlayStats.checked,
      info: !zen && this.overlayInfo.checked ? this.info : undefined,
    };
  }

  private selectedTheme(): Mode {
    for (const [mode, input] of this.themeRadios) if (input.checked) return mode;
    return currentMode();
  }

  private selectedCamera(): RecordSettings["camera"] {
    for (const [camera, input] of this.cameraRadios) if (input.checked) return camera;
    return "hold";
  }

  private selectedLayout(): RecordLayoutKey {
    for (const [key, input] of this.layoutRadios) if (input.checked) return key;
    return "topdown";
  }

  private paintAvailability(): void {
    if (!this.term) {
      this.record.disabled = true;
      return;
    }
    const settings = this.settings();
    let disabled = false;
    let codecText = this.codecStatus.textContent || "";
    if (this.codec === undefined) {
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
    if (!this.term || this.record.disabled) return;
    const settings = this.settings();
    // Recompute from the CURRENT settings — the debounced this.plan can be
    // stale when Record lands within the refresh window, and the driver
    // rejects any plan whose frame budget doesn't match the settings.
    let plan: RecordPlan;
    try {
      plan = precount(this.term, settings);
    } catch (err) {
      this.deps.onError(messageOf(err));
      return;
    }
    const term = this.term;
    this.close();
    this.deps.onRecord(term, settings, plan);
  }

  private applyRecordPalette(): void {
    const p = PALETTE[currentMode()];
    this.root.style.setProperty("--rm-red", p.red);
    this.root.style.setProperty("--rm-dim", p.dim);
    this.root.style.setProperty("--rm-shadow", p.shadow);
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
