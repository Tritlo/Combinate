/**
 * Re-folding port (PLAN.md Phase 2): the pure boundary between a `Node` term and
 * the egg-via-WASM re-sugarer. This module is Pixi/DOM-free — it only knows how
 * to serialise a term to the egg s-expression syntax, parse the folded result
 * back to a `Node`, and wrap a raw string→string re-folder behind a guard. The
 * shell supplies the actual wasm `refold` function (the driven adapter).
 */
import { type Node, app, comb, freeVar, iota } from "./term";
import { CATALOG, type Law } from "./catalog";
import { recognize } from "./probe";

// Catalog symbols that are not valid bare s-expression atoms ↔ their egg alias.
const TOKEN: Record<string, string> = { "(+)": "add", "(-)": "sub", "(*)": "mul", "<>": "append", "Φ": "Phi", "Ψ": "Psi" };
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
  // `LAW` is a load-time snapshot; fall back to the live catalog so player-authored
  // combinators (Add Rule / Define, pushed at runtime) round-trip as named nodes.
  const law = LAW.get(sym) ?? CATALOG.find((l) => l.sym === sym);
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

/** Total node count (apps + leaves) — bounds how big a subtree we bother probing. */
function nodeCount(n: Node): number {
  return n.kind === "app" ? 1 + nodeCount(n.fn) + nodeCount(n.arg) : 1;
}

/** Collapse a recognised law into its named node, carrying def + arity so the
 *  result stays reducible. */
const namedNode = (law: Law): Node => comb(law.sym, law.def?.(), law.arity);

/**
 * Behavioural re-folding (the pre-pass): recursively name subterms that
 * *behave as* a catalog combinator. Unlike the egg engine this is extensional —
 * it applies a subterm to fresh variables and reduces (via `recognize`) — so it
 * collapses eta-equivalent forms egg cannot, e.g. `S K K → I`, `ι ι → I`, as
 * well as the structural ones (`S (K S) K → B`).
 *
 * Top-down: the largest subtree that realises a single combinator wins, so we
 * never recurse inside something already named. Only `app` nodes are probed
 * (leaves are already atomic), and only when small enough — a subtree bigger
 * than `maxNodes` is unlikely to be one small combinator and is skipped (but
 * still descended into) to keep the pass cheap.
 */
export function recognizeDeep(n: Node, cap = 1500, maxNodes = 160): Node {
  if (n.kind !== "app") return n; // a bare ι / combinator / var is already atomic
  if (nodeCount(n) <= maxNodes) {
    const law = recognize(n, cap);
    if (law) return namedNode(law);
  }
  const fn = recognizeDeep(n.fn, cap, maxNodes);
  const arg = recognizeDeep(n.arg, cap, maxNodes);
  return fn === n.fn && arg === n.arg ? n : app(fn, arg);
}

/** A re-folder: a term in, a more-readable equivalent out, or `null` if nothing
 *  better was found (the caller then keeps the original). */
export type Refolder = (n: Node) => Node | null;

/** The behavioural-only re-folder — pure TS, no wasm. Names single-combinator
 *  subterms and keeps the result only if it is strictly simpler. Doubles as the
 *  graceful fallback when the egg wasm is unavailable. */
export const behavioralRefolder: Refolder = (n) => {
  let folded: Node;
  try {
    folded = recognizeDeep(n);
  } catch {
    return null;
  }
  return weight(folded) < weight(n) ? folded : null;
};

/**
 * The full re-folder: behavioural pre-pass → egg. First `recognizeDeep` names
 * every single-combinator subterm (extensional, fixes the eta cases); then the
 * wasm `refold` runs on that residual to fold any remaining multi-combinator
 * structure, keeping its result only if it is simpler still. The output is
 * returned only when strictly simpler than the input; if egg fails the
 * behavioural result stands.
 */
export function makeRefolder(raw: (sexpr: string) => string): Refolder {
  return (n) => {
    let best: Node;
    try {
      best = recognizeDeep(n);
    } catch {
      return null;
    }
    try {
      const egged = fromEgg(raw(toEgg(best)));
      if (weight(egged) < weight(best)) best = egged;
    } catch {
      // egg unavailable or threw — the behavioural pre-pass result stands.
    }
    return weight(best) < weight(n) ? best : null;
  };
}
