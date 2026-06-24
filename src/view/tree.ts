import { Container, Graphics, Rectangle, Text, type Ticker } from "pixi.js";
import { type Node, type NodeId } from "../core/term";
import { layout, type Layout } from "../core/layout";

const IOTA_COLOR = 0xffe08a;
const IOTA_GLYPH = 0x3a2f10;
const APP_COLOR = 0x6b7a90;
const COMB_COLOR = 0x3b78e8;

/** Edge to the function (left) child — bright and thick. */
export const FN_EDGE = 0x5ad1c0;
/** Edge to the argument (right) child — dim and thin. So `(ι X)` and `(X ι)`
 *  read differently: ι hangs off the teal edge in one, the grey edge in the other. */
export const ARG_EDGE = 0x46506a;

interface Anim {
  id: NodeId;
  obj: Container;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromA: number;
  toA: number;
  fromS: number;
  toS: number;
  remove: boolean;
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Renders one connected term tree into a draggable Pixi container (§5.3). One
 * display object per node, keyed by id, so a reduction step can tween: nodes
 * that persist glide to their new position, fresh nodes grow in, dropped nodes
 * fade out (§6.3).
 */
export class TreeView {
  readonly container = new Container();
  private readonly edges = new Graphics();
  private readonly nodes = new Container();
  node: Node;
  private lay: Layout;
  private readonly objs = new Map<NodeId, Container>();

  private anims: Anim[] = [];
  private elapsed = 0;
  private duration = 0;
  private onDone: (() => void) | null = null;
  private ticking = false;
  private readonly tick = (t: Ticker): void => this.advance(t.deltaMS);

  constructor(
    node: Node,
    worldX: number,
    worldY: number,
    private readonly ticker: Ticker,
  ) {
    this.node = node;
    this.lay = layout(node);
    this.container.addChild(this.edges, this.nodes);
    this.container.position.set(worldX, worldY);
    this.container.eventMode = "static";
    this.container.cursor = "grab";
    this.rebuild();
  }

  get rootWorld(): { x: number; y: number } {
    return { x: this.container.position.x, y: this.container.position.y };
  }

  /** True while a reduction tween is playing. */
  get animating(): boolean {
    return this.ticking;
  }

  destroy(): void {
    this.stopTicker();
    this.container.destroy({ children: true });
  }

  /** Animate a one-step reduction to `node`; `onDone` fires on natural finish.
   *  Persisting nodes glide, fresh nodes grow in, dropped nodes fade out. */
  animateTo(node: Node, duration: number, onDone: () => void): void {
    this.onDone = null;
    this.finish(); // settle any prior tween (without firing its callback)

    const from = new Map<NodeId, { x: number; y: number }>();
    for (const [id, o] of this.objs) from.set(id, { x: o.position.x, y: o.position.y });

    const newLay = layout(node);
    const newNodes = collectNodes(node);
    this.anims = [];

    // entering + persisting nodes
    for (const [id, n] of newNodes) {
      const target = newLay.pos.get(id)!;
      const existing = this.objs.get(id);
      if (existing) {
        const f = from.get(id)!;
        this.anims.push(mkAnim(id, existing, f.x, f.y, target.x, target.y, 1, 1, 1, 1));
      } else {
        const obj = makeNode(n);
        obj.position.set(target.x, target.y);
        obj.alpha = 0;
        obj.scale.set(0.3);
        this.objs.set(id, obj);
        this.nodes.addChild(obj);
        this.anims.push(mkAnim(id, obj, target.x, target.y, target.x, target.y, 0, 1, 0.3, 1));
      }
    }
    // leaving nodes
    for (const [id, obj] of this.objs) {
      if (!newNodes.has(id)) {
        this.anims.push(mkAnim(id, obj, obj.position.x, obj.position.y, obj.position.x, obj.position.y, obj.alpha, 0, 1, 0.4, true));
      }
    }

    this.node = node;
    this.lay = newLay;
    this.updateHitArea();
    this.elapsed = 0;
    this.duration = duration;
    this.onDone = onDone;
    this.drawEdges();
    this.startTicker();
  }

  /** Cancel a running tween, snapping to its settled state (no `onDone`). */
  stopAnimation(): void {
    this.onDone = null;
    this.finish();
  }

  private advance(deltaMS: number): void {
    this.elapsed += deltaMS;
    const t = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
    const e = easeInOut(t);
    for (const a of this.anims) {
      a.obj.position.set(a.fromX + (a.toX - a.fromX) * e, a.fromY + (a.toY - a.fromY) * e);
      a.obj.alpha = a.fromA + (a.toA - a.fromA) * e;
      a.obj.scale.set(a.fromS + (a.toS - a.fromS) * e);
    }
    this.drawEdges();
    if (t >= 1) this.finish();
  }

  private finish(): void {
    if (!this.ticking && this.anims.length === 0) return;
    for (const a of this.anims) {
      if (a.remove) {
        this.objs.delete(a.id);
        a.obj.destroy({ children: true });
      } else {
        a.obj.position.set(a.toX, a.toY);
        a.obj.alpha = a.toA;
        a.obj.scale.set(a.toS);
      }
    }
    this.anims = [];
    this.stopTicker();
    this.drawEdges();
    this.updateHitArea();
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  private startTicker(): void {
    if (!this.ticking) {
      this.ticker.add(this.tick);
      this.ticking = true;
    }
  }

  private stopTicker(): void {
    if (this.ticking) {
      this.ticker.remove(this.tick);
      this.ticking = false;
    }
  }

  private rebuild(): void {
    for (const o of this.objs.values()) o.destroy({ children: true });
    this.objs.clear();
    for (const [id, n] of collectNodes(this.node)) {
      const obj = makeNode(n);
      const p = this.lay.pos.get(id)!;
      obj.position.set(p.x, p.y);
      this.objs.set(id, obj);
      this.nodes.addChild(obj);
    }
    this.drawEdges();
    this.updateHitArea();
  }

  // Edges are drawn from the live object positions (so they follow tweens), with
  // function (left) edges and argument (right) edges in two distinct strokes.
  private drawEdges(): void {
    this.edges.clear();
    const fn: Array<[number, number, number, number]> = [];
    const arg: Array<[number, number, number, number]> = [];
    const walk = (n: Node): void => {
      if (n.kind !== "app") return;
      const p = this.objs.get(n.id)?.position;
      const lp = this.objs.get(n.fn.id)?.position;
      const rp = this.objs.get(n.arg.id)?.position;
      if (p && lp) fn.push([p.x, p.y, lp.x, lp.y]);
      if (p && rp) arg.push([p.x, p.y, rp.x, rp.y]);
      walk(n.fn);
      walk(n.arg);
    };
    walk(this.node);
    for (const [x1, y1, x2, y2] of arg) this.edges.moveTo(x1, y1).lineTo(x2, y2);
    this.edges.stroke({ width: 1.5, color: ARG_EDGE });
    for (const [x1, y1, x2, y2] of fn) this.edges.moveTo(x1, y1).lineTo(x2, y2);
    this.edges.stroke({ width: 3, color: FN_EDGE });
  }

  private updateHitArea(): void {
    const pad = 22;
    this.container.hitArea = new Rectangle(
      this.lay.minX - pad,
      this.lay.minY - pad,
      this.lay.width + 2 * pad,
      this.lay.height + 2 * pad,
    );
  }
}

function mkAnim(
  id: NodeId,
  obj: Container,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  fromA: number,
  toA: number,
  fromS: number,
  toS: number,
  remove = false,
): Anim {
  return { id, obj, fromX, fromY, toX, toY, fromA, toA, fromS, toS, remove };
}

function collectNodes(n: Node, m = new Map<NodeId, Node>()): Map<NodeId, Node> {
  m.set(n.id, n);
  if (n.kind === "app") {
    collectNodes(n.fn, m);
    collectNodes(n.arg, m);
  }
  return m;
}

function makeNode(n: Node): Container {
  const c = new Container();
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
