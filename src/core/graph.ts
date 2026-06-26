/**
 * Call-by-need **graph reduction** with sharing (ADR 0007 follow-up; the opt-in
 * "graph" toggle). The pure tree reducer (`reduce.ts`) clones every duplicated
 * subterm, so Scott `*` (repeated addition) makes multiplication-*recursion*
 * exponential — `fac 4+` blows up. This evaluator **shares**: a duplicated subterm
 * is one cell, forced at most once, its result written back in place so every
 * reference sees it. `fac` becomes linear.
 *
 * Two consumers, same engine:
 *  - {@link GraphReducer} steps the live graph ONE leftmost-outermost contraction
 *    at a time and reads each snapshot back as a **shared `Node` DAG with stable
 *    ids** ({@link readBackShared}) — so the view can animate sharing: a shared
 *    subterm renders as one node with several incoming edges, and reducing it once
 *    updates it everywhere. This is what the toggle drives (pedagogy).
 *  - {@link evalShared} runs straight to normal form and reads back an unshared
 *    plain tree — for value probes that the tree reducer can't reach (`fac`-scale).
 *
 * Reduction is **lazy** (leftmost-outermost), mirroring `reduce.ts step` in the
 * same dispatch order, so the normal form equals `normalize(...).term` (sharing
 * changes only cost) — including not forcing discarded args (`K a Ω → a`). The
 * mutable graph never escapes this module; `term.ts`/`reduce.ts`/the view's OFF
 * path are untouched.
 */
import { type Node, type NodeId, app as mkNode, comb as combNode, iota as iotaNode, freeVar, freshId } from "./term";
import { RULES } from "./catalog";

// A mutable graph cell. `ind` is an indirection: a forced node overwrites itself
// with `ind → result`, so every sharer sees the result on its next force.
type Cell =
  | { t: "iota" }
  | { t: "comb"; sym: string; def?: Node; arity?: number }
  | { t: "free"; name: string }
  | { t: "app"; fn: Ref; arg: Ref }
  | { t: "ind"; to: Ref };
type AppCell = { t: "app"; fn: Ref; arg: Ref };

// Each cell carries a stable id, reused as the read-back Node id so the view
// tweens a surviving cell across reduction snapshots. Contracta mint a fresh
// global id (`freshId`, always above any source id → no clash); the INITIAL graph
// preserves the source term's ids so the first reduction step tweens cleanly
// (`toGraphKeep`) instead of replacing the whole tree.
interface Ref {
  id: NodeId;
  c: Cell;
}
const ref = (c: Cell): Ref => ({ id: freshId(), c });
const appR = (fn: Ref, arg: Ref): Ref => ref({ t: "app", fn, arg });

/** Chase indirections to the representative cell (the shared identity of a node). */
function force(r: Ref): Ref {
  while (r.c.t === "ind") r = r.c.to;
  return r;
}

/** A plain term → a graph with FRESH ids (def unfolds, rule bodies, value probes). */
// Iterative (a recursive build overflows the JS stack on the deep trees MicroHs
// emits). Builds bottom-up via an explicit stack; the memo also shares a DAG input
// correctly (a no-op on a tree).
function toGraph(root: Node): Ref {
  const built = new Map<Node, Ref>();
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack[stack.length - 1];
    if (built.has(n)) {
      stack.pop();
      continue;
    }
    if (n.kind === "app") {
      const f = built.get(n.fn);
      const a = built.get(n.arg);
      if (f === undefined || a === undefined) {
        if (a === undefined) stack.push(n.arg); // build children first
        if (f === undefined) stack.push(n.fn);
        continue;
      }
      built.set(n, ref({ t: "app", fn: f, arg: a }));
    } else if (n.kind === "iota") {
      built.set(n, ref({ t: "iota" }));
    } else if (n.kind === "comb") {
      built.set(n, ref({ t: "comb", sym: n.sym, def: n.def, arity: n.arity }));
    } else {
      built.set(n, ref({ t: "free", name: n.name }));
    }
    stack.pop();
  }
  return built.get(root)!;
}

/** A plain term → a graph PRESERVING the source ids — only for the initial graph,
 *  whose ids are unique, so the first snapshot equals the displayed tree. */
function toGraphKeep(n: Node): Ref {
  switch (n.kind) {
    case "iota":
      return { id: n.id, c: { t: "iota" } };
    case "comb":
      return { id: n.id, c: { t: "comb", sym: n.sym, def: n.def, arity: n.arity } };
    case "free":
      return { id: n.id, c: { t: "free", name: n.name } };
    case "app":
      return { id: n.id, c: { t: "app", fn: toGraphKeep(n.fn), arg: toGraphKeep(n.arg) } };
  }
}

/**
 * Apply an optimize-mode catalog rule with SHARING. A rule `(args) => body` places
 * its argument terms (often twice — `(+)`/`(*)` thread `n` into both branches). We
 * call it with fresh sentinel free-vars, then graph-convert the body mapping each
 * sentinel back to the one shared arg `Ref` — so a doubly-placed arg is one shared
 * cell, not two clones. (Rules only place args; never inspect them — verified for
 * the catalog's plus/times/.../Y rules.)
 */
function ruleGraph(sym: string, args: Ref[]): Ref {
  const sentinels = args.map((_, i) => freeVar("$a" + i));
  const body = RULES[sym](sentinels);
  const byId = new Map<NodeId, Ref>();
  sentinels.forEach((s, i) => byId.set(s.id, args[i]));
  const conv = (n: Node): Ref => {
    switch (n.kind) {
      case "free":
        return byId.get(n.id) ?? ref({ t: "free", name: n.name });
      case "iota":
        return ref({ t: "iota" });
      case "comb":
        return ref({ t: "comb", sym: n.sym, def: n.def, arity: n.arity });
      case "app":
        return ref({ t: "app", fn: conv(n.fn), arg: conv(n.arg) });
    }
  };
  return conv(body);
}

/**
 * Contract the leftmost-outermost redex at the top of `spine` (an unwound left
 * spine of `app` cells; `head` is its non-app leftmost). Mutates in place and
 * returns true, or returns false if `head` is already WHNF for these args. The
 * dispatch order mirrors `reduce.ts step` so the normal form matches.
 */
function contract(head: Ref, spine: Ref[], fast: boolean): boolean {
  const m = spine.length;
  const arg = (k: number): Ref => (spine[m - 1 - k].c as AppCell).arg;
  const c = head.c;
  if (c.t === "iota") {
    if (m < 1) return false; // ι x → x S K
    spine[m - 1].c = { t: "ind", to: appR(appR(arg(0), ref({ t: "comb", sym: "S" })), ref({ t: "comb", sym: "K" })) };
    return true;
  }
  if (c.t === "comb") {
    const sym = c.sym;
    if (sym === "I") {
      if (m < 1) return false; // I x → x
      spine[m - 1].c = { t: "ind", to: arg(0) };
      return true;
    }
    if (sym === "K") {
      if (m < 2) return false; // K x y → x   (y is never forced — laziness)
      spine[m - 2].c = { t: "ind", to: arg(0) };
      return true;
    }
    if (sym === "S") {
      if (m < 3) return false; // S x y z → x z (y z), z SHARED
      const z = arg(2);
      spine[m - 3].c = { t: "ind", to: appR(appR(arg(0), z), appR(arg(1), z)) };
      return true;
    }
    const arity = c.arity ?? 1;
    if (m < arity) return false; // partial named combinator → WHNF
    if (fast && RULES[sym]) {
      spine[m - arity].c = { t: "ind", to: ruleGraph(sym, Array.from({ length: arity }, (_, k) => arg(k))) };
      return true;
    }
    if (c.def) {
      head.c = { t: "ind", to: toGraph(c.def) }; // unfold its SKI definition
      return true;
    }
    return false; // inert combinator (no rule, no def) → WHNF
  }
  return false; // free variable → WHNF
}

/** One leftmost-outermost contraction anywhere in the graph from `root`; returns
 *  whether anything reduced (false → normal form). */
function stepGraph(root: Ref, fast: boolean): boolean {
  const go = (r: Ref): boolean => {
    const spine: Ref[] = [];
    let cur = force(r);
    while (cur.c.t === "app") {
      spine.push(cur);
      cur = force(cur.c.fn);
    }
    if (contract(cur, spine, fast)) return true;
    for (let i = spine.length - 1; i >= 0; i--) {
      if (go((spine[i].c as AppCell).arg)) return true; // leftmost (inner) arg first
    }
    return false;
  };
  return go(root);
}

const READBACK_CAP = 4_000_000; // node ceiling when materialising a snapshot

/**
 * Read the live graph back to a **shared `Node` DAG**: one Node per cell, keyed by
 * the cell's stable id, so a shared subterm is a single Node object reachable from
 * several parents (the view renders it once, with several incoming edges). A
 * DFS-path guard rejects a cyclic graph (shouldn't arise for our terms); the node
 * cap bounds a pathological snapshot.
 */
function readBackShared(root: Ref): Node {
  const memo = new Map<Ref, Node>();
  const onPath = new Set<Ref>();
  let count = 0;
  const go = (rr: Ref): Node => {
    const f = force(rr);
    const hit = memo.get(f);
    if (hit) return hit;
    if (++count > READBACK_CAP) throw new Error("readback: snapshot too large");
    switch (f.c.t) {
      case "iota": {
        const node: Node = { id: f.id, kind: "iota" };
        memo.set(f, node);
        return node;
      }
      case "comb": {
        const node: Node = { id: f.id, kind: "comb", sym: f.c.sym, def: f.c.def, arity: f.c.arity };
        memo.set(f, node);
        return node;
      }
      case "free": {
        const node: Node = { id: f.id, kind: "free", name: f.c.name };
        memo.set(f, node);
        return node;
      }
      case "app": {
        if (onPath.has(f)) throw new Error("readback: cyclic graph");
        onPath.add(f);
        const node: Node = { id: f.id, kind: "app", fn: go(f.c.fn), arg: go(f.c.arg) };
        onPath.delete(f);
        memo.set(f, node);
        return node;
      }
      default:
        throw new Error("readback: unexpected indirection");
    }
  };
  return go(root);
}

/**
 * A live, steppable shared-graph reduction of a term. Each {@link step} performs
 * one leftmost-outermost contraction (sharing duplicated subterms in place); each
 * {@link snapshot} reads the current graph back as a shared DAG with stable ids,
 * for the view to animate. Drives the "graph" toggle's auto-reduction.
 */
export class GraphReducer {
  private root: Ref;
  steps = 0;
  constructor(n: Node, private readonly fast: boolean) {
    this.root = toGraphKeep(n); // preserve source ids so the first step tweens
  }
  /** One contraction; false once the term is in normal form. */
  step(): boolean {
    const changed = stepGraph(this.root, this.fast);
    if (changed) this.steps++;
    return changed;
  }
  /** The current graph as a shared Node DAG (stable ids; tweens across steps). */
  snapshot(): Node {
    return readBackShared(force(this.root));
  }
}

/** The outcome of a straight-to-NF shared reduction — same shape as a normalize result. */
export interface ShareResult {
  term: Node;
  steps: number;
  done: boolean;
}

/**
 * Reduce `n` to normal form with sharing and read it back as an UNshared plain
 * tree (fresh ids). `cap` bounds steps; `fast` enables optimize-mode rules
 * (mirroring `normalize(n, cap, fast)`). For value probes (`value.ts`/`mhs.ts`)
 * that the cloning tree reducer can't reach at `fac`-scale. `done` is false on
 * budget exhaustion or an un-materialisable result.
 */
export function evalShared(n: Node, cap = 500_000, fast = false): ShareResult {
  let steps = 0;

  const whnf = (r: Ref): void => {
    for (;;) {
      if (steps >= cap) return;
      const spine: Ref[] = [];
      let cur = force(r);
      while (cur.c.t === "app") {
        spine.push(cur);
        cur = force(cur.c.fn);
      }
      if (!contract(cur, spine, fast)) return;
      steps++;
    }
  };
  // Iterative (a recursive descent into every argument overflows the JS stack on
  // a deep result): force each ref to WHNF, then queue its spine arguments.
  const normalForm = (r0: Ref): void => {
    const work: Ref[] = [r0];
    while (work.length) {
      if (steps >= cap) return;
      const r = work.pop()!;
      whnf(r);
      let cur = force(r);
      while (cur.c.t === "app") {
        work.push(cur.c.arg);
        cur = force(cur.c.fn);
      }
    }
  };
  // Un-shared read-back (fresh ids): the NF value, expanded to a plain tree.
  const readBackTree = (r: Ref): Node => {
    let count = 0;
    const onPath = new Set<Ref>();
    const go = (rr: Ref): Node => {
      const f = force(rr);
      if (++count > READBACK_CAP) throw new Error("readback: result too large");
      switch (f.c.t) {
        case "iota":
          return iotaNode();
        case "comb":
          return combNode(f.c.sym, f.c.def, f.c.arity);
        case "free":
          return freeVar(f.c.name);
        case "app": {
          if (onPath.has(f)) throw new Error("readback: cyclic graph");
          onPath.add(f);
          const node = mkNode(go(f.c.fn), go(f.c.arg));
          onPath.delete(f);
          return node;
        }
        default:
          throw new Error("readback: unexpected indirection");
      }
    };
    return go(r);
  };

  try {
    const root = toGraph(n);
    normalForm(root);
    return { term: readBackTree(root), steps, done: steps < cap };
  } catch {
    return { term: n, steps, done: false };
  }
}
