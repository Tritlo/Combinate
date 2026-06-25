/**
 * Re-folding port (PLAN.md Phase 2): the pure boundary between a `Node` term and
 * the egg-via-WASM re-sugarer. This module is Pixi/DOM-free — it only knows how
 * to serialise a term to the egg s-expression syntax, parse the folded result
 * back to a `Node`, and wrap a raw string→string re-folder behind a guard. The
 * shell supplies the actual wasm `refold` function (the driven adapter).
 */
import { type Node, app, comb, freeVar, iota } from "./term";
import { CATALOG } from "./catalog";

// Catalog symbols that are not valid bare s-expression atoms ↔ their egg alias.
const TOKEN: Record<string, string> = { "(+)": "add", "(-)": "sub", "<>": "append", "Φ": "Phi", "Ψ": "Psi" };
const SYM: Record<string, string> = Object.fromEntries(Object.entries(TOKEN).map(([s, t]) => [t, s]));
const symToTok = (s: string): string => TOKEN[s] ?? s;
const tokToSym = (t: string): string => SYM[t] ?? t;
const LAW = new Map(CATALOG.map((l) => [l.sym, l]));

/** Serialize a term to egg s-expression syntax: `@` for application, bare atoms
 *  for leaves (`iota`, `S`/`K`/`I`, named birds). Inputs are closed, so a stray
 *  free variable just becomes a literal atom. */
export function toEgg(n: Node): string {
  switch (n.kind) {
    case "iota":
      return "iota";
    case "free":
      return n.name;
    case "comb":
      return symToTok(n.sym);
    case "app":
      return `(@ ${toEgg(n.fn)} ${toEgg(n.arg)})`;
  }
}

/** Rebuild a leaf atom into a `Node`: ι, a catalogued bird (carrying its def +
 *  arity so the reducer can still unfold it), or an opaque free variable. */
function leaf(atom: string): Node {
  if (atom === "iota") return iota();
  const sym = tokToSym(atom);
  const law = LAW.get(sym);
  if (law) return comb(sym, law.def?.(), law.arity);
  return freeVar(atom);
}

/** Parse an egg s-expression (`(@ fn arg)` / bare atoms) back into a `Node`. */
export function fromEgg(s: string): Node {
  const toks = s.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/);
  let i = 0;
  const parse = (): Node => {
    const t = toks[i++];
    if (t === "(") {
      const op = toks[i++];
      if (op !== "@") throw new Error(`refold: unexpected operator ${JSON.stringify(op)}`);
      const fn = parse();
      const arg = parse();
      if (toks[i++] !== ")") throw new Error("refold: expected )");
      return app(fn, arg);
    }
    if (t === ")" || t === undefined) throw new Error("refold: malformed s-expression");
    return leaf(t);
  };
  return parse();
}

/** Readability weight — a proxy for the Rust extractor's cost, used to keep a
 *  re-folding only when it is genuinely simpler than the input: raw ι is dear,
 *  the S/K/I primitives less so, named birds and free vars cheap. */
export function weight(n: Node): number {
  switch (n.kind) {
    case "iota":
      return 100;
    case "comb":
      return n.sym === "S" || n.sym === "K" || n.sym === "I" ? 30 : 1;
    case "free":
      return 1;
    case "app":
      return 2 + weight(n.fn) + weight(n.arg);
  }
}

/** A re-folder: a term in, a more-readable equivalent out, or `null` if nothing
 *  better was found (the caller then keeps the original). */
export type Refolder = (n: Node) => Node | null;

/**
 * Wrap a raw string→string re-folder (the wasm `refold`) into a `Refolder` over
 * `Node`s: serialise, fold, parse back, and only return the result when it is
 * strictly simpler than the input. Any failure (parse, panic) yields `null`.
 */
export function makeRefolder(raw: (sexpr: string) => string): Refolder {
  return (n) => {
    try {
      const folded = fromEgg(raw(toEgg(n)));
      return weight(folded) < weight(n) ? folded : null;
    } catch {
      return null;
    }
  };
}
