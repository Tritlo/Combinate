/**
 * Structural matchers for the Church encodings: recognise a normal form as a
 * numeral, list, pair, or boolean by applying the term to fresh free-variable
 * eliminators and inspecting the result (the same behavioural trick as
 * `probe.ts`). Pure (no Pixi/DOM) and bounded.
 *
 * These are *recognisers only* — no ambiguity policy. The reading policy (when a
 * bare `A` means `0` vs `[]` vs `false`, propagation, routing, rendering) lives
 * in `types.ts: read`, which is the single value reader the shell uses.
 */
import { type Node, app, freeVar } from "./term";
import { normalize } from "./reduce";

export const NORM_CAP = 4000; // per-probe reduction cap
const MAX_LIST = 64; // longest list we spell out
const MAX_NUM = 9999; // largest numeral we count to

const isVar = (n: Node, name: string): boolean => n.kind === "free" && n.name === name;
// Probe variable names unlikely to collide with anything in a closed term.
const V = (s: string): Node => freeVar(`§${s}`);

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
