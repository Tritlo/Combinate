/**
 * Golf challenges (ADR 0005): a data-driven set of goals, each with a *target*
 * (a behavioural predicate over a built tree) and a *metric* (lower is better).
 * Pure — no Pixi/DOM. A *solution* is a tree whose target predicate holds; its
 * score is `metric(tree)`. The shell evaluates a challenge when a tree settles at
 * normal form, records the best (Store.putBest), and shares/ranks it as a
 * permalink (verify-by-replay leaderboard).
 *
 * Targets reuse the existing machinery: the behavioural probe (`probe.ts`, "does
 * this tree act like combinator X?") and the Scott value reader (`value.ts`,
 * "does this reduce to the number/list/boolean N?"). The metric is the honest
 * ι-count: a named combinator is charged for its full ι-tree, so dragging a
 * discovered bird costs exactly what building it from ι would.
 */
import { type Node, app } from "./term";
import { probe } from "./probe";
import { CATALOG, IOTA_BITCODE, named, type Law } from "./catalog";
import { evalShared } from "./graph";
import { matchNumeral, matchList, matchBool } from "./value";

const LAW_BY_SYM = new Map(CATALOG.map((l) => [l.sym, l] as const));

/** The honest golf cost of a built tree: total ι leaves, charging each named
 *  combinator for its full ι-tree (so a hotbar bird costs what it would to build
 *  from raw ι). Free variables and unknown atoms cost nothing. */
export function iotaCost(n: Node): number {
  switch (n.kind) {
    case "iota":
      return 1;
    case "comb": {
      const code = IOTA_BITCODE[n.sym];
      return code ? (code.match(/1/g)?.length ?? 0) : 0;
    }
    case "app":
      return iotaCost(n.fn) + iotaCost(n.arg);
    default:
      return 0; // free variable
  }
}

/** A golf challenge: a goal, a target predicate, and a (lower-is-better) metric. */
export interface Challenge {
  /** Stable id (the Store key + leaderboard key). */
  id: string;
  /** Short title, shown in the list. */
  title: string;
  /** One-line description of the target, shown in the detail pane. */
  goal: string;
  /** Does this built tree solve the challenge? Normalises internally as needed. */
  solved: (built: Node) => boolean;
  /** The score of a solving tree (lower is better). */
  metric: (built: Node) => number;
  /** Unit shown next to the metric (e.g. "ι"). */
  metricLabel: string;
}

/** Target: the tree behaves as the named combinator (via the behavioural probe). */
function behavesAs(sym: string): (n: Node) => boolean {
  const law = LAW_BY_SYM.get(sym) as Law;
  return (n) => probe(n, law);
}

/** Target: the tree reduces to the Scott numeral `k`. */
const reducesToNumeral = (k: number) => (n: Node): boolean => matchNumeral(n) === k;

/** Target: the tree reduces to the Scott boolean `b`. */
const reducesToBool = (b: boolean) => (n: Node): boolean => matchBool(n) === b;

/** Target: the tree reduces to the list of Scott numerals `nums`. */
const reducesToList = (nums: number[]) => (n: Node): boolean => {
  const heads = matchList(n);
  if (!heads || heads.length !== nums.length) return false;
  return heads.every((h, i) => matchNumeral(h) === nums[i]);
};

// ---- function challenges: apply the built tree to concrete Scott inputs and
// check its output. Inputs are built from the same catalog combinators value.ts
// matches (Z/nil/False = K, S = Succ, cons, True = A), and reduced in optimize
// (fast) mode so a real computation (even sort) finishes. Several cases pin the
// behaviour, so you can't hardcode one answer. ----
const FN_BUDGET = 120_000; // bounds a real computation (a compact sort needs ~1.3k steps); only run while the golf panel is open
const nat = (k: number): Node => {
  let t: Node = named("K");
  for (let i = 0; i < k; i++) t = app(named("Succ"), t);
  return t;
};
const nil = (): Node => named("K");
const list = (ks: number[]): Node => ks.reduceRight<Node>((acc, k) => app(app(named("cons"), nat(k)), acc), nil());
const tru = (): Node => named("A");
const fls = (): Node => named("K");

const outNat = (k: number) => (nf: Node): boolean => matchNumeral(nf) === k;
const outBool = (b: boolean) => (nf: Node): boolean => matchBool(nf) === b;
const outList = (ks: number[]) => (nf: Node): boolean => {
  const h = matchList(nf);
  return !!h && h.length === ks.length && h.every((x, i) => matchNumeral(x) === ks[i]);
};

/** Target: applied to each case's inputs, the tree reduces to the wanted output.
 *  Reduced by the **graph** reducer (call-by-need sharing) — recursive functions
 *  like sort would blow up the cloning tree reducer (as `fac` does); sharing keeps
 *  them feasible. The small output value is then read by the matchers. */
function fn(cases: Array<{ in: Node[]; out: (nf: Node) => boolean }>): (built: Node) => boolean {
  return (built) =>
    cases.every((c) => {
      const r = evalShared(c.in.reduce((acc, a) => app(acc, a), built), FN_BUDGET, true);
      return r.done && c.out(r.term);
    });
}

/** The starter challenge pack — all scored on fewest ι. */
export const CHALLENGES: Challenge[] = [
  { id: "i", title: "Identity", goal: "Build a tree that behaves as I  (I x = x).", solved: behavesAs("I"), metric: iotaCost, metricLabel: "ι" },
  { id: "k", title: "Kestrel", goal: "Build a tree that behaves as K  (K x y = x).", solved: behavesAs("K"), metric: iotaCost, metricLabel: "ι" },
  { id: "s", title: "Starling", goal: "Build a tree that behaves as S  (S x y z = x z (y z)).", solved: behavesAs("S"), metric: iotaCost, metricLabel: "ι" },
  { id: "m", title: "Mockingbird", goal: "Build a tree that behaves as M  (M x = x x).", solved: behavesAs("M"), metric: iotaCost, metricLabel: "ι" },
  { id: "t", title: "Thrush", goal: "Build a tree that behaves as T  (T x y = y x).", solved: behavesAs("T"), metric: iotaCost, metricLabel: "ι" },
  { id: "three", title: "The number 3", goal: "Build a tree that reduces to the Scott numeral 3.", solved: reducesToNumeral(3), metric: iotaCost, metricLabel: "ι" },
  { id: "true", title: "True", goal: "Build a tree that reduces to True.", solved: reducesToBool(true), metric: iotaCost, metricLabel: "ι" },
  { id: "list123", title: "The list [1, 2, 3]", goal: "Build a tree that reduces to the list [1, 2, 3].", solved: reducesToList([1, 2, 3]), metric: iotaCost, metricLabel: "ι" },

  // ---- intermediates: little functions on numbers, booleans, and lists ----
  { id: "not", title: "Not", goal: "Build not — flip a boolean  (not True = False).", solved: fn([{ in: [tru()], out: outBool(false) }, { in: [fls()], out: outBool(true) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "iszero", title: "Is zero?", goal: "Build isZero — True when a number is 0, else False.", solved: fn([{ in: [nat(0)], out: outBool(true) }, { in: [nat(3)], out: outBool(false) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "double", title: "Double", goal: "Build double n = n + n  (double 3 = 6).", solved: fn([{ in: [nat(3)], out: outNat(6) }, { in: [nat(0)], out: outNat(0) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "max", title: "Maximum", goal: "Build max m n — the larger of two numbers.", solved: fn([{ in: [nat(2), nat(5)], out: outNat(5) }, { in: [nat(7), nat(3)], out: outNat(7) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "reverse", title: "Reverse", goal: "Build reverse — flip a list end-to-end  ([1,2,3] → [3,2,1]).", solved: fn([{ in: [list([1, 2, 3])], out: outList([3, 2, 1]) }, { in: [nil()], out: outList([]) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "map1", title: "Map (+1)", goal: "Build map (+1) — add one to every element  ([1,2,3] → [2,3,4]).", solved: fn([{ in: [list([1, 2, 3])], out: outList([2, 3, 4]) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "append", title: "Append", goal: "Build append — join two lists  ([1,2] ++ [3,4] = [1,2,3,4]).", solved: fn([{ in: [list([1, 2]), list([3, 4])], out: outList([1, 2, 3, 4]) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "elem", title: "Member", goal: "Build elem k xs — True if k is in the list.", solved: fn([{ in: [nat(2), list([1, 2, 3])], out: outBool(true) }, { in: [nat(5), list([1, 2, 3])], out: outBool(false) }]), metric: iotaCost, metricLabel: "ι" },

  // ---- the hard pair ----
  { id: "sort", title: "Sort", goal: "Build sort — order a list ascending  ([3,1,2] → [1,2,3]).", solved: fn([{ in: [list([3, 1, 2])], out: outList([1, 2, 3]) }, { in: [list([2, 1])], out: outList([1, 2]) }]), metric: iotaCost, metricLabel: "ι" },
  { id: "bsearch", title: "Binary search", goal: "Search a SORTED list for a key — return its 0-based index.", solved: fn([{ in: [nat(1), list([1, 2, 3, 4, 5])], out: outNat(0) }, { in: [nat(3), list([1, 2, 3, 4, 5])], out: outNat(2) }, { in: [nat(5), list([1, 2, 3, 4, 5])], out: outNat(4) }]), metric: iotaCost, metricLabel: "ι" },
];

/** A challenge by id, or undefined. */
export const challengeById = (id: string): Challenge | undefined => CHALLENGES.find((c) => c.id === id);
