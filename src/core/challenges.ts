/**
 * Golf challenges (ADR 0005): a data-driven set of goals, each with a *target*
 * (a behavioural predicate over a built tree). Pure — no Pixi/DOM. A *solution*
 * is a tree whose target predicate holds; its score is {@link iotaCost} (lower is
 * better). The shell evaluates a challenge when a tree settles at normal form,
 * records the best (Store.putBest), and shares/ranks it as a permalink
 * (verify-by-replay leaderboard).
 *
 * Targets reuse the existing machinery: the behavioural probe (`probe.ts`, "does
 * this tree act like combinator X?") and the Scott value reader (`value.ts`,
 * "does this reduce to the number/list/boolean N?"). The metric is the honest
 * ι-count: a named combinator is charged for its full ι-tree, so dragging a
 * discovered bird costs exactly what building it from ι would.
 */
import { type Node } from "./term";
import { IOTA_BITCODE } from "./catalog";
import { behavesAs, reducesToNumeral, reducesToBool, reducesToList, fn, nat, nil, list, tru, fls, outNat, outBool, outList } from "./goals";

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

/** A golf challenge: a goal and a target predicate. Scored by {@link iotaCost} (ι),
 *  lower is better. */
export interface Challenge {
  /** Stable id (the Store key + leaderboard key). */
  id: string;
  /** Short title, shown in the list. */
  title: string;
  /** One-line description of the target, shown in the detail pane. */
  goal: string;
  /** Does this built tree solve the challenge? Normalises internally as needed. */
  solved: (built: Node) => boolean;
}

/** The starter challenge pack — all scored on fewest ι. The targets/inputs live in
 *  {@link import("./goals")} (shared with the Quest); golf charges every solve in ι. */
export const CHALLENGES: Challenge[] = [
  { id: "i", title: "Identity", goal: "Build a tree that behaves as I  (I x = x).", solved: behavesAs("I") },
  { id: "k", title: "Kestrel", goal: "Build a tree that behaves as K  (K x y = x).", solved: behavesAs("K") },
  { id: "s", title: "Starling", goal: "Build a tree that behaves as S  (S x y z = x z (y z)).", solved: behavesAs("S") },
  { id: "m", title: "Mockingbird", goal: "Build a tree that behaves as M  (M x = x x).", solved: behavesAs("M") },
  { id: "t", title: "Thrush", goal: "Build a tree that behaves as T  (T x y = y x).", solved: behavesAs("T") },
  { id: "three", title: "The number 3", goal: "Build a tree that reduces to the Scott numeral 3.", solved: reducesToNumeral(3) },
  { id: "true", title: "True", goal: "Build a tree that reduces to True.", solved: reducesToBool(true) },
  { id: "list123", title: "The list [1, 2, 3]", goal: "Build a tree that reduces to the list [1, 2, 3].", solved: reducesToList([1, 2, 3]) },

  // ---- intermediates: little functions on numbers, booleans, and lists ----
  { id: "not", title: "Not", goal: "Build not — flip a boolean  (not True = False).", solved: fn([{ in: [tru()], out: outBool(false) }, { in: [fls()], out: outBool(true) }]) },
  { id: "iszero", title: "Is zero?", goal: "Build isZero — True when a number is 0, else False.", solved: fn([{ in: [nat(0)], out: outBool(true) }, { in: [nat(3)], out: outBool(false) }]) },
  { id: "double", title: "Double", goal: "Build double n = n + n  (double 3 = 6).", solved: fn([{ in: [nat(3)], out: outNat(6) }, { in: [nat(0)], out: outNat(0) }]) },
  { id: "max", title: "Maximum", goal: "Build max m n — the larger of two numbers.", solved: fn([{ in: [nat(2), nat(5)], out: outNat(5) }, { in: [nat(7), nat(3)], out: outNat(7) }]) },
  { id: "reverse", title: "Reverse", goal: "Build reverse — flip a list end-to-end  ([1,2,3] → [3,2,1]).", solved: fn([{ in: [list([1, 2, 3])], out: outList([3, 2, 1]) }, { in: [nil()], out: outList([]) }]) },
  { id: "map1", title: "Map (+1)", goal: "Build map (+1) — add one to every element  ([1,2,3] → [2,3,4]).", solved: fn([{ in: [list([1, 2, 3])], out: outList([2, 3, 4]) }]) },
  { id: "append", title: "Append", goal: "Build append — join two lists  ([1,2] ++ [3,4] = [1,2,3,4]).", solved: fn([{ in: [list([1, 2]), list([3, 4])], out: outList([1, 2, 3, 4]) }]) },
  { id: "elem", title: "Member", goal: "Build elem k xs — True if k is in the list.", solved: fn([{ in: [nat(2), list([1, 2, 3])], out: outBool(true) }, { in: [nat(5), list([1, 2, 3])], out: outBool(false) }]) },

  // ---- the hard pair ----
  { id: "sort", title: "Sort", goal: "Build sort — order a list ascending  ([3,1,2] → [1,2,3]).", solved: fn([{ in: [list([3, 1, 2])], out: outList([1, 2, 3]) }, { in: [list([2, 1])], out: outList([1, 2]) }]) },
  { id: "bsearch", title: "Binary search", goal: "Search a SORTED list for a key — return its 0-based index.", solved: fn([{ in: [nat(1), list([1, 2, 3, 4, 5])], out: outNat(0) }, { in: [nat(3), list([1, 2, 3, 4, 5])], out: outNat(2) }, { in: [nat(5), list([1, 2, 3, 4, 5])], out: outNat(4) }]) },
];
