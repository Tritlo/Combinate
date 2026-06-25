/**
 * Structural matchers for the **Scott** encodings (the encoding MicroHs compiles
 * data to — `EncodeData.hs`), recognising a normal form as a Peano numeral, list,
 * pair, or boolean by applying the term to fresh free-variable eliminators and
 * inspecting the result (the same behavioural trick as `probe.ts`). Pure (no
 * Pixi/DOM) and bounded.
 *
 * Scott data is a *case-on-itself*: a value applies the eliminator arm for its
 * own constructor, in declaration order. Unlike Church (Boehm–Berarducci) data it
 * carries no built-in fold, so the matchers **peel one constructor at a time**,
 * recursing on the raw predecessor/tail.
 *
 *   Nat   = Z | S Nat        Z = K (= λz s. z)      S p = λz s. s p
 *   []    = [] | (:) a [a]   [] = K (= λn c. n)     (h:t) = λn c. c h t
 *   Bool  = False | True     False = K              True = A (= K I)
 *   (a,b)                    (x,y) = λf. f x y      (Vireo — same as Church)
 *
 * These are *recognisers only* — no ambiguity policy. The reading policy (when a
 * bare `K` means `0` vs `[]` vs `false`, propagation, routing, rendering) lives in
 * `types.ts: read`, which is the single value reader the shell uses.
 */
import { type Node, app, freeVar } from "./term";
import { normalize } from "./reduce";

export const NORM_CAP = 4000; // per-probe reduction cap
const MAX_LIST = 64; // longest list we spell out
const MAX_NUM = 9999; // largest numeral we count to

const isVar = (n: Node, name: string): boolean => n.kind === "free" && n.name === name;
// Probe variable names unlikely to collide with anything in a closed term.
const V = (s: string): Node => freeVar(`§${s}`);

/** Scott Peano numeral: `Z = λz s. z`, `S p = λz s. s p`. Apply to fresh `z`, `s`
 *  and peel — `z` ends the count, `s p` adds one and recurses on the predecessor
 *  `p`. Returns the count `k` (0 allowed), or null if it isn't a numeral. */
export function matchNumeral(n: Node, cap = NORM_CAP): number | null {
  let cur = n;
  for (let k = 0; k <= MAX_NUM; k++) {
    const r = normalize(app(app(cur, V("z")), V("s")), cap);
    if (!r.done) return null;
    const t = r.term;
    if (isVar(t, "§z")) return k; // Z — end of the count
    if (t.kind === "app" && isVar(t.fn, "§s")) {
      cur = t.arg; // S p — peel to the predecessor
      continue;
    }
    return null;
  }
  return null; // longer than MAX_NUM
}

/** Scott list: `[] = λn c. n`, `(h:t) = λn c. c h t`. Apply to fresh `n`, `c` and
 *  peel — `n` ends the list, `c h t` yields a head and the raw tail. Returns the
 *  heads (possibly empty), or null if it isn't a list. */
export function matchList(n: Node, cap = NORM_CAP): Node[] | null {
  const heads: Node[] = [];
  let cur = n;
  for (let i = 0; i <= MAX_LIST; i++) {
    const r = normalize(app(app(cur, V("n")), V("c")), cap);
    if (!r.done) return null;
    const t = r.term;
    if (isVar(t, "§n")) return heads; // [] — end of the list
    // (h:t) = c h t  ⇒  ((§c h) t)
    if (t.kind === "app" && t.fn.kind === "app" && isVar(t.fn.fn, "§c")) {
      heads.push(t.fn.arg);
      cur = t.arg; // the raw Scott tail
      continue;
    }
    return null;
  }
  return null; // longer than MAX_LIST
}

/** Pair (Vireo) `(x, y) = λf. f x y`: the two components, or null. */
export function matchPair(n: Node, cap = NORM_CAP): [Node, Node] | null {
  const r = normalize(app(n, V("f")), cap);
  if (!r.done) return null;
  const t = r.term;
  if (t.kind === "app" && t.fn.kind === "app" && isVar(t.fn.fn, "§f")) return [t.fn.arg, t.arg];
  return null;
}

/** Scott boolean `False = K` (→ first arm), `True = A` (→ second arm): the value,
 *  or null. */
export function matchBool(n: Node, cap = NORM_CAP): boolean | null {
  const r = normalize(app(app(n, V("f")), V("t")), cap);
  if (!r.done) return null;
  if (isVar(r.term, "§f")) return false; // False = K selects the first arm
  if (isVar(r.term, "§t")) return true; // True  = A selects the second arm
  return null;
}
