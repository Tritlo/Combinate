import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text } from "pixi.js";
import { CATALOG, countIotas, displayLabel, iotaTreeOf, IOTA_FASTEST, IOTA_FASTEST_BOUND, IOTA_SETTLED, IOTA_STEPS, type Law, META, PAGES } from "../core/catalog";
import { iota, type Node, type NodeId, decode } from "../core/term";
import { layoutHTree } from "../core/layout";
import { theme, currentMode, edgeTierColor, type Mode, MONO, PAPER, INK } from "./theme";
import { wirePanelChrome, placeCard } from "./pixiPanel";

const LIST_W = 248;
const LIST_TOP = 88; // list/detail start below the title + tab row
const iotaDot = (mode: Mode): number => (mode === "light" ? 0x000000 : 0xffffff);

interface Entry {
  num: number;
  sym: string;
  /** null for ι (the primitive). */
  law: Law | null;
  /** Topic-page display name (e.g. "True", "Mult"), overriding the symbol. */
  alias?: string;
  /** Topic-page one-line note on the role this combinator plays. */
  role?: string;
  /** Page-scoped override of the short display glyph — see {@link displayLabel}. */
  label?: string;
}

interface Page {
  name: string;
  entries: Entry[];
}

/**
 * The Zoo — a field guide to every combinator: a number, name, Smullyan bird, the
 * combinator's pure-ι tree as its picture, an iota-count stat, a description and
 * its formula. Undiscovered entries show a "?". Toggled by a left-edge icon.
 */
export class Zoo {
  /** The toggled overlay panel (the open/close button lives in the shell's rail). */
  readonly container = new Container();

  private readonly panel = new Container();
  private readonly backdrop = new Graphics();
  private readonly card = new Graphics();
  private readonly title = new Text({ text: "THE ZOO", style: { fontFamily: "monospace", fontSize: 22, fill: theme.iota } });
  private readonly closeBtn = new Container();
  private readonly tabBar = new Container();
  private readonly listView = new Container();
  private readonly listMask = new Graphics();
  private readonly detail = new Container();

  private readonly pages: Page[];
  private pageIdx = 0;
  private fastMode = false; // detail picture: minimal form (🐢, canon) vs fastest form (🐇, fewest steps ≤34ι)
  private readonly rowH = 30;
  private selected = 0;
  private listScroll = 0;
  private listH = 0;
  private cardX = 0;
  private cardY = 0;
  private cardW = 0;
  private cardH = 0;
  // On a narrow viewport the list and detail can't sit side by side, so the
  // panel becomes master-detail: tap a row to open its detail, "‹ list" to go back.
  private narrow = false;
  private mobileDetail = false;

  /** Width of the entry list (full panel on narrow screens, a fixed column otherwise). */
  private get listW(): number {
    return this.narrow ? this.cardW - 32 : LIST_W;
  }
  /** Left edge of the detail pane. */
  private get detailX(): number {
    return this.narrow ? this.cardX + 16 : this.cardX + 288;
  }
  /** Width of the detail pane. */
  private get detailW(): number {
    return this.narrow ? this.cardW - 32 : this.cardW - 316;
  }

  /** The entries of the currently-selected page. */
  private get entries(): Entry[] {
    return this.pages[this.pageIdx].entries;
  }

  constructor(
    private readonly isDiscovered: (sym: string) => boolean,
    /** Play a combinator's tone (wired to sound.play) — the "play tone" button + auto-chirp. */
    private readonly playTone: (sym: string) => void,
  ) {
    this.pages = buildPages();
    this.buildPanel();
    this.panel.visible = false;
    this.container.addChild(this.panel);
  }

  open(): void {
    this.panel.visible = true;
    this.mobileDetail = false; // narrow: start on the list
    this.refresh();
    this.autoTone();
  }

  /** Chirp the selected creature's tone, Pokédex-style, when it's shown. */
  private autoTone(): void {
    const e = this.entries[this.selected];
    if (e.law === null || this.isDiscovered(e.sym)) this.playTone(e.sym); // known (or ι) only
  }
  /** The 🐢|🐇 System-1 segmented toggle (DOM, like the 2D|3D control): ink track,
   *  paper slider, SVG glyphs. Floated over the picture box; hidden when absent/closed. */
  private speedEl: HTMLDivElement | null = null;
  private placeSpeedToggle(at: { x: number; y: number } | null): void {
    if (!at) {
      if (this.speedEl) this.speedEl.style.display = "none";
      return;
    }
    if (!this.speedEl) {
      const el = document.createElement("div");
      el.className = "lc-seg";
      el.style.position = "fixed";
      el.style.zIndex = "42";
      el.style.flex = "none";
      el.style.fontFamily = MONO;
      const TURTLE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3.5 10a4.5 4 0 0 1 9 0z"/><circle cx="13.6" cy="9.3" r="1.4"/><rect x="4.6" y="10" width="2" height="2"/><rect x="9.4" y="10" width="2" height="2"/></svg>`;
      const HARE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M5.6 7.5 4.2 1.8l2.8 4.6z"/><path d="M8.2 7.2 8.5 1.4l1.6 5.2z"/><ellipse cx="8" cy="10.8" rx="4.6" ry="3"/><circle cx="13" cy="11.6" r="1.1"/></svg>`;
      for (const [kind, svg] of [["min", TURTLE], ["fast", HARE]] as const) {
        const b = document.createElement("button");
        b.className = "lc-btn";
        b.innerHTML = svg;
        b.title = kind === "min" ? "Minimal form (canonical)" : `Fastest form found (≤ ${IOTA_FASTEST_BOUND}ι hunt)`;
        b.style.display = "flex";
        b.style.alignItems = "center";
        b.style.padding = "4px 8px";
        b.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          this.fastMode = kind === "fast";
          this.refresh();
        });
        el.appendChild(b);
      }
      document.body.appendChild(el);
      this.speedEl = el;
    }
    const el = this.speedEl;
    const mode = currentMode();
    el.style.setProperty("--lc-paper", PAPER[mode]);
    el.style.setProperty("--lc-ink", INK[mode]);
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    el.style.display = "flex";
    const btns = el.querySelectorAll(".lc-btn");
    btns[0]!.classList.toggle("on", !this.fastMode);
    btns[1]!.classList.toggle("on", this.fastMode);
  }

  /** System-1 hover tooltip (the menubar's .mb-tip pattern) for the stats hint. */
  private tipEl: HTMLDivElement | null = null;
  private showTip(text: string, at: { x: number; y: number }): void {
    if (!this.tipEl) {
      const el = document.createElement("div");
      el.className = "mb-tip";
      document.body.appendChild(el);
      this.tipEl = el;
    }
    const el = this.tipEl;
    const mode = currentMode();
    el.style.setProperty("--mb-bg", PAPER[mode]);
    el.style.setProperty("--mb-fg", INK[mode]);
    el.style.setProperty("--mb-line", INK[mode]);
    el.style.setProperty("--mb-shadow", "rgba(0,0,0,0.85)");
    el.textContent = text;
    el.style.display = "block";
    const w = el.offsetWidth;
    const x = Math.min(at.x, window.innerWidth - w - 8);
    el.style.left = `${Math.max(6, x)}px`;
    el.style.top = `${at.y + 4}px`;
  }
  private hideTip(): void {
    if (this.tipEl) this.tipEl.style.display = "none";
  }

  close(): void {
    this.hideTip();
    if (this.speedEl) this.speedEl.style.display = "none";
    this.panel.visible = false;
  }

  toggle(): void {
    if (this.panel.visible) this.close();
    else this.open();
  }
  get isOpen(): boolean {
    return this.panel.visible;
  }

  /** Visible height of the scrolling list window. */
  private viewH(): number {
    return this.cardH - LIST_TOP - 24;
  }

  /** Move the selection (arrow-key navigation), scrolling to keep it visible. */
  move(delta: number): void {
    if (!this.panel.visible) return;
    this.selected = Math.max(0, Math.min(this.entries.length - 1, this.selected + delta));
    const viewH = this.viewH();
    const top = this.selected * this.rowH;
    if (top < this.listScroll) this.listScroll = top;
    else if (top + this.rowH > this.listScroll + viewH) this.listScroll = top + this.rowH - viewH;
    const max = Math.max(0, this.entries.length * this.rowH - viewH);
    this.listScroll = Math.max(0, Math.min(max, this.listScroll));
    this.listView.position.set(this.cardX + 16, this.cardY + LIST_TOP - this.listScroll);
    this.refresh();
    this.autoTone();
  }

  /** Switch topic page (←/→ navigation), wrapping around. */
  cyclePage(delta: number): void {
    if (!this.panel.visible) return;
    this.pageIdx = (this.pageIdx + delta + this.pages.length) % this.pages.length;
    this.selected = 0;
    this.listScroll = 0;
    this.mobileDetail = false; // switching tab returns to the list
    this.listView.position.set(this.cardX + 16, this.cardY + LIST_TOP);
    this.refresh();
    this.autoTone();
  }

  /** Re-derive the pages from the shared catalog/`PAGES` — call after the player
   *  Defines a new combinator (a new Custom-page entry) so the Zoo picks it up. */
  rebuild(): void {
    this.pages.length = 0;
    this.pages.push(...buildPages());
    if (this.pageIdx >= this.pages.length) this.pageIdx = 0;
    this.refresh();
  }

  /** Rebuild the panel contents (after a discovery, unlock, open, or page switch). */
  refresh(): void {
    this.placeSpeedToggle(null); // hidden unless the detail re-places it (known bird with a fastest form)
    this.hideTip(); // the hovered stats Text is destroyed on refresh — no pointerout will fire
    if (!this.panel.visible) return;
    this.buildTabs();
    this.buildList();
    this.buildDetail();
    // narrow: show either the list (with tabs) or the detail, not both
    const showList = !this.narrow || !this.mobileDetail;
    this.tabBar.visible = showList;
    this.listView.visible = showList;
    this.detail.visible = !this.narrow || this.mobileDetail;
  }

  /** Reposition for the current screen size (and repaint on a theme change). */
  layout(): void {
    this.placePanel();
    this.refresh();
  }
  applyTheme(): void {
    this.layout();
  }

  // ---- the overlay panel ----
  private buildPanel(): void {
    wirePanelChrome(
      { panel: this.panel, backdrop: this.backdrop, card: this.card, closeBtn: this.closeBtn, listView: this.listView, listMask: this.listMask },
      () => this.close(),
      {
        get: () => this.listScroll,
        set: (v) => {
          this.listScroll = v;
          this.listView.position.set(this.cardX + 16, this.cardY + LIST_TOP - v);
        },
        listH: () => this.listH,
        viewH: () => this.viewH(),
      },
    );
    this.panel.addChild(this.backdrop, this.card, this.title, this.tabBar, this.closeBtn, this.listMask, this.listView, this.detail);
    this.placePanel();
  }

  /** The topic-page tabs (All / Booleans / Arithmetic). */
  private buildTabs(): void {
    for (const c of this.tabBar.removeChildren()) c.destroy({ children: true });
    const size = this.narrow ? 13 : 14;
    const gap = this.narrow ? 14 : 24;
    let x = this.cardX + 24;
    const y = this.cardY + 52;
    this.pages.forEach((page, i) => {
      const active = i === this.pageIdx;
      const t = new Text({ text: page.name, style: { fontFamily: "monospace", fontSize: size, fill: active ? theme.iota : theme.textDim } });
      t.position.set(x, y);
      t.eventMode = "static";
      t.cursor = "pointer";
      t.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.cyclePage(i - this.pageIdx);
      });
      this.tabBar.addChild(t);
      if (active) this.tabBar.addChild(new Graphics().rect(x, y + 18, t.width, 2).fill({ color: theme.iota }));
      x += t.width + gap;
    });
  }

  private placePanel(): void {
    const w = Math.min(940, window.innerWidth - 24);
    const h = Math.min(660, window.innerHeight - 24);
    this.cardW = w;
    this.cardH = h;
    this.narrow = w < 560;
    const { x, y } = placeCard({ backdrop: this.backdrop, card: this.card, title: this.title, closeBtn: this.closeBtn }, w, h);
    this.cardX = x;
    this.cardY = y;
    this.listMask.clear().rect(this.cardX + 16, this.cardY + LIST_TOP, this.listW, this.viewH()).fill({ color: 0xffffff });
    this.listScroll = 0;
    this.listView.position.set(this.cardX + 16, this.cardY + LIST_TOP);
  }

  private buildList(): void {
    for (const c of this.listView.removeChildren()) c.destroy({ children: true });
    const rowH = this.rowH;
    this.entries.forEach((entry, i) => {
      const known = entry.law === null || this.isDiscovered(entry.sym);
      const row = new Container();
      row.position.set(0, i * rowH);
      if (i === this.selected) row.addChild(new Graphics().roundRect(0, 0, this.listW, rowH - 4, 5).fill({ color: theme.select }));
      const num = new Text({ text: `#${String(entry.num).padStart(2, "0")}`, style: { fontFamily: "monospace", fontSize: 13, fill: theme.textDim } });
      num.position.set(10, 7);
      const name = new Text({ text: known ? displayLabel(entry.sym, entry) : "?", style: { fontFamily: "monospace", fontSize: 15, fill: known ? theme.text : theme.textDim } });
      name.position.set(64, 6);
      row.addChild(num, name);
      row.eventMode = "static";
      row.cursor = "pointer";
      row.hitArea = new Rectangle(0, 0, this.listW, rowH - 4);
      row.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        // ignore clicks on rows scrolled outside the visible window (the mask
        // clips drawing, not hit-testing)
        if (i * rowH + rowH < this.listScroll || i * rowH > this.listScroll + this.viewH()) return;
        this.selected = i;
        if (this.narrow) this.mobileDetail = true; // narrow: tapping a row opens its detail
        this.refresh();
        this.autoTone();
      });
      this.listView.addChild(row);
    });
    this.listH = this.entries.length * rowH;
  }

  private buildDetail(): void {
    for (const c of this.detail.removeChildren()) c.destroy({ children: true });
    const entry = this.entries[this.selected];
    const known = entry.law === null || this.isDiscovered(entry.sym);
    const dx = this.detailX;
    const dy = this.cardY + LIST_TOP;
    const dw = this.detailW;

    if (this.narrow) {
      // master-detail: a tap target to return to the list
      const back = new Text({ text: "‹ list", style: { fontFamily: "monospace", fontSize: 14, fill: theme.iota } });
      back.position.set(this.cardX + 24, this.cardY + 50);
      back.eventMode = "static";
      back.cursor = "pointer";
      back.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.mobileDetail = false;
        this.refresh();
      });
      this.detail.addChild(back);
    }

    const fastCode = entry.law !== null ? IOTA_FASTEST[entry.sym] : undefined;
    const tree: Node = entry.law === null ? iota() : this.fastMode && fastCode ? decode(fastCode) : iotaTreeOf(entry.law);
    const meta = META[entry.sym];
    const lawText = entry.law === null ? "ι x = x S K" : entry.law.lawText;

    const boxSize = 230;
    this.detail.addChild(new Graphics().roundRect(dx, dy, dw, boxSize, 10).fill({ color: theme.inset }).stroke({ width: 1, color: theme.border }));
    if (known) {
      const pic = renderPicture(tree, boxSize - 28);
      pic.position.set(dx + dw / 2, dy + boxSize / 2);
      this.detail.addChild(pic);
      // narrow layout: the detail pane may be hidden behind the list — never float the
      // DOM toggle over it (Codex-caught release gap)
      this.placeSpeedToggle(fastCode && (!this.narrow || this.mobileDetail) ? { x: dx + 10, y: dy + 10 } : null);
      // a "play tone" button (top-right of the picture box) — chirps the bird
      const tone = new Text({ text: "♪", style: { fontFamily: "monospace", fontSize: 20, fill: theme.iota } });
      tone.anchor.set(0.5);
      tone.position.set(dx + dw - 18, dy + 16);
      tone.eventMode = "static";
      tone.cursor = "pointer";
      tone.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.playTone(entry.sym);
      });
      this.detail.addChild(tone);
    } else {
      const q = new Text({ text: "?", style: { fontFamily: "monospace", fontSize: 96, fill: theme.border } });
      q.anchor.set(0.5);
      q.position.set(dx + dw / 2, dy + boxSize / 2);
      this.detail.addChild(q);
    }

    let y = dy + boxSize + 16;
    const line = (text: string, color: number, size: number, gap = 4): void => {
      const t = new Text({ text, style: { fontFamily: "monospace", fontSize: size, fill: color, wordWrap: true, wordWrapWidth: dw } });
      t.position.set(dx, y);
      this.detail.addChild(t);
      y += t.height + gap;
    };

    const numStr = `#${String(entry.num).padStart(2, "0")}`;
    if (!known) {
      line(`${numStr}   ???`, theme.text, 22, 8);
      line("Not yet discovered — build a tree that behaves this way.", theme.textDim, 14);
      return;
    }
    const sub = meta?.bird ? `${entry.sym}  ·  ${meta.bird}` : entry.sym;
    if (entry.alias) {
      line(`${numStr}   ${entry.alias}`, theme.iota, 22, 2);
      line(`= ${sub}`, theme.textDim, 14, 8);
    } else {
      line(`${numStr}   ${sub}`, theme.iota, 22, 8);
    }
    if (entry.role) line(`role:     ${entry.role}`, theme.text, 15);
    line(`law:      ${lawText}`, theme.text, 15);
    line(`formula:  ${meta?.recipe ?? "—"}`, theme.text, 15);
    // Stats follow the DISPLAYED form (the 🐢/🐇 toggle): its ι-count and the measured
    // steps of its reduction at the law's arity — saved hunt data (IOTA_STEPS), never
    // computed at render time (some forms take thousands of contractions).
    const steps = IOTA_STEPS[entry.sym];
    if (fastCode && entry.law !== null && steps) {
      const stats = new Text({
        text: `iotas:    ${countIotas(tree)}\nsteps:    ${steps[this.fastMode ? 1 : 0]}`,
        style: { fontFamily: "monospace", fontSize: 14, fill: theme.textDim, lineHeight: 20 },
      });
      stats.position.set(dx, y);
      stats.eventMode = "static";
      stats.cursor = "help";
      this.detail.addChild(stats);
      y += stats.height + 10;
      stats.on("pointerover", () => this.showTip(
        IOTA_SETTLED.has(entry.sym)
          ? `optimal, full stop: any faster or smaller form would fit inside the searched ≤ ${IOTA_FASTEST_BOUND}ι bound (the live-core theorem) — these numbers are final.`
          : `both forms verified by the ≤ ${IOTA_FASTEST_BOUND}ι hunt (every ι-term up to ${IOTA_FASTEST_BOUND} leaves searched) — a deeper hunt may still improve them.`,
        { x: dx, y: y }
      ));
      stats.on("pointerout", () => this.hideTip());
    } else {
      line(`iotas:    ${countIotas(tree)}`, theme.textDim, 14, 10);
    }
    if (meta?.blurb) line(meta.blurb, theme.text, 15);
  }
}

/** Build the Zoo pages from the shared {@link PAGES}, looking up each entry's law
 *  for its picture/stats. "Programs" is the general combinators; the topic pages
 *  re-present birds under their role (True is the Kestrel, Mult is the Bluebird). */
function buildPages(): Page[] {
  const byId = new Map(CATALOG.map((l) => [l.sym, l] as const));
  return PAGES.map((pd) => ({
    name: pd.name,
    entries: pd.entries.map((e, i) => ({
      num: i + 1,
      sym: e.sym,
      law: e.sym === "ι" ? null : byId.get(e.sym) ?? null,
      alias: e.alias,
      role: e.role,
      label: e.label,
    })),
  }));
}

// Draw a term's nodes/edges, scaled to fit `size`, centered at the container origin.
function renderPicture(tree: Node, size: number): Container {
  const c = new Container();
  const lay = layoutHTree(tree);
  const scale = Math.min(size / (lay.maxX - lay.minX || 1), size / (lay.maxY - lay.minY || 1), 1);
  const cx = (lay.minX + lay.maxX) / 2;
  const cy = (lay.minY + lay.maxY) / 2;
  const at = (id: NodeId): { x: number; y: number } => {
    const p = lay.pos.get(id)!;
    return { x: (p.x - cx) * scale, y: (p.y - cy) * scale };
  };

  const edges = new Graphics();
  // Edge color = depth TIER (red/black), width = fn (thicker) vs arg — the tricolor tree convention,
  // sized down for the thumbnail. Widths TAPER with the child's layout scale (deep-spine edges thin
  // out exactly like the main tree, ADR 25's no-blob rule), so strokes are per-edge.
  const sc = (id: NodeId): number => lay.scale?.get(id) ?? 1;
  const walk = (n: Node, depth: number): void => {
    if (n.kind !== "app") return;
    const p = at(n.id);
    const l = at(n.fn.id);
    const r = at(n.arg.id);
    const color = edgeTierColor(depth % 2);
    edges.moveTo(p.x, p.y).lineTo(r.x, r.y).stroke({ width: Math.max(0.3, 1 * sc(n.arg.id)), color, alpha: 0.85 });
    edges.moveTo(p.x, p.y).lineTo(l.x, l.y).stroke({ width: Math.max(0.3, 1.4 * sc(n.fn.id)), color, alpha: 0.95 });
    walk(n.fn, depth + 1);
    walk(n.arg, depth + 1);
  };
  walk(tree, 0);
  c.addChild(edges);

  const dots = new Graphics();
  const drawDots = (n: Node): void => {
    const p = at(n.id);
    const k = Math.max(0.25, lay.scale?.get(n.id) ?? 1); // taper dots with their arm (floor keeps them visible at thumb size)
    if (n.kind === "iota") dots.circle(p.x, p.y, 3 * k).fill(iotaDot(currentMode()));
    else if (n.kind === "comb") dots.circle(p.x, p.y, 3 * k).fill(theme.node);
    else dots.circle(p.x, p.y, 2 * k).fill(theme.mutedDot);
    if (n.kind === "app") {
      drawDots(n.fn);
      drawDots(n.arg);
    }
  };
  drawDots(tree);
  c.addChild(dots);
  return c;
}
