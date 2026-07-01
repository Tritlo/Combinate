/**
 * The iota term model (§3.1): a binary tree whose only leaf is ι and whose only
 * internal node is application. Transient S/K/I combinator leaves appear during
 * reduction when ι unfolds (`ι x → x S K`); the player never places them.
 *
 * The model is pure and immutable — reduction returns a new tree, preserving ids
 * for nodes that survive a step so the view can later tween them (§3.1, §6.3).
 */

export type NodeId = number;

/** A combinator symbol: the transient S/K/I that ι unfolds into, or a
 *  discovered law collapsed into a single node (A, X, …). */
export type Sym = string;

export type Node =
  | { id: NodeId; kind: "iota" }
  | { id: NodeId; kind: "comb"; sym: Sym; def?: Node; arity?: number }
  | { id: NodeId; kind: "free"; name: string }
  | { id: NodeId; kind: "app"; fn: Node; arg: Node };

let nextId = 1;

/** Mint a fresh, process-unique node id. Monotonic, so a freshly-minted id is
 *  always greater than any already in use — relied on by the graph reducer to keep
 *  contractum ids clash-free against ids preserved from the source term. */
export const freshId = (): NodeId => nextId++;

/** An ι leaf — the only block the player starts with. */
export const iota = (): Node => ({ id: freshId(), kind: "iota" });

/** A named combinator leaf: a transient S/K/I from reducing ι, or a collapsed
 * discovered law. `def` (the law's underlying ι-tree) lets the reducer unfold
 * combinators that have no built-in rule (A, X, …) when they are applied. */
export const comb = (sym: Sym, def?: Node, arity?: number): Node => ({ id: freshId(), kind: "comb", sym, def, arity });

/** An application node `(fn arg)`; `fn` is the left child, `arg` the right. */
export const app = (fn: Node, arg: Node): Node => ({ id: freshId(), kind: "app", fn, arg });

/** A free variable — an inert opaque leaf with no reduction rule, used by the
 * behavioural probe (§7.1) to test what a term does to fresh arguments. */
export const freeVar = (name: string): Node => ({ id: freshId(), kind: "free", name });

/**
 * Deep-copy a term, minting a FRESH id for every node so the copy is fully independent of the
 * original (the Copy action duplicates a subtree this way). A combinator's `def` body — an
 * immutable display-only ι-expansion — is shared, not re-minted.
 */
export function cloneTerm(n: Node): Node {
  switch (n.kind) {
    case "iota":
      return iota();
    case "comb":
      return comb(n.sym, n.def, n.arity);
    case "free":
      return freeVar(n.name);
    case "app":
      return app(cloneTerm(n.fn), cloneTerm(n.arg));
  }
}

/** Like {@link cloneTerm}, but also re-mints a combinator's `def` recursively
 *  instead of sharing it — used where a def is about to be spliced into a live
 *  tree (unfolding a redex, spawning a user combinator) and needs its own ids. */
export function cloneTermDeep(n: Node): Node {
  switch (n.kind) {
    case "iota":
      return iota();
    case "comb":
      return comb(n.sym, n.def ? cloneTermDeep(n.def) : undefined, n.arity);
    case "free":
      return freeVar(n.name);
    case "app":
      return app(cloneTermDeep(n.fn), cloneTermDeep(n.arg));
  }
}

/** Parse Barker prefix bit-code (§3.2: `1` = ι, `0 <fn> <arg>` = app) into a term. */
export function decode(code: string): Node {
  let i = 0;
  const go = (): Node => {
    const c = code[i++];
    if (c === "1") return iota();
    if (c === "0") {
      const fn = go();
      const arg = go();
      return app(fn, arg);
    }
    throw new Error(`decode: unexpected ${JSON.stringify(c)} at index ${i - 1}`);
  };
  const t = go();
  if (i !== code.length) throw new Error(`decode: trailing input after index ${i}`);
  return t;
}

/**
 * Remove the subtree rooted at `targetId`, healing the tree by promoting the
 * deleted node's sibling into its parent application's place. Returns the new
 * tree, or `null` when the target is the whole tree's root (delete everything).
 */
export function removeSubtree(root: Node, targetId: NodeId): Node | null {
  if (root.id === targetId) return null;
  const prune = (n: Node): Node => {
    if (n.kind !== "app") return n;
    if (n.fn.id === targetId) return n.arg; // drop fn → promote arg
    if (n.arg.id === targetId) return n.fn; // drop arg → promote fn
    return { ...n, fn: prune(n.fn), arg: prune(n.arg) };
  };
  return prune(root);
}

/**
 * Id range reserved per expanded combinator: its display ids are
 * `-(base * IOTA_ID_SPAN + k)`, so distinct source combinators (distinct base)
 * never collide as long as their ι-trees stay under this many nodes. Must exceed
 * the largest combinator's ι-tree (~800 nodes for the full "expand" view).
 */
export const IOTA_ID_SPAN = 1024;

/**
 * Decode bit-code into an ι-tree whose node ids are derived deterministically
 * from `base` (and negative, so they never collide with minted positive ids).
 * Used for *display-only* expansion of a combinator into its ι-tree: the same
 * source node always yields the same ids, so the view tweens it stably.
 */
export function iotaTreeFrom(code: string, base: number): Node {
  let i = 0;
  let idx = 0;
  const nextId = (): NodeId => -(base * IOTA_ID_SPAN + idx++ + 1);
  const go = (): Node => {
    const c = code[i++];
    if (c === "1") return { id: nextId(), kind: "iota" };
    const fn = go();
    const arg = go();
    return { id: nextId(), kind: "app", fn, arg };
  };
  return go();
}

/** Human-readable s-expression (§3.2): `ι` for leaves, `(L R)` for application. */
export function sexp(n: Node): string {
  switch (n.kind) {
    case "iota":
      return "ι";
    case "comb":
      return n.sym;
    case "free":
      return n.name;
    case "app":
      return `(${sexp(n.fn)} ${sexp(n.arg)})`;
  }
}

/** True if `n` has more than `max` nodes. Early-exit and **iterative** (an explicit heap
 *  stack, not recursion), so it costs O(min(size, max)) and can't blow the call stack on a
 *  deep spine — used as a size guard on potentially-huge reduction snapshots. */
export function exceedsNodes(n: Node, max: number): boolean {
  let count = 0;
  const stack: Node[] = [n];
  while (stack.length) {
    const m = stack.pop()!;
    if (++count > max) return true;
    if (m.kind === "app") {
      stack.push(m.fn, m.arg);
    }
  }
  return false;
}
