/**
 * Encoding-directed value reader (PLAN.md Phase 1): the inverse of the Church
 * encodings. Given a term, probe it as each known data shape — numeral, list,
 * pair, boolean — by applying it to fresh free variables and inspecting the
 * normal form (the same behavioural trick as `probe.ts`), and render a compact
 * value: `2`, `[a, b, c]`, `(x, y)`, `true`. Recurses on sub-values.
 *
 * Pure (no Pixi/DOM) and bounded. The structural part is split from the *policy*:
 * `matchNumeral`/`matchList`/`matchPair`/`matchBool` just recognise a shape (no
 * ambiguity rules), so the typing layer (`types.ts: readAs`) can force a reading
 * from a tag while `readValue` here applies the auto-discovery policy.
 *
 * That policy: the trivial values coincide with bare combinators — `0`/`[]`/
 * `false`/`nil` are all `A`, `1` is `I`, `true` is `K` — so at the top level they
 * defer to the combinator name; they read as values only when nested as data
 * (e.g. the `1`s in `[1, 1]`). `false`/`0`/`[]` (all `A`) stay ambiguous even
 * nested and are not read. Returns `null` when not a recognisable value, so the
 * caller can fall back to the combinator re-folder or the raw s-expression.
 */
import { type Node, app, freeVar } from "./term";
import { normalize } from "./reduce";

const MAX_DEPTH = 8; // nesting guard
export const NORM_CAP = 4000; // per-probe reduction cap
const MAX_LIST = 64; // longest list we spell out
const MAX_NUM = 9999; // largest numeral we count to

const isVar = (n: Node, name: string): boolean => n.kind === "free" && n.name === name;
// Probe variable names unlikely to collide with anything in a closed term.
const V = (s: string): Node => freeVar(`§${s}`);

// ---- structural matchers (no ambiguity policy) ----

/** Church numeral `n f x = fⁿ x`: the count `k` (0 allowed), or null if the NF
 *  isn't `fᵏ x`. */
export function matchNumeral(n: Node, cap = NORM_CAP): number | null {
  const r = normalize(app(app(n, V("f")), V("x")), cap);
  if (!r.done) return null;
  let cur = r.term;
  let k = 0;
  while (cur.kind === "app" && isVar(cur.fn, "§f")) {
    if (++k > MAX_NUM) return null;
    cur = cur.arg;
  }
  return isVar(cur, "§x") ? k : null;
}

/** Right-fold list `c h₁ (c h₂ (… n))`: the heads (possibly empty), or null if
 *  the NF isn't a cons spine ending in `n`. Each cons cell is `((c h) rest)`; a
 *  numeral's `c (c n)` applies `c` to ONE arg, so it never matches this two-arg
 *  spine. */
export function matchList(n: Node, cap = NORM_CAP): Node[] | null {
  const r = normalize(app(app(n, V("c")), V("n")), cap);
  if (!r.done) return null;
  const heads: Node[] = [];
  let cur = r.term;
  while (cur.kind === "app" && cur.fn.kind === "app" && isVar(cur.fn.fn, "§c")) {
    if (heads.push(cur.fn.arg) > MAX_LIST) return null;
    cur = cur.arg;
  }
  return isVar(cur, "§n") ? heads : null;
}

/** Pair (Vireo) `V x y f = f x y`: the two components, or null. */
export function matchPair(n: Node, cap = NORM_CAP): [Node, Node] | null {
  const r = normalize(app(n, V("f")), cap);
  if (!r.done) return null;
  const t = r.term;
  if (t.kind === "app" && t.fn.kind === "app" && isVar(t.fn.fn, "§f")) return [t.fn.arg, t.arg];
  return null;
}

/** Boolean `true = K` (→ first arg), `false = A` (→ second): the value, or null. */
export function matchBool(n: Node, cap = NORM_CAP): boolean | null {
  const r = normalize(app(app(n, V("a")), V("b")), cap);
  if (!r.done) return null;
  if (isVar(r.term, "§a")) return true;
  if (isVar(r.term, "§b")) return false;
  return null;
}

// ---- auto-discovery reader (matchers + deferral policy) ----

/** Render the heads of a matched list as `[v₁, …]`, each read as a nested value;
 *  null if any element isn't a clean value. */
function renderList(heads: Node[], depth: number): string | null {
  const parts: string[] = [];
  for (const h of heads) {
    const v = readValue(h, depth + 1);
    if (v === null) return null;
    parts.push(v);
  }
  return `[${parts.join(", ")}]`;
}

/**
 * Read a term as a compact value, or null if it is not recognisable data. Tries
 * the unambiguous non-trivial shapes first; trivial values (`0`/`1`/`[]`/`true`/
 * `false`) defer per the module policy. The shapes are mutually exclusive on a
 * normal form, so order affects only which probe runs first, not correctness.
 */
export function readValue(n: Node, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  // numeral — `0` always defers; `1` defers at the top level, reads when nested.
  const k = matchNumeral(n);
  if (k !== null && (k >= 2 || (k === 1 && depth > 0))) return String(k);
  // list — empty (`[]` = A) defers; a non-empty list is unambiguous.
  const heads = matchList(n);
  if (heads && heads.length > 0) {
    const s = renderList(heads, depth);
    if (s !== null) return s;
  }
  // pair — always unambiguous (two-arg `f x y`).
  const pair = matchPair(n);
  if (pair) {
    const vx = readValue(pair[0], depth + 1);
    const vy = readValue(pair[1], depth + 1);
    if (vx !== null && vy !== null) return `(${vx}, ${vy})`;
  }
  // boolean — only `true` (= K) and only nested; `false` (= A) stays ambiguous.
  if (depth > 0 && matchBool(n) === true) return "true";
  return null;
}

/** Render a matched list (forced reading) — exported for the typing layer so a
 *  tag can read `A` as `[]`. */
export function renderListForced(heads: Node[]): string | null {
  return renderList(heads, 0);
}
