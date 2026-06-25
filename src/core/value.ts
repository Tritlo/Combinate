/**
 * Encoding-directed value reader (PLAN.md Phase 1): the inverse of the Church
 * encodings. Given a term, probe it as each known data shape — numeral, list,
 * pair, boolean — by applying it to fresh free variables and inspecting the
 * normal form (the same behavioural trick as `probe.ts`), and render a compact
 * value: `2`, `[a, b, c]`, `(x, y)`, `true`. Recurses on sub-values.
 *
 * Pure (no Pixi/DOM) and bounded. Returns `null` when the term is not a
 * recognisable value, so the caller can fall back to the combinator re-folder or
 * the raw s-expression. The trivial values coincide with bare combinators — `0`/
 * `[]`/`false`/`nil` are all `A`, `1` is `I`, `true` is `K` — so at the top level
 * they defer to the combinator name; they read as values only when nested as
 * data (e.g. the `1`s in `[1, 1]`). `false`/`0`/`[]` (all `A`) stay ambiguous
 * even nested and are not read.
 */
import { type Node, app, freeVar } from "./term";
import { normalize } from "./reduce";

const MAX_DEPTH = 8; // nesting guard
const NORM_CAP = 4000; // per-probe reduction cap
const MAX_LIST = 64; // longest list we spell out
const MAX_NUM = 9999; // largest numeral we count to

const isVar = (n: Node, name: string): boolean => n.kind === "free" && n.name === name;
// Probe variable names unlikely to collide with anything in a closed term.
const V = (s: string): Node => freeVar(`§${s}`);

/** Church numeral: `n f x = fⁿ x`. Returns the count, or null. `0` (= A) and
 *  `1` (= I) coincide with bare combinators, so — like booleans — they read as
 *  numerals only when nested (`depth > 0`); `2`+ are unambiguous. */
function readNumeral(n: Node, depth: number): string | null {
  const r = normalize(app(app(n, V("f")), V("x")), NORM_CAP);
  if (!r.done) return null;
  let cur = r.term;
  let k = 0;
  while (cur.kind === "app" && isVar(cur.fn, "§f")) {
    if (++k > MAX_NUM) return null;
    cur = cur.arg;
  }
  if (!isVar(cur, "§x")) return null;
  return k >= 2 || (k === 1 && depth > 0) ? String(k) : null; // 0 always defers; 1 defers at top
}

/** Non-empty right-fold list `c h₁ (c h₂ (… n))`. Empty (NF = n) defers. */
function readList(n: Node, depth: number): string | null {
  const r = normalize(app(app(n, V("c")), V("n")), NORM_CAP);
  if (!r.done) return null;
  const heads: Node[] = [];
  let cur = r.term;
  // each cons cell is ((c h) rest); a numeral's `c (c n)` has c applied to ONE
  // arg, so it never matches this two-arg spine.
  while (cur.kind === "app" && cur.fn.kind === "app" && isVar(cur.fn.fn, "§c")) {
    if (heads.push(cur.fn.arg) > MAX_LIST) return null;
    cur = cur.arg;
  }
  if (heads.length === 0 || !isVar(cur, "§n")) return null;
  const parts: string[] = [];
  for (const h of heads) {
    const v = readValue(h, depth + 1);
    if (v === null) return null; // a non-value element → bail to the caller
    parts.push(v);
  }
  return `[${parts.join(", ")}]`;
}

/** Pair (Vireo) `V x y f = f x y`: NF applied to one var is `f x y`. */
function readPair(n: Node, depth: number): string | null {
  const r = normalize(app(n, V("f")), NORM_CAP);
  if (!r.done) return null;
  const t = r.term;
  if (t.kind === "app" && t.fn.kind === "app" && isVar(t.fn.fn, "§f")) {
    const vx = readValue(t.fn.arg, depth + 1);
    const vy = readValue(t.arg, depth + 1);
    return vx !== null && vy !== null ? `(${vx}, ${vy})` : null;
  }
  return null;
}

/** Boolean: only `true` (= K) is unambiguous; `false` (= A) shares the bare-A
 *  ambiguity and defers. Read in nested position only, so a bare top-level K
 *  still shows as the combinator rather than surprising as `true`. */
function readBool(n: Node): string | null {
  const r = normalize(app(app(n, V("a")), V("b")), NORM_CAP);
  return r.done && isVar(r.term, "§a") ? "true" : null;
}

/**
 * Read a term as a compact value, or null if it is not recognisable data. Tries
 * the unambiguous non-trivial shapes first; booleans only when nested
 * (`depth > 0`). The shapes are mutually exclusive on a normal form, so order
 * affects only which probe runs first, not correctness.
 */
export function readValue(n: Node, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  return readNumeral(n, depth) ?? readList(n, depth) ?? readPair(n, depth) ?? (depth > 0 ? readBool(n) : null);
}
