import { type Node, app, comb, decode } from "./term";

/**
 * Canonical ι-tree bit-codes (§4) for the combinators that can appear transient
 * during reduction. Used by the view to render an undiscovered S/K/I as its full
 * ι-tree (rather than a placeholder) until it's discovered.
 */
export const IOTA_CODE: Record<string, string> = {
  I: "011",
  K: "0101011",
  S: "010101011",
};

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
const M = (): Node => app(app(S(), I()), I()); // M (Mockingbird) = S I I = ω = λx. x x
const V = (): Node => app(app(B(), C()), app(C(), I())); // V (Vireo) = B C (C I), pairing

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
  // Recursion: the Mockingbird M (self-application), and the fixpoint Y from it.
  {
    sym: "M",
    lawText: "M x = x x",
    arity: 1,
    reference: (v) => app(v[0], v[0]),
    def: M, // M = S I I = ω
  },
  {
    sym: "Y",
    lawText: "Y f = f (Y f)",
    arity: 1,
    args: (v) => [app(K(), v[0])], // Y (K a) ≡ a — finite, since Y a diverges
    reference: (v) => v[0],
    // Y = B M (C B M)
    def: () => app(app(B(), M()), app(app(C(), B()), M())),
  },
  // Data: the Vireo V (pairing), and a Scott list cons.
  {
    sym: "V",
    lawText: "V x y z = z x y",
    arity: 3,
    reference: (v) => app(app(v[2], v[0]), v[1]),
    def: V,
  },
  {
    sym: "O",
    lawText: "O h t c n = c h t",
    arity: 4,
    reference: (v) => app(app(v[2], v[0]), v[1]),
    def: () => app(app(B(), app(B(), app(B(), K()))), V()), // B (B (B K)) V
  },
];
