/**
 * The iota term model (§3.1): a binary tree whose only leaf is ι and whose only
 * internal node is application. Transient S/K/I combinator leaves appear during
 * reduction when ι unfolds (`ι x → x S K`); the player never places them.
 *
 * The model is pure and immutable — reduction returns a new tree, preserving ids
 * for nodes that survive a step so the view can later tween them (§3.1, §6.3).
 */

export type NodeId = number;

/** The combinator symbols ι can transiently unfold into. */
export type Sym = "S" | "K" | "I";

export type Node =
  | { id: NodeId; kind: "iota" }
  | { id: NodeId; kind: "comb"; sym: Sym }
  | { id: NodeId; kind: "free"; name: string }
  | { id: NodeId; kind: "app"; fn: Node; arg: Node };

let nextId = 1;

/** Mint a fresh, process-unique node id. */
export const freshId = (): NodeId => nextId++;

/** An ι leaf — the only block the player starts with. */
export const iota = (): Node => ({ id: freshId(), kind: "iota" });

/** A named combinator leaf (transient, produced by reducing ι). */
export const comb = (sym: Sym): Node => ({ id: freshId(), kind: "comb", sym });

/** An application node `(fn arg)`; `fn` is the left child, `arg` the right. */
export const app = (fn: Node, arg: Node): Node => ({ id: freshId(), kind: "app", fn, arg });

/** A free variable — an inert opaque leaf with no reduction rule, used by the
 * behavioural probe (§7.1) to test what a term does to fresh arguments. */
export const freeVar = (name: string): Node => ({ id: freshId(), kind: "free", name });

/**
 * Encode a term as Barker prefix bit-code (§3.2): `1` = ι, `0 <fn> <arg>` = app.
 * Transient combinator leaves have no bit-code; encoding one throws.
 */
export function encode(n: Node): string {
  switch (n.kind) {
    case "iota":
      return "1";
    case "app":
      return "0" + encode(n.fn) + encode(n.arg);
    case "comb":
      throw new Error(`cannot encode transient combinator ${n.sym}`);
    case "free":
      throw new Error(`cannot encode free variable ${n.name}`);
  }
}

/** Parse Barker prefix bit-code into a fresh term (inverse of {@link encode}). */
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
