import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text, type Ticker } from "pixi.js";
import { type Node } from "../core/term";
import { PAGES, CATALOG } from "../core/catalog";
import { theme, currentMode, combinatorColor } from "./theme";
import { tween } from "./anim";

/** Each combinator's defining law, keyed by symbol — the hover tooltip's text. */
const LAW = new Map(CATALOG.map((l) => [l.sym, l] as const));

const SLOT = 52;
const GAP = 8;
const MARGIN = 80; // keep the row clear of the screen edges
const ARROW = 28; // width of a ‹ / › page button
const PAD = 14; // palette-window inner padding
const NARROW = 560; // phone layout: smaller tabs + tighter margins

/** Mono black-and-white chrome for the palette window, matching the menu bar. */
function mono(): { paper: number; ink: number } {
  return currentMode() === "dark" ? { paper: 0x07090d, ink: 0xf0f3f6 } : { paper: 0xffffff, ink: 0x000000 };
}

/**
 * The hotbar (§8.1), bottom-centre — styled as an early-Photoshop tool palette: a
 * 1px-bordered black-and-white window whose title strip is the category tabs
 * (Programs / Booleans / Arithmetic / …), over a grid of draggable tool cells for
 * the *discovered* combinators on that tab (paginated with ‹ / › when they don't
 * fit). Each cell shows the combinator under its page alias (e.g. "Mult" for B)
 * and stamps that combinator's tree when dragged out.
 */
export class Hotbar {
  readonly container = new Container();
  private readonly frame = new Graphics(); // the palette-window box (behind everything)
  private readonly tabBar = new Container();
  private readonly slotRow = new Container();
  private readonly pageLabel = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 12, fill: theme.textDim } });
  private readonly tip = new Container(); // hover tooltip: the combinator's law
  private readonly tipBg = new Graphics();
  private readonly tipText = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 13, fill: theme.text } });
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
    this.tip.eventMode = "none"; // never eat the pointer it's describing
    this.tip.visible = false;
    this.tip.addChild(this.tipBg, this.tipText);
    this.container.addChild(this.frame, this.tabBar, this.slotRow, this.pageLabel, this.tip);
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
    const margin = window.innerWidth < NARROW ? 14 : MARGIN; // tighter edges on phones → more cells per row
    const avail = window.innerWidth - 2 * margin - 2 * (ARROW + GAP) - GAP;
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
    this.hideTip(); // the hovered cell is about to be rebuilt; drop any stale tip
    this.frame.clear();
    for (const c of this.tabBar.removeChildren()) c.destroy({ children: true });
    for (const c of this.slotRow.removeChildren()) c.destroy({ children: true });
    const { paper, ink } = mono();
    const yB = window.innerHeight - 50; // bottom row centre
    const yT = yB - (SLOT + GAP); // top row centre
    const mid = (yB + yT) / 2;
    const tabY = yT - SLOT / 2 - 28; // tab row — the palette's title strip

    // ---- title strip: the category tabs (centred; smaller + tighter on phones,
    // where six names won't fit at full size) ----
    const narrow = window.innerWidth < NARROW;
    const tabFont = narrow ? 11 : 13;
    const tabGap = narrow ? 5 : 2 * GAP;
    // Incremental: only show a page once it has a discovered combinator (ι keeps
    // Programs always present). The tab carries its real PAGES index.
    const shown = PAGES.map((_p, i) => i).filter((i) => this.visible(i).length > 0);
    const labels = shown.map((i) => new Text({ text: PAGES[i].name, style: { fontFamily: "monospace", fontSize: tabFont, fill: ink } }));
    const tabsW = labels.reduce((s, t) => s + t.width, 0) + tabGap * Math.max(0, labels.length - 1);
    let tx = window.innerWidth / 2 - tabsW / 2;
    shown.forEach((i, idx) => {
      const t = labels[idx];
      t.position.set(tx, tabY);
      t.alpha = i === this.tab ? 1 : 0.4; // active tab full ink, the rest dimmed
      t.eventMode = "static";
      t.cursor = "pointer";
      t.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        this.setTab(i);
      });
      this.tabBar.addChild(t);
      if (i === this.tab) this.tabBar.addChild(new Graphics().rect(tx, tabY + tabFont + 4, t.width, 2).fill({ color: ink }));
      tx += t.width + tabGap;
    });

    // ---- tool cells for the current tab (two rows, paginated) ----
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

    // ---- the palette window: a 1px black/white box around the title + grid ----
    const contentW = Math.max(tabsW, totalW);
    const boxW = Math.min(contentW + 2 * PAD, window.innerWidth - 12); // keep the frame on-screen on narrow viewports
    const boxL = Math.max(6, window.innerWidth / 2 - boxW / 2);
    const boxT = tabY - PAD;
    const boxH = yB + SLOT / 2 + PAD - boxT;
    this.frame
      .rect(boxL + 3, boxT + 4, boxW, boxH).fill({ color: ink, alpha: 0.16 }) // soft hard-edged drop shadow
      .rect(boxL, boxT, boxW, boxH).fill({ color: paper }).stroke({ width: 1, color: ink })
      .moveTo(boxL + 8, tabY + 24).lineTo(boxL + boxW - 8, tabY + 24).stroke({ width: 1, color: ink, alpha: 0.4 }); // title separator

    this.pageLabel.visible = paged && !narrow; // on phones it grazes the last tab; ‹ › already signal pages
    if (paged) {
      this.pageLabel.text = `${this.sub + 1}/${pageCount}`;
      this.pageLabel.style.fill = ink;
      this.pageLabel.alpha = 0.6;
      this.pageLabel.position.set(boxL + boxW - 8, tabY + 9);
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
    const { paper, ink } = mono();
    const glyphColor = sym === "ι" ? theme.iota : combinatorColor(sym); // ι gold; other combinators ink (mono) / per-combinator hue (colour)
    const v = new Container() as Container & { sym: string };
    v.sym = sym;
    v.addChild(new Graphics().rect(-SLOT / 2, -SLOT / 2, SLOT, SLOT).fill({ color: paper }).stroke({ width: 1, color: ink }));
    const glyph = new Text({ text: this.aliasOf(sym), style: { fontFamily: "monospace", fontSize: 22, fill: glyphColor } });
    glyph.anchor.set(0.5);
    const maxW = SLOT - 10; // shrink long glyphs (e.g. "Succ", "Mult") to fit
    if (glyph.width > maxW) glyph.scale.set(maxW / glyph.width);
    v.addChild(glyph);
    v.position.set(cx, cy);
    v.eventMode = "static";
    v.cursor = "grab";
    v.on("pointerover", () => this.showTip(sym, cx, cy));
    v.on("pointerout", () => this.hideTip());
    v.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.hideTip(); // grabbing it — the tip would just trail the drag
      this.onSpawnStart(this.spawnFor(sym), e);
    });
    return v;
  }

  /** The law shown when hovering a cell: ι's read-back, or the combinator's
   *  `lawText`, prefixed with the page alias when it differs (e.g. "Mult = B"). */
  private tipFor(sym: string): string {
    const lawText = sym === "ι" ? "ι x = x S K" : (LAW.get(sym)?.lawText ?? sym);
    const alias = this.aliasOf(sym);
    return alias === sym ? lawText : `${alias} = ${sym}\n${lawText}`;
  }

  /** Float the law tooltip just above the hovered cell (System-1 white box). */
  private showTip(sym: string, cx: number, cy: number): void {
    const { paper, ink } = mono();
    this.tipText.text = this.tipFor(sym);
    this.tipText.style.fill = ink;
    const padX = 10;
    const padY = 7;
    const w = this.tipText.width + 2 * padX;
    const h = this.tipText.height + 2 * padY;
    const x = Math.max(6, Math.min(cx - w / 2, window.innerWidth - w - 6)); // keep it on-screen
    const y = cy - SLOT / 2 - h - 10; // hover above the cell, clear of the grid
    this.tipBg
      .clear()
      .rect(3, 4, w, h)
      .fill({ color: ink, alpha: 0.16 }) // hard-edged drop shadow, matching the palette frame
      .rect(0, 0, w, h)
      .fill({ color: paper })
      .stroke({ width: 1, color: ink });
    this.tipText.position.set(padX, padY);
    this.tip.position.set(Math.round(x), Math.round(y));
    this.tip.visible = true;
  }

  private hideTip(): void {
    this.tip.visible = false;
  }

  private arrow(label: string, cx: number, cy: number, enabled: boolean, onClick: () => void): Container {
    const c = new Container();
    const t = new Text({ text: label, style: { fontFamily: "monospace", fontSize: 26, fill: mono().ink } });
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
