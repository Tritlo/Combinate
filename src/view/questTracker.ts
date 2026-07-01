/**
 * The tracked-quest HUD (ADR 13): a glanceable, always-visible card on the right rail
 * showing the *current* SKI-Quest objective while you build on the canvas — WoW-style.
 * A read-only reflection of {@link QuestPanel}'s state (it stays the sole owner/advancer
 * of `QuestProgress`); the tracker subscribes via `onAdvance` and reads `current/
 * location/done`. System-1 chrome to match the modals (the shared base is ADR 12).
 * Default visible until the quest is finished; the user's hide + collapse prefs persist.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";
import { type QuestStage, type QuestLocation } from "../core/quest";
import { CHAPTERS } from "../core/quest";
import { CATALOG, iotaTreeOf } from "../core/catalog";
import { type Node } from "../core/term";

/** What the tracker reads — the live quest state + how to open the full modal. */
export interface TrackerDeps {
  current: () => QuestStage | null;
  location: () => QuestLocation | null;
  done: () => boolean;
  openQuest: () => void;
}

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: "#ffffff", ink: "#000000", shadow: "rgba(0,0,0,0.85)", gold: "#8a6300" },
  dark: { paper: "#07090d", ink: "#f0f3f6", shadow: "rgba(0,0,0,0.85)", gold: "#f0b72f" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";
const STORE_KEY = "combinate:quest:tracker:v1";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.qt-root { position: fixed; top: 112px; right: 16px; width: min(320px, calc(100vw - 32px)); z-index: 40;
  font-family: ${MONO}; display: none; }
.qt-card { background: var(--qt-paper); color: var(--qt-ink); border: 1px solid var(--qt-ink);
  box-shadow: 2px 2px 0 var(--qt-shadow); }
.qt-title { display: flex; align-items: center; gap: 8px; padding: 3px 8px; background: var(--qt-ink); color: var(--qt-paper);
  cursor: pointer; user-select: none; }
.qt-title span { flex: 1; font-weight: 600; font-size: 12px; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qt-btn { width: 16px; height: 15px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--qt-paper); font-size: 11px; line-height: 1; cursor: pointer; }
.qt-body { padding: 9px 11px 11px; cursor: pointer; }
.qt-eyebrow { font-size: 11px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.04em; }
.qt-stage { font-weight: 700; font-size: 14px; margin: 2px 0 5px; }
.qt-obj { font-size: 12.5px; line-height: 1.35; }
.qt-obj code { background: color-mix(in srgb, var(--qt-ink) 12%, transparent); padding: 0 3px; border-radius: 2px; }
.qt-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 9px; }
.qt-prog { font-size: 11px; opacity: 0.6; }
.qt-reward { font-size: 11px; color: var(--qt-gold); border: 1px solid var(--qt-gold); padding: 0 6px; border-radius: 2px; white-space: nowrap; }
.qt-hint { margin-top: 9px; }
.qt-hintbtn { font-family: ${MONO}; font-size: 11px; color: var(--qt-ink); background: none;
  border: 1px solid var(--qt-ink); padding: 2px 10px; cursor: pointer; }
.qt-hinttext { margin-top: 4px; padding: 6px 9px; border-left: 2px solid var(--qt-gold);
  background: color-mix(in srgb, var(--qt-gold) 10%, transparent); font-size: 12px; line-height: 1.4; }
.qt-hinttext code { background: color-mix(in srgb, var(--qt-ink) 12%, transparent); padding: 0 3px; border-radius: 2px; }
.qt-iota { margin-top: 9px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--qt-ink) 18%, transparent); }
.qt-iolabel { font-size: 11px; opacity: 0.6; }
.qt-ioform { margin-top: 3px; font-size: 12px; line-height: 1.45; max-height: 4.4em; overflow-y: auto; word-break: break-word;
  color: color-mix(in srgb, var(--qt-ink) 75%, var(--qt-gold)); }
/* Tablet band: hide the tracker — the read-out drops beneath the (expanded) bar stack there, no room
   for it too. On phones (≤600) the bars collapse to a gear, so the tracker comes back, sitting just
   below the gear (the read-out then stacks beneath it). */
@media (min-width: 601px) and (max-width: 1100px) { .qt-root { display: none !important; } }
@media (max-width: 600px) { .qt-root { top: 88px; width: min(320px, calc(100vw - 24px)); } }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** Render an ι-tree as text: `ι`, `ι ι`, `ι (ι ι)`, … */
function iotaForm(n: Node): string {
  if (n.kind === "iota") return "ι";
  if (n.kind === "app") {
    const a = n.arg.kind === "app" ? `(${iotaForm(n.arg)})` : iotaForm(n.arg);
    return `${iotaForm(n.fn)} ${a}`;
  }
  return n.kind === "comb" ? n.sym : "?";
}
const iotaCount = (n: Node): number => (n.kind === "app" ? iotaCount(n.fn) + iotaCount(n.arg) : n.kind === "iota" ? 1 : 0);

/** The unlock bird's ι-form + ι-count for the preview, or null if it isn't a catalog bird. */
function iotaPreview(sym: string | undefined): { form: string; count: number } | null {
  if (!sym) return null;
  const law = CATALOG.find((l) => l.sym === sym);
  if (!law) return null;
  const t = iotaTreeOf(law);
  return { form: iotaForm(t), count: iotaCount(t) };
}

/** Strip HTML to plain text (the objective line) but keep `<code>` content readable. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class QuestTracker {
  private readonly root = document.createElement("div");
  private readonly titleLabel = document.createElement("span");
  private readonly collapseBtn = document.createElement("div");
  private readonly body = document.createElement("div");
  private hidden = false; // user hid it (View ▸ Track Quest)
  private collapsed = false;
  private hintShown = false; // reveal the current stage's hint (reset when the stage advances)
  private lastStageId: string | null = null;
  /** Fired after every re-render so the shell can restack phone overlays below this card. */
  onLayout: (() => void) | undefined;

  constructor(private readonly deps: TrackerDeps) {
    injectStyles();
    this.load();
    this.root.className = "qt-root";
    this.applyPalette();

    const card = document.createElement("div");
    card.className = "qt-card";

    const title = document.createElement("div");
    title.className = "qt-title";
    title.addEventListener("pointerdown", () => this.toggleCollapsed());
    this.collapseBtn.className = "qt-btn";
    this.titleLabel.textContent = "Tracked Quest";
    const hideBtn = document.createElement("div");
    hideBtn.className = "qt-btn";
    hideBtn.textContent = "✕";
    hideBtn.title = "Hide (View ▸ Track Quest to restore)";
    hideBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.setHidden(true);
    });
    title.append(this.collapseBtn, this.titleLabel, hideBtn);

    this.body.className = "qt-body";
    this.body.addEventListener("pointerdown", () => this.deps.openQuest());

    card.append(title, this.body);
    this.root.append(card);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    this.refresh();
  }

  /** Re-read quest state and re-render (called on init + every advance). */
  refresh(): void {
    const stage = this.deps.current();
    const loc = this.deps.location();
    const visible = !this.hidden && !this.deps.done() && !!stage && !!loc;
    this.root.style.display = visible ? "block" : "none";
    this.collapseBtn.textContent = this.collapsed ? "▸" : "▾";
    this.body.style.display = this.collapsed ? "none" : "block";
    if (!visible || !stage || !loc) {
      this.onLayout?.();
      return;
    }
    if (stage.id !== this.lastStageId) {
      this.lastStageId = stage.id;
      this.hintShown = false; // a new stage — hide the hint again
    }
    this.titleLabel.textContent = this.collapsed ? stage.name : "Tracked Quest";
    const kids: HTMLElement[] = [
      el("div", "qt-eyebrow", loc.chapter.name.replace(/<[^>]+>/g, "")),
      el("div", "qt-stage", stage.name.replace(/<[^>]+>/g, "")),
      objective(stage),
      meta(loc, stage),
    ];
    if (stage.hint) kids.push(this.hintSection(stage.hint)); // same `stage.hint` the modal shows
    const prev = iotaPreview(stage.unlock); // the target bird, in ι form (ADR 13)
    if (prev) {
      const wrap = document.createElement("div");
      wrap.className = "qt-iota";
      wrap.append(el("div", "qt-iolabel", `discover ${stage.unlock}  ·  ${prev.count} ι`), el("div", "qt-ioform", prev.form));
      kids.push(wrap);
    }
    this.body.replaceChildren(...kids);
    this.onLayout?.();
  }

  /** The card's bottom edge in viewport px, or 0 when hidden — for stacking the read-out below it. */
  bottom(): number {
    if (getComputedStyle(this.root).display === "none") return 0;
    return this.root.getBoundingClientRect().bottom;
  }

  /** A compact "Show hint" toggle that reveals the current stage's hint — the same `stage.hint`
   *  the Quest modal shows, so the two stay in sync. */
  private hintSection(hint: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "qt-hint";
    if (this.hintShown) {
      const h = document.createElement("div");
      h.className = "qt-hinttext";
      h.innerHTML = `Hint:  ${hint}`;
      wrap.append(h);
    } else {
      const btn = document.createElement("button");
      btn.className = "qt-hintbtn";
      btn.textContent = "Show hint";
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); // the body's pointerdown opens the modal; a hint click must not
        this.hintShown = true;
        this.refresh();
      });
      wrap.append(btn);
    }
    return wrap;
  }

  /** Hide / show the tracker (the View-menu toggle). Persisted. */
  setHidden(b: boolean): void {
    this.hidden = b;
    this.save();
    this.refresh();
  }
  get isHidden(): boolean {
    return this.hidden;
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.save();
    this.refresh();
  }

  private load(): void {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as { hidden?: boolean; collapsed?: boolean };
      this.hidden = !!s.hidden;
      this.collapsed = !!s.collapsed;
    } catch {
      /* defaults */
    }
  }
  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ hidden: this.hidden, collapsed: this.collapsed }));
    } catch {
      /* ignore */
    }
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--qt-${k}`, v);
  }
}

const el = (tag: string, cls: string, text: string): HTMLElement => {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
};

/** The objective: the last intro line as HTML (keeps `<code>` formulas), or a fallback. */
function objective(stage: QuestStage): HTMLElement {
  const last = [...stage.intro].reverse().find((l) => plain(l).length > 0);
  const n = document.createElement("div");
  n.className = "qt-obj";
  if (last && plain(last).length > 0) n.innerHTML = last;
  else n.textContent = "Build it on the canvas.";
  return n;
}

function meta(loc: QuestLocation, stage: QuestStage): HTMLElement {
  const row = document.createElement("div");
  row.className = "qt-meta";
  row.append(el("div", "qt-prog", `Stage ${loc.stageInChapter + 1}/${loc.chapter.stages.length} · Chapter ${loc.chapterIndex + 1}/${CHAPTERS.length}`));
  if (stage.unlock) row.append(el("div", "qt-reward", `unlocks ${stage.unlock}`));
  return row;
}
