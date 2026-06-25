import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text } from "pixi.js";
import { CATALOG, countIotas, iotaTreeOf, type Law, META, PAGES } from "../core/catalog";
import { iota, type Node, type NodeId } from "../core/term";
import { layoutRadial } from "../core/layout";
import { theme } from "./theme";

const LIST_W = 248;
const LIST_TOP = 88; // list/detail start below the title + tab row

interface Entry {
  num: number;
  sym: string;
  /** null for ι (the primitive). */
  law: Law | null;
  /** Topic-page display name (e.g. "True", "Mult"), overriding the symbol. */
  alias?: string;
  /** Topic-page one-line note on the role this combinator plays. */
  role?: string;
}

interface Page {
  name: string;
  entries: Entry[];
}

/**
 * The Zoo — a Pokédex of every combinator: a number, name, Smullyan bird, the
 * combinator's pure-ι tree as its picture, an iota-count stat, a description and
 * its formula. Undiscovered entries show a "?". Toggled by a left-edge icon.
 */
export class Zoo {
  /** Holds the always-visible icon and the (toggled) overlay panel. */
  readonly container = new Container();

  private readonly icon = new Container();
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
  private readonly rowH = 30;
  private selected = 0;
  private listScroll = 0;
  private listH = 0;
  private cardX = 0;
  private cardY = 0;
  private cardW = 0;
  private cardH = 0;

  /** The entries of the currently-selected page. */
  private get entries(): Entry[] {
    return this.pages[this.pageIdx].entries;
  }

  constructor(private readonly isDiscovered: (sym: string) => boolean) {
    this.pages = buildPages();
    this.buildIcon();
    this.buildPanel();
    this.panel.visible = false;
    this.container.addChild(this.icon, this.panel);
  }

  open(): void {
    this.panel.visible = true;
    this.refresh();
  }
  close(): void {
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
  }

  /** Switch topic page (←/→ navigation), wrapping around. */
  cyclePage(delta: number): void {
    if (!this.panel.visible) return;
    this.pageIdx = (this.pageIdx + delta + this.pages.length) % this.pages.length;
    this.selected = 0;
    this.listScroll = 0;
    this.listView.position.set(this.cardX + 16, this.cardY + LIST_TOP);
    this.refresh();
  }

  /** Rebuild tabs + list + detail (after a discovery, unlock, open, or page switch). */
  refresh(): void {
    if (!this.panel.visible) return;
    this.buildTabs();
    this.buildList();
    this.buildDetail();
  }

  /** Reposition for the current screen size. */
  layout(): void {
    this.icon.position.set(34, window.innerHeight / 2);
    this.placePanel();
    if (this.panel.visible) this.refresh();
  }

  /** Repaint for a theme change: the always-visible icon plus the panel. */
  applyTheme(): void {
    this.paintIcon();
    this.layout();
  }

  // ---- the toggle icon: a little catalog/book ----
  private buildIcon(): void {
    this.paintIcon();
    this.icon.eventMode = "static";
    this.icon.cursor = "pointer";
    this.icon.hitArea = new Rectangle(-24, -26, 48, 64);
    this.icon.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.toggle();
    });
  }
  private paintIcon(): void {
    for (const c of this.icon.removeChildren()) c.destroy({ children: true });
    const g = new Graphics().roundRect(-20, -22, 40, 44, 5).fill({ color: theme.panel }).stroke({ width: 2, color: theme.iota });
    g.moveTo(-20, -22).lineTo(-20, 22).stroke({ width: 2, color: theme.iota }); // spine
    for (let i = 0; i < 3; i++) g.moveTo(-10, -10 + i * 10).lineTo(12, -10 + i * 10);
    g.stroke({ width: 1.5, color: theme.textDim });
    const label = new Text({ text: "Zoo", style: { fontFamily: "monospace", fontSize: 12, fill: theme.iota } });
    label.anchor.set(0.5, 0);
    label.position.set(0, 26);
    this.icon.addChild(g, label);
  }

  // ---- the overlay panel ----
  private buildPanel(): void {
    this.backdrop.eventMode = "static";
    this.backdrop.on("pointerdown", () => this.close());
    this.card.eventMode = "static";
    this.card.on("pointerdown", (e: FederatedPointerEvent) => e.stopPropagation());
    // wheel on the panel (ancestor of the list) scrolls the entry list
    this.panel.eventMode = "static";
    this.panel.on("wheel", (e: { deltaY: number }) => {
      const max = Math.max(0, this.listH - this.viewH());
      this.listScroll = Math.min(max, Math.max(0, this.listScroll + e.deltaY));
      this.listView.position.set(this.cardX + 16, this.cardY + LIST_TOP - this.listScroll);
    });

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

    this.listView.mask = this.listMask;
    this.panel.addChild(this.backdrop, this.card, this.title, this.tabBar, this.closeBtn, this.listMask, this.listView, this.detail);
    this.placePanel();
  }

  /** The topic-page tabs (All / Booleans / Arithmetic). */
  private buildTabs(): void {
    for (const c of this.tabBar.removeChildren()) c.destroy({ children: true });
    let x = this.cardX + 24;
    const y = this.cardY + 52;
    this.pages.forEach((page, i) => {
      const active = i === this.pageIdx;
      const t = new Text({ text: page.name, style: { fontFamily: "monospace", fontSize: 14, fill: active ? theme.iota : theme.textDim } });
      t.position.set(x, y);
      t.eventMode = "static";
      t.cursor = "pointer";
      t.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.cyclePage(i - this.pageIdx);
      });
      this.tabBar.addChild(t);
      if (active) this.tabBar.addChild(new Graphics().rect(x, y + 19, t.width, 2).fill({ color: theme.iota }));
      x += t.width + 24;
    });
  }

  private placePanel(): void {
    const w = Math.min(940, window.innerWidth - 80);
    const h = Math.min(640, window.innerHeight - 80);
    this.cardW = w;
    this.cardH = h;
    this.cardX = (window.innerWidth - w) / 2;
    this.cardY = (window.innerHeight - h) / 2;
    this.backdrop.clear().rect(0, 0, window.innerWidth, window.innerHeight).fill({ color: theme.backdrop, alpha: theme.backdropAlpha });
    this.card.clear().roundRect(this.cardX, this.cardY, w, h, 14).fill({ color: theme.panel }).stroke({ width: 2, color: theme.border });
    this.title.position.set(this.cardX + 24, this.cardY + 18);
    this.closeBtn.position.set(this.cardX + w - 26, this.cardY + 30);
    this.listMask.clear().rect(this.cardX + 16, this.cardY + LIST_TOP, LIST_W, this.viewH()).fill({ color: 0xffffff });
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
      if (i === this.selected) row.addChild(new Graphics().roundRect(0, 0, LIST_W, rowH - 4, 5).fill({ color: theme.select }));
      const num = new Text({ text: `#${String(entry.num).padStart(2, "0")}`, style: { fontFamily: "monospace", fontSize: 13, fill: theme.textDim } });
      num.position.set(10, 7);
      const name = new Text({ text: known ? (entry.alias ?? entry.sym) : "?", style: { fontFamily: "monospace", fontSize: 15, fill: known ? theme.text : theme.textDim } });
      name.position.set(64, 6);
      row.addChild(num, name);
      row.eventMode = "static";
      row.cursor = "pointer";
      row.hitArea = new Rectangle(0, 0, LIST_W, rowH - 4);
      row.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        // ignore clicks on rows scrolled outside the visible window (the mask
        // clips drawing, not hit-testing)
        if (i * rowH + rowH < this.listScroll || i * rowH > this.listScroll + this.viewH()) return;
        this.selected = i;
        this.refresh();
      });
      this.listView.addChild(row);
    });
    this.listH = this.entries.length * rowH;
  }

  private buildDetail(): void {
    for (const c of this.detail.removeChildren()) c.destroy({ children: true });
    const entry = this.entries[this.selected];
    const known = entry.law === null || this.isDiscovered(entry.sym);
    const dx = this.cardX + 288;
    const dy = this.cardY + LIST_TOP;
    const dw = this.cardW - 288 - 28;

    const tree: Node = entry.law === null ? iota() : iotaTreeOf(entry.law);
    const meta = META[entry.sym];
    const lawText = entry.law === null ? "ι x = x S K" : entry.law.lawText;

    const boxSize = 230;
    this.detail.addChild(new Graphics().roundRect(dx, dy, dw, boxSize, 10).fill({ color: theme.inset }).stroke({ width: 1, color: theme.border }));
    if (known) {
      const pic = renderPicture(tree, boxSize - 28);
      pic.position.set(dx + dw / 2, dy + boxSize / 2);
      this.detail.addChild(pic);
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
    line(`iotas:    ${countIotas(tree)}`, theme.textDim, 14, 10);
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
    })),
  }));
}

// Draw a term's nodes/edges, scaled to fit `size`, centred at the container origin.
function renderPicture(tree: Node, size: number): Container {
  const c = new Container();
  const lay = layoutRadial(tree);
  const scale = Math.min(size / (lay.maxX - lay.minX || 1), size / (lay.maxY - lay.minY || 1), 1);
  const cx = (lay.minX + lay.maxX) / 2;
  const cy = (lay.minY + lay.maxY) / 2;
  const at = (id: NodeId): { x: number; y: number } => {
    const p = lay.pos.get(id)!;
    return { x: (p.x - cx) * scale, y: (p.y - cy) * scale };
  };

  const edges = new Graphics();
  const fn: Array<[number, number, number, number]> = [];
  const arg: Array<[number, number, number, number]> = [];
  const walk = (n: Node): void => {
    if (n.kind !== "app") return;
    const p = at(n.id);
    const l = at(n.fn.id);
    const r = at(n.arg.id);
    fn.push([p.x, p.y, l.x, l.y]);
    arg.push([p.x, p.y, r.x, r.y]);
    walk(n.fn);
    walk(n.arg);
  };
  walk(tree);
  for (const [x1, y1, x2, y2] of arg) edges.moveTo(x1, y1).lineTo(x2, y2);
  edges.stroke({ width: 1, color: theme.argEdge, alpha: 0.85 });
  for (const [x1, y1, x2, y2] of fn) edges.moveTo(x1, y1).lineTo(x2, y2);
  edges.stroke({ width: 1.4, color: theme.fnEdge, alpha: 0.95 });
  c.addChild(edges);

  const dots = new Graphics();
  const drawDots = (n: Node): void => {
    const p = at(n.id);
    if (n.kind === "iota") dots.circle(p.x, p.y, 3).fill(theme.iota);
    else if (n.kind === "comb") dots.circle(p.x, p.y, 3).fill(theme.node);
    else dots.circle(p.x, p.y, 2).fill(theme.mutedDot);
    if (n.kind === "app") {
      drawDots(n.fn);
      drawDots(n.arg);
    }
  };
  drawDots(tree);
  c.addChild(dots);
  return c;
}
