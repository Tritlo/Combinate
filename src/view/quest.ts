/**
 * The Quest panel (a Special): a System-1 window that narrates the current
 * {@link QuestStage} — story, task, and an on-demand hint — and tracks progress.
 * You build the answer on the canvas; the shell calls {@link QuestPanel.onNormalForm}
 * when a tree settles, which advances the quest and announces a solve. Adapted,
 * with permission, from Konstantin S. Uvarin's SKI Quest.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";
import { CHAPTERS, QUEST, locate, QuestProgress, type QuestStage, type QuestLocation } from "../core/quest";
import { type Node } from "../core/term";

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: "#ffffff", ink: "#000000", backdrop: "rgba(27,31,36,0.5)", shadow: "rgba(0,0,0,0.85)", gold: "#8a6300" },
  dark: { paper: "#07090d", ink: "#f0f3f6", backdrop: "rgba(1,4,9,0.6)", shadow: "rgba(0,0,0,0.85)", gold: "#f0b72f" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.qs-root { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center;
  background: var(--qs-backdrop); font-family: ${MONO}; }
.qs-card { width: min(500px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--qs-paper); color: var(--qs-ink); border: 1px solid var(--qs-ink); box-shadow: 2px 2px 0 var(--qs-shadow); }
.qs-title { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: var(--qs-ink); color: var(--qs-paper); }
.qs-close { width: 12px; height: 12px; border: 1.5px solid var(--qs-paper); cursor: pointer; flex: 0 0 auto; }
.qs-title span { font-weight: 600; font-size: 14px; }
.qs-body { padding: 16px 20px 18px; overflow-y: auto; font-size: 14px; line-height: 1.5; }
.qs-prog { font-size: 11px; letter-spacing: 0.08em; opacity: 0.55; text-transform: uppercase; }
.qs-chap { font-weight: 600; opacity: 0.85; }
.qs-steps { display: flex; gap: 5px; margin: 9px 0 2px; }
.qs-step { width: 11px; height: 11px; border: 1.5px solid var(--qs-ink); box-sizing: border-box; }
.qs-step.done { background: var(--qs-ink); }
.qs-step.now { border-color: var(--qs-gold); box-shadow: inset 0 0 0 2px var(--qs-gold); }
.qs-name { font-size: 24px; font-weight: 600; margin: 6px 0 10px; }
.qs-blurb { font-style: italic; opacity: 0.7; margin: 8px 0 2px; }
.qs-body code { background: color-mix(in srgb, var(--qs-ink) 12%, transparent); padding: 0 3px; border-radius: 2px; }
.qs-body p { margin: 0 0 9px; }
.qs-task { margin-top: 12px; font-size: 13px; opacity: 0.7; }
.qs-hint { margin-top: 10px; }
.qs-hintbtn { font-family: ${MONO}; font-size: 12px; color: var(--qs-ink); background: none;
  border: 1px solid var(--qs-ink); padding: 3px 12px; cursor: pointer; }
.qs-hinttext { margin-top: 8px; padding: 8px 10px; border-left: 2px solid var(--qs-gold);
  background: color-mix(in srgb, var(--qs-gold) 10%, transparent); font-size: 13px; }
.qs-foot { display: flex; justify-content: space-between; align-items: center; padding: 0 20px 16px; }
.qs-reset { font-family: ${MONO}; font-size: 12px; color: var(--qs-ink); background: none; border: 1px solid color-mix(in srgb, var(--qs-ink) 45%, transparent);
  padding: 4px 12px; cursor: pointer; opacity: 0.7; }
.qs-reset:hover { opacity: 1; }
.qs-done { font-family: ${MONO}; font-size: 13px; font-weight: 600; color: var(--qs-paper); background: var(--qs-ink);
  border: 1px solid var(--qs-ink); padding: 4px 16px; cursor: pointer; }
.qs-finale { font-size: 16px; }
.qs-log { margin-top: 16px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--qs-ink) 25%, transparent); }
.qs-logh { font-size: 11px; letter-spacing: 0.06em; opacity: 0.5; text-transform: uppercase; margin-bottom: 6px; font-weight: 600; }
.qs-logch { font-size: 11px; opacity: 0.45; margin: 8px 0 2px; }
.qs-logrow { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; font-size: 12.5px; }
.qs-logname { flex: 1; opacity: 0.8; }
.qs-logunlock { font-size: 11px; color: var(--qs-gold); white-space: nowrap; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

export interface QuestOpts {
  /** Surface a short message (wired to the toast). */
  notify: (msg: string) => void;
  /** Reveal a combinator the player just built (wired to the shell's discover). */
  onUnlock: (sym: string) => void;
}

export class QuestPanel {
  private readonly root = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly titleLabel = document.createElement("span");
  private readonly progress = new QuestProgress();
  private hintShown = false;
  private readonly advanceListeners: Array<() => void> = [];

  constructor(private readonly opts: QuestOpts) {
    injectStyles();
    this.root.className = "qs-root";
    this.applyPalette();
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    const card = document.createElement("div");
    card.className = "qs-card";
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "qs-title";
    const close = document.createElement("div");
    close.className = "qs-close";
    close.title = "Close";
    close.addEventListener("pointerdown", () => this.close());
    this.titleLabel.textContent = "Quest";
    title.append(close, this.titleLabel);

    this.body.className = "qs-body";

    const foot = document.createElement("div");
    foot.className = "qs-foot";
    const reset = document.createElement("button");
    reset.className = "qs-reset";
    reset.textContent = "Reset progress";
    let confirming = false;
    reset.addEventListener("pointerdown", () => {
      if (!confirming) {
        confirming = true;
        reset.textContent = "Reset — sure?";
        return;
      }
      this.progress.reset();
      this.hintShown = false;
      for (const cb of this.advanceListeners) cb(); // refresh the tracker + the in-HUD hint
      this.render();
      confirming = false;
      reset.textContent = "Reset progress";
    });
    const done = document.createElement("button");
    done.className = "qs-done";
    done.textContent = "Done";
    done.addEventListener("pointerdown", () => this.close());
    foot.append(reset, done);

    card.append(title, this.body, foot);
    this.root.append(card);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.style.display === "flex") this.close();
    });
    this.render();
  }

  get isOpen(): boolean {
    return this.root.style.display === "flex";
  }
  /** Current stage index (=== QUEST.length when finished) — for the dev seam/tests. */
  get stageIndex(): number {
    return this.progress.stage;
  }
  // Read-only views of quest state, for the tracked-quest HUD (ADR 13) — the panel
  // stays the sole owner/advancer of progress; the tracker only reflects it.
  get current(): QuestStage | null {
    return this.progress.current;
  }
  get location(): QuestLocation | null {
    return this.progress.location;
  }
  get done(): boolean {
    return this.progress.done;
  }
  /** Subscribe to stage advances (fired after a solve) — the tracker re-renders. */
  onAdvance(cb: () => void): void {
    this.advanceListeners.push(cb);
  }
  open(): void {
    this.render();
    this.root.style.display = "flex";
    this.body.scrollTop = 0; // show the current (pinned) quest at the top, not the log below
  }
  close(): void {
    this.root.style.display = "none";
  }
  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** A tree settled at normal form: advance the quest if it solves the current
   *  stage, reveal its unlock, and announce it. Runs whether or not the panel is
   *  open (you build on the canvas). */
  onNormalForm(built: Node): void {
    const solved = this.progress.check(built);
    if (!solved) return;
    if (solved.unlock) this.opts.onUnlock(solved.unlock);
    this.opts.notify(this.progress.done ? `Quest complete — you built it all from ι!` : `Quest: solved "${solved.name}"! →`);
    this.hintShown = false;
    if (this.isOpen) this.render();
    for (const cb of this.advanceListeners) cb(); // refresh the tracked-quest HUD
  }

  private render(): void {
    this.body.replaceChildren();
    const loc = this.progress.location;
    const stage = this.progress.current;
    this.titleLabel.textContent = loc ? `Quest — ${loc.chapter.name}` : "Quest";
    if (!stage || !loc) {
      const f = document.createElement("div");
      f.className = "qs-finale";
      f.innerHTML =
        "<p>🌿 <b>Ex uno plures.</b> From one, many.</p>" +
        "<p>From the basis to birds, booleans, numerals, pairs, lists, and recursion — " +
        "every combinator in the SKI Quest, grown on Combinate's canvas out of a single " +
        "ι. Nothing was given; everything was made.</p>" +
        "<p>The aviary is open — keep golfing, keep discovering.</p>";
      this.body.append(f);
      return;
    }
    const prog = document.createElement("div");
    prog.className = "qs-prog";
    prog.textContent = `Chapter ${loc.chapterIndex + 1} of ${CHAPTERS.length} · ${loc.chapter.name}`;

    const steps = document.createElement("div");
    steps.className = "qs-steps";
    loc.chapter.stages.forEach((_, i) => {
      const s = document.createElement("div");
      s.className = "qs-step" + (i < loc.stageInChapter ? " done" : i === loc.stageInChapter ? " now" : "");
      steps.append(s);
    });

    const name = document.createElement("div");
    name.className = "qs-name";
    name.innerHTML = stage.name; // SKI-Quest names carry markup (Q<sub>1</sub>, &phi;)
    const intro = document.createElement("div");
    intro.innerHTML = stage.intro.join("\n");
    const task = document.createElement("div");
    task.className = "qs-task";
    task.textContent = "Build it on the canvas — drag ι and snap trees. This advances as you solve.";

    const hintWrap = document.createElement("div");
    hintWrap.className = "qs-hint";
    if (stage.hint && this.hintShown) {
      const h = document.createElement("div");
      h.className = "qs-hinttext";
      h.innerHTML = `Hint:  ${stage.hint}`;
      hintWrap.append(h);
    } else if (stage.hint) {
      const btn = document.createElement("button");
      btn.className = "qs-hintbtn";
      btn.textContent = "Show hint";
      btn.addEventListener("pointerdown", () => {
        this.hintShown = true;
        this.render();
      });
      hintWrap.append(btn);
    }
    this.body.append(prog, steps, name);
    if (loc.stageInChapter === 0) {
      const blurb = document.createElement("div");
      blurb.className = "qs-blurb";
      blurb.textContent = loc.chapter.blurb;
      this.body.append(blurb);
    }
    this.body.append(intro, task, hintWrap);
    this.appendLog();
  }

  /** The quest log: the stages already solved, most-recent first, grouped by chapter. */
  private appendLog(): void {
    const solved = this.progress.stage;
    if (solved <= 0) return;
    const log = document.createElement("div");
    log.className = "qs-log";
    log.append(Object.assign(document.createElement("div"), { className: "qs-logh", textContent: `Quest log — ${solved} solved` }));
    let lastChapter = "";
    for (let i = solved - 1; i >= 0; i--) {
      const stage = QUEST[i];
      const loc = locate(i);
      const chapter = loc?.chapter.name ?? "";
      if (chapter !== lastChapter) {
        lastChapter = chapter;
        const ch = document.createElement("div");
        ch.className = "qs-logch";
        ch.innerHTML = chapter;
        log.append(ch);
      }
      const row = document.createElement("div");
      row.className = "qs-logrow";
      const name = document.createElement("span");
      name.className = "qs-logname";
      name.innerHTML = stage.name;
      row.append(name);
      if (stage.unlock) {
        const u = document.createElement("span");
        u.className = "qs-logunlock";
        u.textContent = `✓ ${stage.unlock}`;
        row.append(u);
      }
      log.append(row);
    }
    this.body.append(log);
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--qs-${k}`, v);
  }
}
