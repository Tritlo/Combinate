import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { type Node } from "../core/term";
import { layout, type Layout } from "../core/layout";

const IOTA_COLOR = 0xffe08a;
const IOTA_GLYPH = 0x3a2f10;
const APP_COLOR = 0x6b7a90;
const COMB_COLOR = 0x3b78e8;
const EDGE_COLOR = 0x44506a;

/**
 * Renders one connected term tree into a draggable Pixi container (§5.3): a
 * single Graphics holds all edges, and a child container holds one display
 * object per node. Phase 0 rebuilds the display on every change (no tween yet).
 */
export class TreeView {
  readonly container = new Container();
  private readonly edges = new Graphics();
  private readonly nodes = new Container();
  node: Node;
  private lay!: Layout;

  constructor(node: Node, worldX: number, worldY: number) {
    this.node = node;
    this.container.addChild(this.edges, this.nodes);
    this.container.position.set(worldX, worldY);
    this.container.eventMode = "static";
    this.container.cursor = "grab";
    this.relayout();
  }

  /** Replace the term and rebuild the display. */
  setNode(node: Node): void {
    this.node = node;
    this.relayout();
  }

  /** Root anchor in world coordinates (the container origin = root at local 0,0). */
  get rootWorld(): { x: number; y: number } {
    return { x: this.container.position.x, y: this.container.position.y };
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private relayout(): void {
    this.lay = layout(this.node);
    this.edges.clear();
    for (const child of this.nodes.removeChildren()) child.destroy({ children: true });

    this.drawEdges(this.node);
    this.edges.stroke({ width: 2, color: EDGE_COLOR });
    this.drawNodes(this.node);

    const pad = 22;
    this.container.hitArea = new Rectangle(
      this.lay.minX - pad,
      this.lay.minY - pad,
      this.lay.width + 2 * pad,
      this.lay.height + 2 * pad,
    );
  }

  private drawEdges(n: Node): void {
    if (n.kind !== "app") return;
    const p = this.lay.pos.get(n.id)!;
    for (const c of [n.fn, n.arg]) {
      const cp = this.lay.pos.get(c.id)!;
      this.edges.moveTo(p.x, p.y).lineTo(cp.x, cp.y);
      this.drawEdges(c);
    }
  }

  private drawNodes(n: Node): void {
    const p = this.lay.pos.get(n.id)!;
    this.nodes.addChild(makeNode(n, p.x, p.y));
    if (n.kind === "app") {
      this.drawNodes(n.fn);
      this.drawNodes(n.arg);
    }
  }
}

function makeNode(n: Node, x: number, y: number): Container {
  const c = new Container();
  c.position.set(x, y);
  if (n.kind === "iota") {
    c.addChild(new Graphics().circle(0, 0, 7).fill(IOTA_COLOR));
    c.addChild(label("ι", IOTA_GLYPH, 10));
  } else if (n.kind === "comb") {
    c.addChild(new Graphics().circle(0, 0, 15).fill(COMB_COLOR));
    c.addChild(label(n.sym, 0xffffff, 15));
  } else {
    c.addChild(new Graphics().circle(0, 0, 5).fill(APP_COLOR));
  }
  return c;
}

function label(text: string, color: number, size: number): Text {
  const t = new Text({ text, style: { fontFamily: "monospace", fontSize: size, fill: color } });
  t.anchor.set(0.5);
  return t;
}
