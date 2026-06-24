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
  /** Reference normal form, built from those free variables. */
  reference: (vars: Node[]) => Node;
  /**
   * The underlying tree a collapsed named node stands for, so the reducer can
   * unfold it when applied. Omitted for I/K/S, which the reducer handles with
   * built-in rules; present for combinators that have no rule (A, X, B, C, W).
   */
  def?: () => Node;
}

// SK building blocks for the zoo definitions (§7.3); fresh nodes each call.
const S = (): Node => comb("S");
const K = (): Node => comb("K");
const I = (): Node => comb("I");

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
  // The SK zoo (§7.2): built from S and K, so they carry their SK definitions.
  {
    sym: "B",
    lawText: "B x y z = x (y z)",
    arity: 3,
    reference: (v) => app(v[0], app(v[1], v[2])),
    // B = S (K S) K
    def: () => app(app(S(), app(K(), S())), K()),
  },
  {
    sym: "C",
    lawText: "C x y z = x z y",
    arity: 3,
    reference: (v) => app(app(v[0], v[2]), v[1]),
    // C = S (S (K (S (K S) K)) S) (K K)
    def: () =>
      app(
        app(S(), app(app(S(), app(K(), app(app(S(), app(K(), S())), K()))), S())),
        app(K(), K()),
      ),
  },
  {
    sym: "W",
    lawText: "W x y = x y y",
    arity: 2,
    reference: (v) => app(app(v[0], v[1]), v[1]),
    // W = S S (K I)
    def: () => app(app(S(), S()), app(K(), I())),
  },
];
