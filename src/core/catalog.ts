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

// Alphabetical by symbol. I/K/S reduce by built-in rules (no def); Y is the
// recursive fixpoint (probed finitely); the rest derive their def from their law.
export const CATALOG: Law[] = [
  bird("B", "B x y z = x (y z)", 3, (v) => app(v[0], app(v[1], v[2]))), // Bluebird
  bird("B1", "B1 x y z w = x (y z w)", 4, (v) => app(v[0], app(app(v[1], v[2]), v[3]))), // Blackbird
  bird("B2", "B2 x y z w v = x (y z w v)", 5, (v) => app(v[0], app(app(app(v[1], v[2]), v[3]), v[4]))), // Bunting
  bird("B3", "B3 x y z w = x (y (z w))", 4, (v) => app(v[0], app(v[1], app(v[2], v[3])))), // Becard
  bird("C", "C x y z = x z y", 3, (v) => app(app(v[0], v[2]), v[1])), // Cardinal
  bird("D", "D x y z w = x y (z w)", 4, (v) => app(app(v[0], v[1]), app(v[2], v[3]))), // Dove
  bird("E", "E x y z w v = x y (z w v)", 5, (v) => app(app(v[0], v[1]), app(app(v[2], v[3]), v[4]))), // Eagle
  bird("F", "F x y z = z y x", 3, (v) => app(app(v[2], v[1]), v[0])), // Finch
  bird("G", "G x y z w = x w (y z)", 4, (v) => app(app(v[0], v[3]), app(v[1], v[2]))), // Goldfinch
  bird("H", "H x y z = x y z y", 3, (v) => app(app(app(v[0], v[1]), v[2]), v[1])), // Hummingbird
  { sym: "I", lawText: "I x = x", arity: 1, reference: (v) => v[0] }, // Identity
  bird("J", "J x y z = z x", 3, (v) => app(v[2], v[0])),
  { sym: "K", lawText: "K x y = x", arity: 2, reference: (v) => v[0] }, // Kestrel
  bird("KI", "KI x y = y", 2, (v) => v[1]), // Kite
  bird("L", "L x y = x (y y)", 2, (v) => app(v[0], app(v[1], v[1]))), // Lark
  bird("M", "M x = x x", 1, (v) => app(v[0], v[0])), // Mockingbird (ω)
  bird("M2", "M2 x y = x y (x y)", 2, (v) => app(app(v[0], v[1]), app(v[0], v[1]))), // Double Mockingbird
  bird("O", "O x y = y (x y)", 2, (v) => app(v[1], app(v[0], v[1]))), // Owl
  bird("Q", "Q x y z = y (x z)", 3, (v) => app(v[1], app(v[0], v[2]))), // Queer
  bird("Q1", "Q1 x y z = x (z y)", 3, (v) => app(v[0], app(v[2], v[1]))), // Quixotic
  bird("Q2", "Q2 x y z = y (z x)", 3, (v) => app(v[1], app(v[2], v[0]))), // Quizzical
  bird("Q3", "Q3 x y z = z (x y)", 3, (v) => app(v[2], app(v[0], v[1]))), // Quirky
  bird("Q4", "Q4 x y z = z (y x)", 3, (v) => app(v[2], app(v[1], v[0]))), // Quacky
  bird("R", "R x y z = y z x", 3, (v) => app(app(v[1], v[2]), v[0])), // Robin
  { sym: "S", lawText: "S x y z = x z (y z)", arity: 3, reference: (v) => app(app(v[0], v[2]), app(v[1], v[2])) }, // Starling
  bird("T", "T x y = y x", 2, (v) => app(v[1], v[0])), // Thrush
  bird("U", "U x y = y (x x y)", 2, (v) => app(v[1], app(app(v[0], v[0]), v[1]))), // Turing
  bird("V", "V x y z = z x y", 3, (v) => app(app(v[2], v[0]), v[1])), // Vireo (pairing)
  bird("W", "W x y = x y y", 2, (v) => app(app(v[0], v[1]), v[1])), // Warbler
  bird("X", "X x y = x y x", 2, (v) => app(app(v[0], v[1]), v[0])), // logical AND (= S S K)
  // Sage Θ — recursive, so probed as Y (K a) ≡ a (Y a diverges).
  {
    sym: "Y",
    lawText: "Y f = f (Y f)",
    arity: 1,
    args: (v) => [app(K(), v[0])],
    reference: (v) => v[0],
    def: () => app(app(B(), M()), app(app(C(), B()), M())), // B M (C B M)
  },
  bird("Z", "Z x y z = x y", 3, (v) => app(v[0], v[1])), // drops its 3rd arg (= B K)
  bird("Z2T", "Z2T x y z = y x", 3, (v) => app(v[1], v[0])), // = B Z T
  bird("Z2V", "Z2V x y z w = w x y", 4, (v) => app(app(v[3], v[0]), v[1])), // = B Z V
  bird("Φ", "Φ x y z w = x (y w) (z w)", 4, (v) => app(app(v[0], app(v[1], v[3])), app(v[2], v[3]))), // Phoenix
  bird("Ψ", "Ψ x y z w = x (y z) (y w)", 4, (v) => app(app(v[0], app(v[1], v[2])), app(v[1], v[3]))), // Psi
];

/** Zoo (Pokédex) metadata for a combinator: its Smullyan bird name (if any), a
 *  short description of what it does, and the formula it's built from. */
export interface Meta {
  bird?: string;
  blurb: string;
  recipe: string;
}

export const META: Record<string, Meta> = {
  ι: { blurb: "The universal combinator — every program here is built from ι alone.", recipe: "primitive" },
  B: { bird: "Bluebird", blurb: "Function composition: feeds the result of one function into another.", recipe: "S (K S) K" },
  B1: { bird: "Blackbird", blurb: "Composition that lets a one-argument function consume a three-argument result.", recipe: "B B B" },
  B2: { bird: "Bunting", blurb: "Composition that lets a one-argument function consume a four-argument result.", recipe: "B B (B B B)" },
  B3: { bird: "Becard", blurb: "Chains three functions in a row — a composition of compositions.", recipe: "B (B B) B" },
  C: { bird: "Cardinal", blurb: "Flips the order of the next two arguments. On Church Booleans it is logical NOT.", recipe: "S (S (K B) S) (K K)" },
  D: { bird: "Dove", blurb: "Composition reaching one level deeper, into the second argument of a binary function.", recipe: "B B" },
  E: { bird: "Eagle", blurb: "Composition for a binary function whose second argument is itself a three-way application.", recipe: "B (B B B)" },
  F: { bird: "Finch", blurb: "Reverses the order of three arguments.", recipe: "C V" },
  G: { bird: "Goldfinch", blurb: "A flip-and-compose: pairs the last argument with a composition of the middle two.", recipe: "B B C" },
  H: { bird: "Hummingbird", blurb: "Duplicates an argument inside a three-way application.", recipe: "B W (B C)" },
  I: { bird: "Identity (Idiot Bird)", blurb: "Returns its argument untouched — the do-nothing function.", recipe: "ι ι" },
  J: { blurb: "Applies its third argument to its first, ignoring the second.", recipe: "B K T" },
  K: { bird: "Kestrel", blurb: "Keeps its first argument, ignores the second. Doubles as Boolean true and a pair's first projection (fst).", recipe: "primitive" },
  KI: { bird: "Kite", blurb: "Keeps its second argument, ignores the first. Doubles as Boolean false, the number zero, and a pair's second projection (snd).", recipe: "K I" },
  L: { bird: "Lark", blurb: "Composes a function with self-application — a stepping stone toward fixpoints.", recipe: "C B M" },
  M: { bird: "Mockingbird", blurb: "Applies its argument to itself — the seed of recursion (and, fed itself, of endless looping). On Booleans it is logical OR.", recipe: "S I I" },
  M2: { bird: "Double Mockingbird", blurb: "Feeds an application back to itself — a two-argument Mockingbird.", recipe: "B M" },
  O: { bird: "Owl", blurb: "A near-fixpoint, feeding a value back through a function. A cousin of the Sage.", recipe: "S I" },
  Q: { bird: "Queer", blurb: "Composition the other way round: runs the first function, then the second.", recipe: "C B" },
  Q1: { bird: "Quixotic", blurb: "A reordered composition: runs the third argument on the second, then the first on that result.", recipe: "B (C B T) B" },
  Q2: { bird: "Quizzical", blurb: "A reordered composition: runs the third argument on the first, then the second on that result.", recipe: "B (C B) T" },
  Q3: { bird: "Quirky", blurb: "A reordered composition: runs the first argument on the second, then the third on that result.", recipe: "B T" },
  Q4: { bird: "Quacky", blurb: "A reordered composition: runs the second argument on the first, then the third on that result.", recipe: "C (B T)" },
  R: { bird: "Robin", blurb: "Rotates three arguments, sending the first to the back.", recipe: "C C" },
  S: { bird: "Starling", blurb: "The substitution combinator: shares one argument between two functions and applies the results. With K it can express any function.", recipe: "primitive" },
  T: { bird: "Thrush", blurb: "Reverse application — hands its first argument to its second.", recipe: "C I" },
  U: { bird: "Turing", blurb: "Self-application with a guard; applied to itself it becomes a fixpoint combinator — the root of recursion.", recipe: "λx y. y (x x y)" },
  V: { bird: "Vireo", blurb: "Bundles two values into a pair — and the cons cell of a list; recover the parts with K and KI, and a list is just nested pairs.", recipe: "B C (C I)" },
  W: { bird: "Warbler", blurb: "Hands the same argument to a function twice — a duplicator.", recipe: "S S (K I)" },
  X: { blurb: "Logical AND on Church Booleans — true only when both arguments are true.", recipe: "S S K" },
  Y: { bird: "Sage", blurb: "The fixpoint combinator — feeds a function its own output, which is what makes recursion possible.", recipe: "B M (C B M)" },
  Z: { blurb: "Applies a function to two arguments but discards a trailing third — a tool for controlling evaluation order.", recipe: "B K" },
  Z2T: { blurb: "Reverse application that also swallows an extra trailing argument (the Thrush, padded).", recipe: "B Z T" },
  Z2V: { blurb: "Pairs its first two values, ignoring an extra argument before the continuation (the Vireo, padded).", recipe: "B Z V" },
  "Φ": { bird: "Phoenix", blurb: "Feeds a shared argument to two functions, then merges their results with a third.", recipe: "B (B S) B" },
  "Ψ": { bird: "Psi", blurb: "Applies one function to two different arguments, then combines the two results.", recipe: "λx y z w. x (y z) (y w)" },
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
