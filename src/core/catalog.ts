import { type Node, app, comb, decode } from "./term";

/**
 * A discoverable combinator law (§7.2). Data only — the probe (probe.ts) tests a
 * term against it behaviourally, and the shell turns a match into a toast +
 * hotbar slot, collapsing the recognised tree into a single named node.
 */
export interface Law {
  /** Combinator symbol, e.g. "I", "K", "B". */
  sym: string;
  /** Display text, reused verbatim in the toast and notebook. */
  lawText: string;
  /** Number of fresh free variables to apply when probing. */
  arity: number;
  /** Arguments to apply (default: the fresh vars). Override for non-terminating
   *  combinators, e.g. Y is probed as `Y (K a)` so the test is finite. */
  args?: (vars: Node[]) => Node[];
  /** Reference normal form, built from those free variables. */
  reference: (vars: Node[]) => Node;
  /**
   * The underlying tree a collapsed named node stands for, so the reducer can
   * unfold it when applied. Omitted for I/K/S, which the reducer handles with
   * built-in rules; present for combinators that have no rule.
   */
  def?: () => Node;
}

// SK building blocks for the zoo definitions (§7.3); fresh nodes each call so
// every node in a built tree has a unique id.
const S = (): Node => comb("S");
const K = (): Node => comb("K");
const I = (): Node => comb("I");
const B = (): Node => app(app(S(), app(K(), S())), K()); // S (K S) K
const C = (): Node => app(app(S(), app(app(S(), app(K(), B())), S())), app(K(), K())); // S (S (K B) S) (K K)
const SII = (): Node => app(app(S(), I()), I()); // ω = λx. x x
const PAIR = (): Node => app(app(B(), C()), app(C(), I())); // B C (C I)
// Turing bird U = λx y. y (x x y) = S (K (S I)) (S (S (K S) (S (K K) (S I I))) (K I))
const U = (): Node =>
  app(
    app(S(), app(K(), app(S(), I()))),
    app(app(S(), app(app(S(), app(K(), S())), app(app(S(), app(K(), K())), SII()))), app(K(), I())),
  );

export const CATALOG: Law[] = [
  // ι-cycle (§4): walk it by stacking ι. A/X carry their canonical ι-tree.
  { sym: "I", lawText: "I x = x", arity: 1, reference: (v) => v[0] },
  { sym: "A", lawText: "A x y = y", arity: 2, reference: (v) => v[1], def: () => decode("01011") },
  { sym: "K", lawText: "K x y = x", arity: 2, reference: (v) => v[0] },
  {
    sym: "S",
    lawText: "S x y z = x z (y z)",
    arity: 3,
    reference: (v) => app(app(v[0], v[2]), app(v[1], v[2])),
  },
  {
    sym: "X",
    lawText: "X x y = x y x",
    arity: 2,
    reference: (v) => app(app(v[0], v[1]), v[0]),
    def: () => decode("01010101011"),
  },
  // The SK zoo (§7.2): built from S and K.
  { sym: "B", lawText: "B x y z = x (y z)", arity: 3, reference: (v) => app(v[0], app(v[1], v[2])), def: B },
  { sym: "C", lawText: "C x y z = x z y", arity: 3, reference: (v) => app(app(v[0], v[2]), v[1]), def: C },
  { sym: "W", lawText: "W x y = x y y", arity: 2, reference: (v) => app(app(v[0], v[1]), v[1]), def: () => app(app(S(), S()), app(K(), I())) },
  // Recursion: the Turing bird U, and the fixpoint Y = U U.
  {
    sym: "U",
    lawText: "U x y = y (x x y)",
    arity: 2,
    reference: (v) => app(v[1], app(app(v[0], v[0]), v[1])),
    def: U,
  },
  {
    sym: "Y",
    lawText: "Y f = f (Y f)",
    arity: 1,
    args: (v) => [app(K(), v[0])], // Y (K a) ≡ a — finite, since Y a diverges
    reference: (v) => v[0],
    def: () => app(U(), U()),
  },
  // Data: a pair, and a Scott list cons.
  {
    sym: "P",
    lawText: "P x y f = f x y",
    arity: 3,
    reference: (v) => app(app(v[2], v[0]), v[1]),
    def: PAIR,
  },
  {
    sym: "O",
    lawText: "O h t c n = c h t",
    arity: 4,
    reference: (v) => app(app(v[2], v[0]), v[1]),
    def: () => app(app(B(), app(B(), app(B(), K()))), PAIR()), // B (B (B K)) P
  },
];
