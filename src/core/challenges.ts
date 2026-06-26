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
import { type Node } from "./term";
import { probe } from "./probe";
import { CATALOG, IOTA_BITCODE, type Law } from "./catalog";
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
];

/** A challenge by id, or undefined. */
export const challengeById = (id: string): Challenge | undefined => CHALLENGES.find((c) => c.id === id);
