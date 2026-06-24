import { type Node, app, comb, decode, freeVar } from "./term";

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
  /** Combinator symbol, e.g. "I", "K", "B" (Smullyan's bird names). */
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
   * built-in rules.
   */
  def?: () => Node;
}

// ---- SK building blocks (for the few hand-written defs below) ----
const S = (): Node => comb("S");
const K = (): Node => comb("K");
const I = (): Node => comb("I");
const B = (): Node => app(app(S(), app(K(), S())), K()); // S (K S) K
const C = (): Node => app(app(S(), app(app(S(), app(K(), B())), S())), app(K(), K()));
const M = (): Node => app(app(S(), I()), I()); // S I I = ω

// ---- bracket abstraction: compile a λ-body over named vars to a closed SKI term
// (the standard algorithm + η). Lets each bird's `def` be derived from its law,
// so it is correct by construction. ----
function occurs(name: string, n: Node): boolean {
  switch (n.kind) {
    case "free":
      return n.name === name;
    case "app":
      return occurs(name, n.fn) || occurs(name, n.arg);
    default:
      return false;
  }
}
function bracket(name: string, t: Node): Node {
  if (t.kind === "free" && t.name === name) return I(); // [x] x = I
  if (!occurs(name, t)) return app(K(), t); // [x] t = K t   (x ∉ t)
  const a = t as Extract<Node, { kind: "app" }>;
  if (a.arg.kind === "free" && a.arg.name === name && !occurs(name, a.fn)) return a.fn; // η
  return app(app(S(), bracket(name, a.fn)), bracket(name, a.arg)); // [x](M N) = S [x]M [x]N
}
const VARS = ["x", "y", "z", "w", "v", "u"];
function lam(arity: number, body: (v: Node[]) => Node): Node {
  const names = VARS.slice(0, arity);
  let t = body(names.map(freeVar));
  for (let i = names.length - 1; i >= 0; i--) t = bracket(names[i], t);
  return t;
}

/** A bird whose def is the bracket abstraction of its law (so def ≡ law). */
function bird(sym: string, lawText: string, arity: number, body: (v: Node[]) => Node): Law {
  return { sym, lawText, arity, reference: body, def: () => lam(arity, body) };
}

export const CATALOG: Law[] = [
  // Primitive basis — I/K/S reduce by built-in rules (no def).
  { sym: "I", lawText: "I x = x", arity: 1, reference: (v) => v[0] },
  { sym: "K", lawText: "K x y = x", arity: 2, reference: (v) => v[0] },
  { sym: "S", lawText: "S x y z = x z (y z)", arity: 3, reference: (v) => app(app(v[0], v[2]), app(v[1], v[2])) },

  // Two-argument birds.
  bird("KI", "KI x y = y", 2, (v) => v[1]), // Kite
  bird("M", "M x = x x", 1, (v) => app(v[0], v[0])), // Mockingbird (ω)
  bird("W", "W x y = x y y", 2, (v) => app(app(v[0], v[1]), v[1])), // Warbler
  bird("T", "T x y = y x", 2, (v) => app(v[1], v[0])), // Thrush
  bird("L", "L x y = x (y y)", 2, (v) => app(v[0], app(v[1], v[1]))), // Lark
  bird("O", "O x y = y (x y)", 2, (v) => app(v[1], app(v[0], v[1]))), // Owl
  bird("M2", "M2 x y = x y (x y)", 2, (v) => app(app(v[0], v[1]), app(v[0], v[1]))), // Double Mockingbird
  bird("U", "U x y = y (x x y)", 2, (v) => app(v[1], app(app(v[0], v[0]), v[1]))), // Turing
  bird("X", "X x y = x y x", 2, (v) => app(app(v[0], v[1]), v[0])), // logical AND (= S S K)

  // Three-argument birds.
  bird("B", "B x y z = x (y z)", 3, (v) => app(v[0], app(v[1], v[2]))), // Bluebird
  bird("C", "C x y z = x z y", 3, (v) => app(app(v[0], v[2]), v[1])), // Cardinal
  bird("V", "V x y z = z x y", 3, (v) => app(app(v[2], v[0]), v[1])), // Vireo (pairing)
  bird("R", "R x y z = y z x", 3, (v) => app(app(v[1], v[2]), v[0])), // Robin
  bird("F", "F x y z = z y x", 3, (v) => app(app(v[2], v[1]), v[0])), // Finch
  bird("Q", "Q x y z = y (x z)", 3, (v) => app(v[1], app(v[0], v[2]))), // Queer
  bird("Q1", "Q1 x y z = x (z y)", 3, (v) => app(v[0], app(v[2], v[1]))), // Quixotic
  bird("Q2", "Q2 x y z = y (z x)", 3, (v) => app(v[1], app(v[2], v[0]))), // Quizzical
  bird("Q3", "Q3 x y z = z (x y)", 3, (v) => app(v[2], app(v[0], v[1]))), // Quirky
  bird("Q4", "Q4 x y z = z (y x)", 3, (v) => app(v[2], app(v[1], v[0]))), // Quacky
  bird("H", "H x y z = x y z y", 3, (v) => app(app(app(v[0], v[1]), v[2]), v[1])), // Hummingbird

  // Four/five-argument composites.
  bird("D", "D x y z w = x y (z w)", 4, (v) => app(app(v[0], v[1]), app(v[2], v[3]))), // Dove
  bird("B1", "B1 x y z w = x (y z w)", 4, (v) => app(v[0], app(app(v[1], v[2]), v[3]))), // Blackbird
  bird("B3", "B3 x y z w = x (y (z w))", 4, (v) => app(v[0], app(v[1], app(v[2], v[3])))), // Becard
  bird("G", "G x y z w = x w (y z)", 4, (v) => app(app(v[0], v[3]), app(v[1], v[2]))), // Goldfinch
  bird("Φ", "Φ x y z w = x (y w) (z w)", 4, (v) => app(app(v[0], app(v[1], v[3])), app(v[2], v[3]))), // Phoenix
  bird("Ψ", "Ψ x y z w = x (y z) (y w)", 4, (v) => app(app(v[0], app(v[1], v[2])), app(v[1], v[3]))), // Psi
  bird("E", "E x y z w v = x y (z w v)", 5, (v) => app(app(v[0], v[1]), app(app(v[2], v[3]), v[4]))), // Eagle
  bird("B2", "B2 x y z w v = x (y z w v)", 5, (v) => app(v[0], app(app(app(v[1], v[2]), v[3]), v[4]))), // Bunting

  // Argument-shuffling / strictness helpers (definable from the birds above; Z = B K).
  bird("Z", "Z x y z = x y", 3, (v) => app(v[0], v[1])), // drops its 3rd arg
  bird("J", "J x y z = z x", 3, (v) => app(v[2], v[0])),
  bird("BZT", "BZT x y z = y x", 3, (v) => app(v[1], v[0])), // = B Z T
  bird("BZV", "BZV x y z w = w x y", 4, (v) => app(app(v[3], v[0]), v[1])), // = B Z V

  // The fixpoint (Sage Θ — kept as Y). Recursive law, so probed finitely.
  {
    sym: "Y",
    lawText: "Y f = f (Y f)",
    arity: 1,
    args: (v) => [app(K(), v[0])], // Y (K a) ≡ a — finite, since Y a diverges
    reference: (v) => v[0],
    def: () => app(app(B(), M()), app(app(C(), B()), M())), // B M (C B M)
  },
];

/** Zoo (Pokédex) metadata for a combinator: its Smullyan bird name (if any), a
 *  short description of what it does, and the formula it's built from. */
export interface Meta {
  bird?: string;
  blurb: string;
  recipe: string;
}

export const META: Record<string, Meta> = {
  ι: { blurb: "The universal combinator — everything here is built from ι alone. ι x = x S K.", recipe: "primitive" },
  I: { bird: "Identity (Idiot Bird)", blurb: "Returns its argument unchanged.", recipe: "ι ι" },
  K: { bird: "Kestrel", blurb: "Keeps the first argument, drops the second. Doubles as Boolean true and a pair's first projection (fst).", recipe: "primitive" },
  S: { bird: "Starling", blurb: "The substitution combinator: shares an argument between two functions. With K it builds everything.", recipe: "primitive" },
  KI: { bird: "Kite", blurb: "Keeps the second argument. Doubles as Boolean false, the Church numeral 0, and a pair's second projection (snd).", recipe: "K I" },
  M: { bird: "Mockingbird", blurb: "Self-application: M x = x x — the spark of recursion (M M loops forever). On Booleans it's logical OR: M p q = p p q.", recipe: "S I I" },
  W: { bird: "Warbler", blurb: "Duplicates an argument: W x y = x y y.", recipe: "S S (K I)" },
  T: { bird: "Thrush", blurb: "Reverse application: T x y = y x. Hands its first argument to its second.", recipe: "C I" },
  L: { bird: "Lark", blurb: "L x y = x (y y). A stepping stone toward fixpoint combinators.", recipe: "C B M" },
  O: { bird: "Owl", blurb: "O x y = y (x y). Kin to the Sage — close to a fixpoint.", recipe: "S I" },
  M2: { bird: "Double Mockingbird", blurb: "M2 x y = x y (x y): applies the compound (x y) to itself.", recipe: "B M" },
  U: { bird: "Turing", blurb: "U x y = y (x x y). U U is a fixpoint combinator (Turing's Θ).", recipe: "λx y. y (x x y)" },
  X: { blurb: "Logical AND on Church Booleans: X p q = p q p — true only if both are true.", recipe: "S S K" },
  B: { bird: "Bluebird", blurb: "Function composition: B f g x = f (g x) = (f ∘ g).", recipe: "S (K S) K" },
  C: { bird: "Cardinal", blurb: "Flip: swaps the next two arguments, C f x y = f y x. On Booleans it's logical NOT.", recipe: "S (S (K B) S) (K K)" },
  V: { bird: "Vireo", blurb: "Pairing — and the list constructor (cons): V x y f = f x y. Recover the parts with K (fst) and KI (snd); a list is just nested pairs.", recipe: "B C (C I)" },
  R: { bird: "Robin", blurb: "Rotates three arguments left: R x y z = y z x.", recipe: "C C" },
  F: { bird: "Finch", blurb: "Reverses three arguments: F x y z = z y x.", recipe: "C V" },
  Q: { bird: "Queer", blurb: "Composition in diagrammatic order: Q x y z = y (x z).", recipe: "C B" },
  Q1: { bird: "Quixotic", blurb: "Q1 x y z = x (z y).", recipe: "B (C B T) B" },
  Q2: { bird: "Quizzical", blurb: "Q2 x y z = y (z x).", recipe: "B (C B) T" },
  Q3: { bird: "Quirky", blurb: "Q3 x y z = z (x y).", recipe: "B T" },
  Q4: { bird: "Quacky", blurb: "Q4 x y z = z (y x).", recipe: "C (B T)" },
  H: { bird: "Hummingbird", blurb: "Duplicates the middle argument: H x y z = x y z y.", recipe: "B W (B C)" },
  D: { bird: "Dove", blurb: "Composition one level in: D x y z w = x y (z w).", recipe: "B B" },
  B1: { bird: "Blackbird", blurb: "Composes a binary function after a ternary one: B1 x y z w = x (y z w).", recipe: "B B B" },
  B3: { bird: "Becard", blurb: "B3 x y z w = x (y (z w)).", recipe: "B (B B) B" },
  G: { bird: "Goldfinch", blurb: "G x y z w = x w (y z).", recipe: "B B C" },
  "Φ": { bird: "Phoenix", blurb: "Feeds a shared argument to two functions: Φ x y z w = x (y w) (z w).", recipe: "B (B S) B" },
  "Ψ": { bird: "Psi", blurb: "Applies y to both z and w: Ψ x y z w = x (y z) (y w).", recipe: "λx y z w. x (y z) (y w)" },
  E: { bird: "Eagle", blurb: "E x y z w v = x y (z w v).", recipe: "B (B B B)" },
  B2: { bird: "Bunting", blurb: "B2 x y z w v = x (y z w v).", recipe: "B B (B B B)" },
  Z: { blurb: "Drops its third argument: Z x y z = x y. A strictness / sequencing helper.", recipe: "B K" },
  J: { blurb: "J x y z = z x. A bracket-abstraction helper.", recipe: "B K T" },
  BZT: { blurb: "BZT x y z = y x — the Thrush padded with a dropped argument.", recipe: "B Z T" },
  BZV: { blurb: "BZV x y z w = w x y — the Vireo padded with a dropped argument.", recipe: "B Z V" },
  Y: { bird: "Sage", blurb: "The fixpoint combinator: Y f = f (Y f). The source of recursion.", recipe: "B M (C B M)" },
};

/** Expand an SK(I) tree into a pure-ι tree (the skToIota gadget, §7.3):
 *  S/K/I leaves become their ι-trees, application stays application. */
export function skToIota(n: Node): Node {
  switch (n.kind) {
    case "comb":
      return IOTA_CODE[n.sym] ? decode(IOTA_CODE[n.sym]) : n;
    case "app":
      return app(skToIota(n.fn), skToIota(n.arg));
    default:
      return n;
  }
}

/** The pure-ι tree for a law (its picture): I/K/S use their canonical code, the
 *  rest expand their SK definition. */
export function iotaTreeOf(law: Law): Node {
  return IOTA_CODE[law.sym] ? decode(IOTA_CODE[law.sym]) : skToIota(law.def!());
}

/** Count the ι leaves in a term (the "number of iotas" stat). */
export function countIotas(n: Node): number {
  return n.kind === "app" ? countIotas(n.fn) + countIotas(n.arg) : n.kind === "iota" ? 1 : 0;
}
