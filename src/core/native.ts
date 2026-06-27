/**
 * Native value evaluation (ADR 10) — an opt-in reducer peephole. When a *saturated
 * named catalog op* (`(+)`, `(*)`, `<>`, `not`, …) is applied to args the
 * {@link value.ts} matchers recognise as values, compute the result natively and emit
 * the **canonical pure tree** straight away (e.g. `(*) 12 15` → the Scott numeral `180`,
 * skipping the O(n) Scott recursion). No native value ever escapes the reducer, so the
 * round-trip invariant holds by construction: permalinks, the behavioural probe, and
 * toggling-off all keep seeing ordinary pure terms. Default off = plain pure reduction.
 *
 * Discovery is cheap ({@link nativeOpArity} is just a Set lookup); the expensive match
 * happens in {@link nativeContract}, which the reducer calls only when a redex actually
 * fires (so `firingRule`/existence checks stay cheap). Each op mirrors its catalog
 * rule's forcing — it never reduces an operand the pure rule wouldn't — and the
 * materialised numeral size is capped (a huge product falls back to the step-capped
 * pure reducer rather than allocating it in one step).
 *
 * Scope: a catalog-Scott (named-op) fast path; it does NOT touch arithmetic built from
 * raw S/K/I (the SKI-Quest's Church numerals — no named op to intercept). See ADR 10.
 * Chars are Scott numerals (codepoints), so the number ops already cover char
 * comparison; there's no separate char peephole.
 */
import { type Node, app } from "./term";
import { named } from "./catalog";
import { matchNumeral, matchList, matchBool } from "./value";

/** Which native value classes are enabled (mirrors the optimize toggles). */
export interface NativeOpts {
  numbers?: boolean;
  lists?: boolean;
  booleans?: boolean;
}

// A Scott numeral `Succ^k Z` is a k-deep tree, and the (recursive) reducer/renderer
// walk it by depth — so a large native numeral would overflow the stack. Cap native
// numeral output well below that; bigger results fall back to the pure reducer (which
// is step-capped and auto-pauses, so it never materialises a stack-blowing tree either).
const MAX_NAT = 4096;

// ---- writers: a native value → its EXACT canonical Scott tree (must match what the
// pure catalog rule produces, or the round-trip breaks). ----
/** The Scott Peano numeral `Succ^k Z` (Z = K). */
export function natTree(k: number): Node {
  let t: Node = named("K");
  for (let i = 0; i < k; i++) t = app(named("Succ"), t);
  return t;
}
const boolTree = (b: boolean): Node => (b ? app(named("K"), named("I")) : named("K")); // True = K I, False = K
const ordTree = (c: number): Node => named(c < 0 ? "LT" : c > 0 ? "GT" : "EQ");
/** A Scott list of `heads` ending in `tail`: `cons h₀ (cons h₁ (… tail))`, nil = K. */
const consTree = (heads: Node[], tail: Node): Node => heads.reduceRight((acc, h) => app(app(named("cons"), h), acc), tail);

const NUM_OPS = new Set(["(+)", "(-)", "(*)", "(==)", "(/=)", "(<)", "(<=)", "(>)", "(>=)", "compare"]);
const LIST_OPS = new Set(["<>", "map", "concat"]);
const BOOL_OPS = new Set(["not", "and", "or"]);
const CMP: Record<string, (a: number, b: number) => Node> = {
  "(==)": (a, b) => boolTree(a === b),
  "(/=)": (a, b) => boolTree(a !== b),
  "(<)": (a, b) => boolTree(a < b),
  "(<=)": (a, b) => boolTree(a <= b),
  "(>)": (a, b) => boolTree(a > b),
  "(>=)": (a, b) => boolTree(a >= b),
  compare: (a, b) => ordTree(a === b ? 0 : a < b ? -1 : 1),
};

/** If `sym` is a native op for the enabled value classes, its arity — for cheap redex
 *  discovery. Null otherwise. The actual match/compute is in {@link nativeContract}. */
export function nativeOpArity(sym: string, opts: NativeOpts): number | null {
  if (opts.numbers && NUM_OPS.has(sym)) return 2;
  if (opts.lists && LIST_OPS.has(sym)) return sym === "concat" ? 1 : 2;
  if (opts.booleans && BOOL_OPS.has(sym)) return sym === "not" ? 1 : 2;
  return null;
}

/**
 * Contract a saturated native op on recognised values → the canonical pure tree, or
 * `null` to fall back to the catalog rule. `args` is the full spine (length ≥ arity).
 */
export function nativeContract(sym: string, args: Node[], opts: NativeOpts): Node | null {
  if (opts.numbers && NUM_OPS.has(sym)) return numberOp(sym, args);
  if (opts.lists && LIST_OPS.has(sym)) return listOp(sym, args);
  if (opts.booleans && BOOL_OPS.has(sym)) return boolOp(sym, args);
  return null;
}

const reapply = (res: Node, args: Node[], from: number): Node => {
  for (let i = from; i < args.length; i++) res = app(res, args[i]);
  return res;
};

function numberOp(sym: string, args: Node[]): Node | null {
  if (args.length < 2) return null;
  const [x, y] = args;
  switch (sym) {
    case "(+)": {
      // (+) a n = Succ^a n — force only the first operand; n stays raw (exactly what
      // the pure rule does, and it never forces n, even if n diverges).
      const a = matchNumeral(x);
      if (a === null) return null;
      let r: Node = y;
      for (let i = 0; i < a; i++) r = app(named("Succ"), r);
      return reapply(r, args, 2);
    }
    case "(*)": {
      // (*) Z n = Z (the pure rule doesn't force n here); else a·n.
      const a = matchNumeral(x);
      if (a === null) return null;
      if (a === 0) return reapply(named("K"), args, 2);
      const b = matchNumeral(y);
      if (b === null || a * b > MAX_NAT) return null;
      return reapply(natTree(a * b), args, 2);
    }
    case "(-)": {
      // (-) m Z = m (pure monus recurses on the second operand; Z stops without forcing m).
      const b = matchNumeral(y);
      if (b === null) return null;
      if (b === 0) return reapply(x, args, 2);
      const a = matchNumeral(x);
      if (a === null) return null;
      return reapply(natTree(Math.max(0, a - b)), args, 2);
    }
    default: {
      const op = CMP[sym];
      const a = matchNumeral(x);
      if (a === null) return null;
      const b = matchNumeral(y);
      if (b === null) return null;
      return reapply(op(a, b), args, 2);
    }
  }
}

function listOp(sym: string, args: Node[]): Node | null {
  switch (sym) {
    case "<>": {
      // [] <> ys = ys; (h:t) <> ys = h : (t <> ys). Force only the left list; ys stays raw.
      if (args.length < 2) return null;
      const xs = matchList(args[0]);
      if (xs === null) return null;
      return reapply(consTree(xs, args[1]), args, 2);
    }
    case "map": {
      // map f [] = []; map f (h:t) = f h : map f t. Force the list (args[1]); f stays raw.
      if (args.length < 2) return null;
      const xs = matchList(args[1]);
      if (xs === null) return null;
      const f = args[0];
      return reapply(consTree(xs.map((h) => app(f, h)), named("K")), args, 2);
    }
    case "concat": {
      // concat [] = []; concat (xs:xss) = xs <> concat xss — force the outer list and each element.
      const xss = matchList(args[0]);
      if (xss === null) return null;
      const flat: Node[] = [];
      for (const xs of xss) {
        const heads = matchList(xs);
        if (heads === null) return null;
        flat.push(...heads);
      }
      return reapply(consTree(flat, named("K")), args, 1);
    }
  }
  return null;
}

function boolOp(sym: string, args: Node[]): Node | null {
  switch (sym) {
    case "not": {
      const b = matchBool(args[0]);
      if (b === null) return null;
      return reapply(boolTree(!b), args, 1);
    }
    case "and": {
      // and p q = if p then q else False — force p first; if False, don't force q.
      if (args.length < 2) return null;
      const p = matchBool(args[0]);
      if (p === null) return null;
      if (!p) return reapply(boolTree(false), args, 2);
      const q = matchBool(args[1]);
      if (q === null) return null;
      return reapply(boolTree(q), args, 2);
    }
    case "or": {
      // or p q = if p then True else q — force p first; if True, don't force q.
      if (args.length < 2) return null;
      const p = matchBool(args[0]);
      if (p === null) return null;
      if (p) return reapply(boolTree(true), args, 2);
      const q = matchBool(args[1]);
      if (q === null) return null;
      return reapply(boolTree(q), args, 2);
    }
  }
  return null;
}
