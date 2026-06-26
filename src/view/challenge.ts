/**
 * The Golf panel (ADR 0005): a toggled overlay listing the challenge pack, the
 * goal + your best for each, a "share solution" button, and a verify-by-replay
 * leaderboard. It owns the challenge<->Store glue: when a tree settles at normal
 * form the shell calls {@link ChallengePanel.onNormalForm}, which checks every
 * challenge, records improved bests (Store.putBest), and announces a solve.
 *
 * Leaderboard rows are never trusted as-is: `topN` is re-verified locally
 * (replay the stored egg term against the challenge target, recompute the metric)
 * and fakes are dropped before display.
 */
import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text } from "pixi.js";
import { type Node } from "../core/term";
import { toEgg, fromEgg } from "../core/refold";
import { encodePermalink, decodePermalink } from "../core/permalink";
import { CHALLENGES, type Challenge } from "../core/challenges";
import type { Store, Best, LeaderEntry } from "../store/port";
import { theme } from "./theme";

const HANDLE_KEY = "combinate:v1:handle";

/** Read (or prompt once for) the player's leaderboard handle. */
function handleName(): string {
  let h = "";
  try {
    h = localStorage.getItem(HANDLE_KEY) ?? "";
  } catch {
    /* ignore */
  }
  if (!h) {
    h = (window.prompt("Leaderboard handle:", "anon") || "anon").slice(0, 24).trim() || "anon";
    try {
      localStorage.setItem(HANDLE_KEY, h);
    } catch {
      /* ignore */
    }
  }
  return h;
}

/** Parse an egg term, or null if malformed (a leaderboard row could be junk). */
function tryFromEgg(s: string): Node | null {
  try {
    return fromEgg(s);
  } catch {
    return null;
  }
}

export interface ChallengeOpts {
  /** Surface a short message (wired to the toast). */
  notify: (msg: string) => void;
  /** Share a permalink token (wired to the shell's hash/clipboard/download). */
  onShare: (token: string) => void;
}

export class ChallengePanel {
  /** The toggled overlay (the open/close button lives in the shell's rail). */
  readonly container = new Container();

  private readonly panel = new Container();
  private readonly backdrop = new Graphics();
  private readonly card = new Graphics();
  private readonly title = new Text({ text: "GOLF", style: { fontFamily: "monospace", fontSize: 22, fill: theme.iota } });
  private readonly closeBtn = new Container();
  private readonly listView = new Container();
  private readonly detail = new Container();

  private selected = 0;
  private cardX = 0;
  private cardY = 0;
  private cardW = 0;

  // store-backed caches, refreshed on open / submit / solve.
  private readonly bests = new Map<string, Best | null>();
  private readonly boards = new Map<string, LeaderEntry[]>();

  constructor(
    private readonly store: Store,
    private readonly opts: ChallengeOpts,
  ) {
    this.buildPanel();
    this.panel.visible = false;
    this.container.addChild(this.panel);
  }

  get isOpen(): boolean {
    return this.panel.visible;
  }
  async open(): Promise<void> {
    this.panel.visible = true;
    await this.reload();
    this.paint();
  }
  close(): void {
    this.panel.visible = false;
  }
  toggle(): void {
    if (this.panel.visible) this.close();
    else void this.open();
  }
  layout(): void {
    this.placePanel();
    if (this.panel.visible) this.paint();
  }
  applyTheme(): void {
    this.layout();
  }

  /**
   * A tree reached normal form: check every challenge against the *source* tree,
   * record any improved best, and announce it. Fire-and-forget from the shell.
   */
  async onNormalForm(source: Node): Promise<void> {
    let changed = false;
    for (const c of CHALLENGES) {
      let ok = false;
      try {
        ok = c.solved(source);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      const metric = c.metric(source);
      const prev = await this.store.getBest(c.id);
      if (prev && prev.metric <= metric) continue;
      const best: Best = { challengeId: c.id, metric, permalink: encodePermalink(source, {}) };
      await this.store.putBest(best);
      this.bests.set(c.id, best);
      this.opts.notify(`${c.title}: solved in ${metric} ${c.metricLabel}${prev ? ` — new best (was ${prev.metric})` : ""}!`);
      changed = true;
    }
    if (changed && this.panel.visible) this.paint();
  }

  // ---- store glue -------------------------------------------------------
  /** Reload bests + re-verified leaderboards for every challenge. */
  private async reload(): Promise<void> {
    for (const c of CHALLENGES) {
      this.bests.set(c.id, await this.store.getBest(c.id));
      this.boards.set(c.id, verify(c, await this.store.topN(c.id, 50)));
    }
  }

  private async submit(c: Challenge): Promise<void> {
    const best = this.bests.get(c.id);
    if (!best) {
      this.opts.notify("solve it first");
      return;
    }
    const decoded = decodePermalink(best.permalink);
    if (!decoded) return;
    const entry: LeaderEntry = { challengeId: c.id, bitcode: toEgg(decoded.tree), metric: best.metric, handle: handleName() };
    await this.store.submit(entry);
    this.boards.set(c.id, verify(c, await this.store.topN(c.id, 50)));
    this.paint();
    this.opts.notify("submitted to the leaderboard");
  }

  private share(c: Challenge): void {
    const best = this.bests.get(c.id);
    if (!best) {
      this.opts.notify("solve it first");
      return;
    }
    this.opts.onShare(best.permalink);
  }

  // ---- the overlay panel ------------------------------------------------
  private buildPanel(): void {
    this.backdrop.eventMode = "static";
    this.backdrop.on("pointerdown", () => this.close());
    this.card.eventMode = "static";
    this.card.on("pointerdown", (e: FederatedPointerEvent) => e.stopPropagation());

    const x = new Text({ text: "✕", style: { fontFamily: "monospace", fontSize: 20, fill: theme.textDim } });
    x.anchor.set(0.5);
    this.closeBtn.addChild(x);
    this.closeBtn.eventMode = "static";
    this.closeBtn.cursor = "pointer";
    this.closeBtn.hitArea = new Rectangle(-16, -16, 32, 32);
    this.closeBtn.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.close();
    });

    this.panel.addChild(this.backdrop, this.card, this.title, this.closeBtn, this.listView, this.detail);
    this.placePanel();
  }

  private placePanel(): void {
    const w = Math.min(880, window.innerWidth - 24);
    const h = Math.min(600, window.innerHeight - 24);
    this.cardW = w;
    this.cardX = (window.innerWidth - w) / 2;
    this.cardY = (window.innerHeight - h) / 2;
    this.backdrop.clear().rect(0, 0, window.innerWidth, window.innerHeight).fill({ color: theme.backdrop, alpha: theme.backdropAlpha });
    this.card.clear().roundRect(this.cardX, this.cardY, w, h, 14).fill({ color: theme.panel }).stroke({ width: 2, color: theme.border });
    this.title.position.set(this.cardX + 24, this.cardY + 18);
    this.closeBtn.position.set(this.cardX + w - 28, this.cardY + 28);
  }

  /** Rebuild the list + detail from the caches (sync; data is preloaded). */
  private paint(): void {
    this.buildList();
    this.buildDetail();
  }

  private buildList(): void {
    for (const c of this.listView.removeChildren()) c.destroy({ children: true });
    const rowH = 34;
    const x0 = this.cardX + 16;
    const y0 = this.cardY + 70;
    const w = 236;
    CHALLENGES.forEach((c, i) => {
      const row = new Container();
      row.position.set(x0, y0 + i * rowH);
      if (i === this.selected) row.addChild(new Graphics().roundRect(0, 0, w, rowH - 4, 6).fill({ color: theme.select }));
      const best = this.bests.get(c.id);
      const tick = new Text({ text: best ? "✓" : "·", style: { fontFamily: "monospace", fontSize: 15, fill: best ? theme.root : theme.textDim } });
      tick.position.set(10, 7);
      const name = new Text({ text: c.title, style: { fontFamily: "monospace", fontSize: 15, fill: theme.text } });
      name.position.set(34, 7);
      const score = new Text({ text: best ? `${best.metric}${c.metricLabel}` : "", style: { fontFamily: "monospace", fontSize: 13, fill: theme.textDim } });
      score.anchor.set(1, 0);
      score.position.set(w - 10, 8);
      row.addChild(tick, name, score);
      row.eventMode = "static";
      row.cursor = "pointer";
      row.hitArea = new Rectangle(0, 0, w, rowH - 4);
      row.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.selected = i;
        this.paint();
      });
      this.listView.addChild(row);
    });
  }

  private buildDetail(): void {
    for (const c of this.detail.removeChildren()) c.destroy({ children: true });
    const c = CHALLENGES[this.selected];
    const best = this.bests.get(c.id);
    const dx = this.cardX + 280;
    const dw = this.cardW - 280 - 24;
    let y = this.cardY + 70;

    const line = (text: string, color: number, size: number, gap = 6): void => {
      const t = new Text({ text, style: { fontFamily: "monospace", fontSize: size, fill: color, wordWrap: true, wordWrapWidth: dw } });
      t.position.set(dx, y);
      this.detail.addChild(t);
      y += t.height + gap;
    };

    line(c.title, theme.iota, 20, 8);
    line(c.goal, theme.text, 14, 10);
    line(`metric:  fewest ${c.metricLabel}`, theme.textDim, 13, 4);
    line(best ? `your best:  ${best.metric} ${c.metricLabel}` : "your best:  —  (not solved yet)", best ? theme.text : theme.textDim, 14, 12);

    // action buttons
    if (best) {
      const share = this.button("share solution", dx, y, () => this.share(c));
      const submit = this.button("submit ↑", dx + share.width + 12, y, () => void this.submit(c));
      this.detail.addChild(share, submit);
      y += 40;
    }

    // verified leaderboard
    line("leaderboard", theme.iota, 15, 6);
    const board = this.boards.get(c.id) ?? [];
    if (board.length === 0) {
      line("no verified entries yet — be the first.", theme.textDim, 13);
    } else {
      board.slice(0, 10).forEach((e, i) => {
        line(`${String(i + 1).padStart(2, " ")}.  ${e.metric} ${c.metricLabel}   ${e.handle}`, theme.text, 13, 2);
      });
    }
  }

  /** A small pill button. */
  private button(label: string, x: number, y: number, onClick: () => void): Container {
    const c = new Container();
    const t = new Text({ text: label, style: { fontFamily: "monospace", fontSize: 13, fill: theme.text } });
    t.position.set(12, 6);
    const bg = new Graphics().roundRect(0, 0, t.width + 24, 28, 7).fill({ color: theme.select }).stroke({ width: 1.5, color: theme.border });
    c.addChild(bg, t);
    c.position.set(x, y);
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new Rectangle(0, 0, t.width + 24, 28);
    c.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      onClick();
    });
    return c;
  }
}

/** Verify-by-replay: drop rows whose stored term doesn't actually solve the
 *  challenge, recompute each metric from the term itself, and sort. */
function verify(c: Challenge, rows: LeaderEntry[]): LeaderEntry[] {
  const out: LeaderEntry[] = [];
  for (const e of rows) {
    const tree = tryFromEgg(e.bitcode);
    if (!tree) continue;
    let ok = false;
    try {
      ok = c.solved(tree);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    out.push({ ...e, metric: c.metric(tree) });
  }
  return out.sort((a, b) => a.metric - b.metric);
}
