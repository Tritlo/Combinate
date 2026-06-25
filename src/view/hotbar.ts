import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text, type Ticker } from "pixi.js";
import { type Node } from "../core/term";
import { PAGES } from "../core/catalog";
import { theme } from "./theme";
import { tween } from "./anim";

const SLOT = 56;
const GAP = 10;
const MARGIN = 80; // keep the row clear of the screen edges
const ARROW = 30; // width of a ‹ / › page button

/**
 * The hotbar (§8.1), bottom-centre. It mirrors the Zoo's organisation: a tab bar
 * (Programs / Booleans / Arithmetic / Lists) over a row of draggable slots for
 * the *discovered* combinators on that tab (paginated with ‹ / › when they don't
 * fit). Each slot shows the combinator under its page alias (e.g. "Mult" for B)
 * and stamps that combinator's tree when dragged out.
 */
export class Hotbar {
  readonly container = new Container();
  private readonly tabBar = new Container();
  private readonly slotRow = new Container();
  private readonly pageLabel = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 12, fill: theme.textDim } });
  private tab = 0;
  private sub = 0;
  private popSym: string | null = null;

  constructor(
    private readonly onSpawnStart: (node: Node, e: FederatedPointerEvent) => void,
    private readonly ticker: Ticker,
    private readonly isDiscovered: (sym: string) => boolean,
    private readonly spawnFor: (sym: string) => Node,
  ) {
    this.pageLabel.anchor.set(1, 0.5);
    this.container.addChild(this.tabBar, this.slotRow, this.pageLabel);
  }

  /** Reveal a newly-discovered combinator: jump to its tab + page and pop it in. */
  reveal(sym: string): void {
    const tab = PAGES.findIndex((p) => p.entries.some((e) => e.sym === sym));
    if (tab >= 0) {
      this.tab = tab;
      const idx = this.visible(tab).indexOf(sym);
      if (idx >= 0) this.sub = Math.floor(idx / this.pageSize());
    }
    this.popSym = sym;
    this.layout();
  }
  refresh(): void {
    this.layout();
  }

  /** The current page's name — drives the read-as mode in the read-out (a typed
   *  page like Arithmetic reads the focused tree as that type). */
  get page(): string {
    return PAGES[this.tab].name;
  }

  /** Switch to a page by name (programmatic / E2E seam). No-op if unknown. */
  selectPage(name: string): void {
    const i = PAGES.findIndex((p) => p.name === name);
    if (i >= 0) this.setTab(i);
  }

  /** Discovered combinators on a tab (ι is always available). */
  private visible(tab: number): string[] {
    return PAGES[tab].entries.map((e) => e.sym).filter((s) => s === "ι" || this.isDiscovered(s));
  }
  private aliasOf(sym: string): string {
    return PAGES[this.tab].entries.find((e) => e.sym === sym)?.alias ?? sym;
  }
  private pageSize(): number {
    const avail = window.innerWidth - 2 * MARGIN - 2 * (ARROW + GAP) - GAP;
    return Math.max(1, Math.floor((avail + GAP) / (SLOT + GAP)));
  }
  private setTab(i: number): void {
    this.tab = i;
    this.sub = 0;
    this.layout();
  }
  private flip(d: number): void {
    this.sub += d;
    this.layout();
  }

  layout(): void {
    for (const c of this.tabBar.removeChildren()) c.destroy({ children: true });
    for (const c of this.slotRow.removeChildren()) c.destroy({ children: true });
    const yB = window.innerHeight - 38; // bottom row centre
    const yT = window.innerHeight - 102; // top row centre
    const mid = (yB + yT) / 2;
    const tabY = window.innerHeight - 152;

    // ---- tab bar (centred) ----
    const labels = PAGES.map((p, i) => new Text({ text: p.name, style: { fontFamily: "monospace", fontSize: 14, fill: i === this.tab ? theme.iota : theme.textDim } }));
    const tabsW = labels.reduce((s, t) => s + t.width, 0) + 2 * GAP * (labels.length - 1);
    let tx = window.innerWidth / 2 - tabsW / 2;
    labels.forEach((t, i) => {
      t.position.set(tx, tabY);
      t.eventMode = "static";
      t.cursor = "pointer";
      t.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.setTab(i);
      });
      this.tabBar.addChild(t);
      if (i === this.tab) this.tabBar.addChild(new Graphics().rect(tx, tabY + 19, t.width, 2).fill({ color: theme.iota }));
      tx += t.width + 2 * GAP;
    });

    // ---- two rows of slots for the current tab (paginated) ----
    const syms = this.visible(this.tab);
    const perRow = this.pageSize();
    const per = perRow * 2;
    const pageCount = Math.max(1, Math.ceil(syms.length / per));
    this.sub = Math.max(0, Math.min(this.sub, pageCount - 1));
    const paged = pageCount > 1;
    const pageSyms = syms.slice(this.sub * per, this.sub * per + per);
    const bottom = pageSyms.slice(0, perRow); // bottom row fills first; overflow goes up
    const top = pageSyms.slice(perRow);

    const rowW = (n: number): number => n * SLOT + Math.max(0, n - 1) * GAP;
    const maxW = Math.max(rowW(bottom.length), rowW(top.length));
    const ctrl = paged ? ARROW + GAP : 0;
    const totalW = maxW + 2 * ctrl;
    const leftEdge = window.innerWidth / 2 - totalW / 2;
    const rowsCenter = leftEdge + ctrl + maxW / 2;
    const placeRow = (rs: string[], y: number): void => {
      let x = rowsCenter - rowW(rs.length) / 2 + SLOT / 2;
      for (const sym of rs) {
        this.slotRow.addChild(this.slot(sym, x, y));
        x += SLOT + GAP;
      }
    };
    placeRow(bottom, yB);
    placeRow(top, yT);
    if (paged) {
      this.slotRow.addChild(this.arrow("‹", leftEdge + ARROW / 2, mid, this.sub > 0, () => this.flip(-1)));
      this.slotRow.addChild(this.arrow("›", leftEdge + totalW - ARROW / 2, mid, this.sub < pageCount - 1, () => this.flip(1)));
    }

    this.pageLabel.visible = paged;
    if (paged) {
      this.pageLabel.text = `${this.sub + 1}/${pageCount}`;
      this.pageLabel.position.set(window.innerWidth - MARGIN, tabY + 8);
    }

    if (this.popSym) {
      const v = (this.slotRow.children as Array<Container & { sym?: string }>).find((c) => c.sym === this.popSym);
      if (v) {
        v.scale.set(0.2);
        tween(this.ticker, 260, (t) => v.scale.set(0.2 + 0.8 * t));
      }
      this.popSym = null;
    }
  }

  private slot(sym: string, cx: number, cy: number): Container {
    const accent = sym === "ι" ? theme.iota : theme.accent;
    const v = new Container() as Container & { sym: string };
    v.sym = sym;
    v.addChild(new Graphics().roundRect(-SLOT / 2, -SLOT / 2, SLOT, SLOT, 8).fill({ color: theme.panel }).stroke({ width: 2, color: accent }));
    const glyph = new Text({ text: this.aliasOf(sym), style: { fontFamily: "monospace", fontSize: 24, fill: accent } });
    glyph.anchor.set(0.5);
    const maxW = SLOT - 10; // shrink long glyphs (e.g. "Succ", "Mult") to fit
    if (glyph.width > maxW) glyph.scale.set(maxW / glyph.width);
    v.addChild(glyph);
    v.position.set(cx, cy);
    v.eventMode = "static";
    v.cursor = "grab";
    v.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.onSpawnStart(this.spawnFor(sym), e);
    });
    return v;
  }

  private arrow(label: string, cx: number, cy: number, enabled: boolean, onClick: () => void): Container {
    const c = new Container();
    const t = new Text({ text: label, style: { fontFamily: "monospace", fontSize: 30, fill: theme.accent } });
    t.anchor.set(0.5);
    c.addChild(t);
    c.position.set(cx, cy);
    c.alpha = enabled ? 1 : 0.3;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new Rectangle(-ARROW / 2, -60, ARROW, 120); // spans both rows
    c.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      onClick();
    });
    return c;
  }
}
