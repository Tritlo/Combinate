import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text } from "pixi.js";
import { CATALOG, countIotas, iotaTreeOf, type Law, META } from "../core/catalog";
import { iota, type Node, type NodeId } from "../core/term";
import { layoutRadial } from "../core/layout";
import { ARG_EDGE, FN_EDGE } from "./tree";

const IOTA_COLOR = 0xffe08a;
const COMB_COLOR = 0x3b78e8;
const PANEL_BG = 0x121826;
const PANEL_LINE = 0x2c3850;
const TEXT_DIM = 0x8a97ad;
const TEXT = 0xd6deec;
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
  private readonly title = new Text({ text: "THE ZOO", style: { fontFamily: "monospace", fontSize: 22, fill: IOTA_COLOR } });
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

  // ---- the toggle icon: a little catalog/book ----
  private buildIcon(): void {
    const g = new Graphics().roundRect(-20, -22, 40, 44, 5).fill({ color: 0x1a2233 }).stroke({ width: 2, color: IOTA_COLOR });
    g.moveTo(-20, -22).lineTo(-20, 22).stroke({ width: 2, color: IOTA_COLOR }); // spine
    for (let i = 0; i < 3; i++) g.moveTo(-10, -10 + i * 10).lineTo(12, -10 + i * 10);
    g.stroke({ width: 1.5, color: TEXT_DIM });
    const label = new Text({ text: "Zoo", style: { fontFamily: "monospace", fontSize: 12, fill: IOTA_COLOR } });
    label.anchor.set(0.5, 0);
    label.position.set(0, 26);
    this.icon.addChild(g, label);
    this.icon.eventMode = "static";
    this.icon.cursor = "pointer";
    this.icon.hitArea = new Rectangle(-24, -26, 48, 64);
    this.icon.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.toggle();
    });
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

    const x = new Text({ text: "✕", style: { fontFamily: "monospace", fontSize: 20, fill: TEXT_DIM } });
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
      const t = new Text({ text: page.name, style: { fontFamily: "monospace", fontSize: 14, fill: active ? IOTA_COLOR : TEXT_DIM } });
      t.position.set(x, y);
      t.eventMode = "static";
      t.cursor = "pointer";
      t.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.cyclePage(i - this.pageIdx);
      });
      this.tabBar.addChild(t);
      if (active) this.tabBar.addChild(new Graphics().rect(x, y + 19, t.width, 2).fill({ color: IOTA_COLOR }));
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
    this.backdrop.clear().rect(0, 0, window.innerWidth, window.innerHeight).fill({ color: 0x05070c, alpha: 0.72 });
    this.card.clear().roundRect(this.cardX, this.cardY, w, h, 14).fill({ color: PANEL_BG }).stroke({ width: 2, color: PANEL_LINE });
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
      if (i === this.selected) row.addChild(new Graphics().roundRect(0, 0, LIST_W, rowH - 4, 5).fill({ color: 0x223052 }));
      const num = new Text({ text: `#${String(entry.num).padStart(2, "0")}`, style: { fontFamily: "monospace", fontSize: 13, fill: TEXT_DIM } });
      num.position.set(10, 7);
      const name = new Text({ text: known ? (entry.alias ?? entry.sym) : "?", style: { fontFamily: "monospace", fontSize: 15, fill: known ? TEXT : TEXT_DIM } });
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
    this.detail.addChild(new Graphics().roundRect(dx, dy, dw, boxSize, 10).fill({ color: 0x0b101b }).stroke({ width: 1, color: PANEL_LINE }));
    if (known) {
      const pic = renderPicture(tree, boxSize - 28);
      pic.position.set(dx + dw / 2, dy + boxSize / 2);
      this.detail.addChild(pic);
    } else {
      const q = new Text({ text: "?", style: { fontFamily: "monospace", fontSize: 96, fill: 0x2c3850 } });
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
      line(`${numStr}   ???`, TEXT, 22, 8);
      line("Not yet discovered — build a tree that behaves this way.", TEXT_DIM, 14);
      return;
    }
    const sub = meta?.bird ? `${entry.sym}  ·  ${meta.bird}` : entry.sym;
    if (entry.alias) {
      line(`${numStr}   ${entry.alias}`, IOTA_COLOR, 22, 2);
      line(`= ${sub}`, TEXT_DIM, 14, 8);
    } else {
      line(`${numStr}   ${sub}`, IOTA_COLOR, 22, 8);
    }
    if (entry.role) line(`role:     ${entry.role}`, TEXT, 15);
    line(`law:      ${lawText}`, TEXT, 15);
    line(`formula:  ${meta?.recipe ?? "—"}`, TEXT, 15);
    line(`iotas:    ${countIotas(tree)}`, TEXT_DIM, 14, 10);
    if (meta?.blurb) line(meta.blurb, TEXT, 15);
  }
}

/** The Zoo pages: the full catalog, plus curated Boolean / arithmetic views that
 *  re-present existing combinators under the role they play (most of "Booleans"
 *  and "Arithmetic" are birds you already know — True is the Kestrel, Mult is the
 *  Bluebird — only Succ, (+) and (-) are their own entries). */
function buildPages(): Page[] {
  const all: Entry[] = [
    { num: 1, sym: "ι", law: null },
    ...CATALOG.map((law, i) => ({ num: i + 2, sym: law.sym, law })),
  ];
  const byId = new Map(CATALOG.map((l) => [l.sym, l] as const));
  const topic = (rows: Array<[string, string, string]>): Entry[] =>
    rows.map(([sym, alias, role], i) => ({ num: i + 1, sym, law: byId.get(sym) ?? null, alias, role }));
  return [
    { name: "Programs", entries: all },
    {
      name: "Booleans",
      entries: topic([
        ["K", "True", "selects the first of two options"],
        ["A", "False", "selects the second of two options"],
        ["C", "Not", "swaps the two options"],
        ["X", "And", "true only when both are true"],
        ["M", "Or", "true when either is true"],
        ["I", "If", "`if c t e` is just `c t e` — a boolean is its own conditional"],
      ]),
    },
    {
      name: "Arithmetic",
      entries: topic([
        ["A", "Zero", "Church 0 — applies f zero times"],
        ["I", "One", "Church 1 — applies f exactly once"],
        ["Succ", "Succ", "adds one to a numeral"],
        ["Pred", "Pred", "subtracts one (clamped at 0) — the basis of Sub"],
        ["(+)", "Plus", "adds two numerals"],
        ["B", "Mult", "multiplies — multiplication is the Bluebird (composition)"],
        ["T", "Exp", "raises to a power — m^n is just n m"],
        ["(-)", "Sub", "truncated subtraction, via the predecessor"],
      ]),
    },
    {
      name: "Lists",
      entries: topic([
        ["A", "nil", "the empty list — also false and zero"],
        ["cons", "cons", "prepends a head onto a list"],
        ["head", "head", "the first element"],
        ["tail", "tail", "everything after the head — the list's predecessor"],
        ["V", "fold", "right fold — a list is its own fold (the Vireo)"],
        ["<>", "<>", "appends one list onto another (Semigroup, ++)"],
        ["join", "join", "flattens a list of lists (monadic join / concat)"],
        ["map", "map", "applies a function to every element"],
        ["null", "null", "is the list empty?"],
      ]),
    },
  ];
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
  edges.stroke({ width: 1, color: ARG_EDGE, alpha: 0.85 });
  for (const [x1, y1, x2, y2] of fn) edges.moveTo(x1, y1).lineTo(x2, y2);
  edges.stroke({ width: 1.4, color: FN_EDGE, alpha: 0.95 });
  c.addChild(edges);

  const dots = new Graphics();
  const drawDots = (n: Node): void => {
    const p = at(n.id);
    if (n.kind === "iota") dots.circle(p.x, p.y, 3).fill(IOTA_COLOR);
    else if (n.kind === "comb") dots.circle(p.x, p.y, 3).fill(COMB_COLOR);
    else dots.circle(p.x, p.y, 2).fill(0x6b7a90);
    if (n.kind === "app") {
      drawDots(n.fn);
      drawDots(n.arg);
    }
  };
  drawDots(tree);
  c.addChild(dots);
  return c;
}
