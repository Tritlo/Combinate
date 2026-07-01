/**
 * Shared goal predicates over a built tree — "does it behave as combinator X /
 * reduce to value V / map these inputs to those outputs?" — used by the Golf
 * challenges (the Quest has its own goal predicate, skiq/engine.ts's makeGoal).
 * The behavioural probe + the Scott value matchers, in one place (pure; no
 * DOM/Pixi).
 */
import { type Node, app } from "./term";
import { probe } from "./probe";
import { CATALOG, named, type Law } from "./catalog";
import { evalShared } from "./graph";
import { matchNumeral, matchList, matchBool } from "./value";
import { natTree } from "./native";

const LAW_BY_SYM = new Map(CATALOG.map((l) => [l.sym, l] as const));

/** Goal: the tree behaves as the named combinator (behavioural probe). */
export function behavesAs(sym: string): (n: Node) => boolean {
  const law = LAW_BY_SYM.get(sym) as Law;
  return (n) => probe(n, law);
}

/** Goal: the tree reduces to the Scott numeral `k`. */
export const reducesToNumeral = (k: number) => (n: Node): boolean => matchNumeral(n) === k;
/** Goal: the tree reduces to the Scott boolean `b`. */
export const reducesToBool = (b: boolean) => (n: Node): boolean => matchBool(n) === b;
/** Goal: the tree reduces to the list of Scott numerals `nums`. */
export const reducesToList = (nums: number[]) => (n: Node): boolean => {
  const heads = matchList(n);
  return !!heads && heads.length === nums.length && heads.every((h, i) => matchNumeral(h) === nums[i]);
};

// ---- function goals: apply the built tree to concrete Scott inputs (Z/nil/False
// = K, Succ = S, cons, True = A) and read the output. Several cases pin behaviour
// so you can't hard-code one answer. ----
const FN_BUDGET = 120_000; // bounds a real computation (a compact sort needs ~1.3k steps)
/** The Scott Peano numeral `Succ^k Z` (Z = K) — re-exported under the golf/quest name. */
export const nat = natTree;
export const nil = (): Node => named("K");
export const list = (ks: number[]): Node => ks.reduceRight<Node>((acc, k) => app(app(named("cons"), nat(k)), acc), nil());
export const tru = (): Node => named("A");
export const fls = (): Node => named("K");

export const outNat = (k: number) => (nf: Node): boolean => matchNumeral(nf) === k;
export const outBool = (b: boolean) => (nf: Node): boolean => matchBool(nf) === b;
export const outList = (ks: number[]) => (nf: Node): boolean => {
  const h = matchList(nf);
  return !!h && h.length === ks.length && h.every((x, i) => matchNumeral(x) === ks[i]);
};

/** Goal: applied to each case's inputs, the tree reduces to the wanted output.
 *  Reduced by the **graph** reducer (sharing) so recursive functions stay feasible;
 *  `FN_BUDGET` bounds it. */
export function fn(cases: Array<{ in: Node[]; out: (nf: Node) => boolean }>): (built: Node) => boolean {
  return (built) =>
    cases.every((c) => {
      const r = evalShared(c.in.reduce((acc, a) => app(acc, a), built), FN_BUDGET, true);
      return r.done && c.out(r.term);
    });
}
