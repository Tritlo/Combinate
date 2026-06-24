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
  bird("A", "A x y = y", 2, (v) => v[1]), // Albatross (= K I; the old Kite)
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
  bird("J", "J x y z w = x y (x w z)", 4, (v) => app(app(v[0], v[1]), app(app(v[0], v[3]), v[2]))), // Jay (canonical)
  { sym: "K", lawText: "K x y = x", arity: 2, reference: (v) => v[0] }, // Kestrel
  bird("L", "L x y = x (y y)", 2, (v) => app(v[0], app(v[1], v[1]))), // Lark
  bird("M", "M x = x x", 1, (v) => app(v[0], v[0])), // Mockingbird
  bird("M2", "M2 x y = x y (x y)", 2, (v) => app(app(v[0], v[1]), app(v[0], v[1]))), // Double Mockingbird
  bird("N", "N x y z = z x", 3, (v) => app(v[2], v[0])), // Nuthatch (small arg-shuffling helper)
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
  bird("X", "X x y = x y x", 2, (v) => app(app(v[0], v[1]), v[0])), // Xenops (logical AND, = S S K)
  // Sage Θ — recursive, so probed as Y (K a) ≡ a (Y a diverges).
  {
    sym: "Y",
    lawText: "Y f = f (Y f)",
    arity: 1,
    args: (v) => [app(K(), v[0])],
    reference: (v) => v[0],
    def: () => app(app(B(), M()), app(app(C(), B()), M())), // B M (C B M)
  },
  bird("Z", "Z x y z = x y", 3, (v) => app(v[0], v[1])), // Zebra Finch (drops its 3rd arg, = B K)
  bird("Z2", "Z2 x y z w = x y z", 4, (v) => app(app(v[0], v[1]), v[2])), // Zebra Dove (= B Z)
  bird("Φ", "Φ x y z w = x (y w) (z w)", 4, (v) => app(app(v[0], app(v[1], v[3])), app(v[2], v[3]))), // Phoenix
  bird("Ψ", "Ψ x y z w = x (y z) (y w)", 4, (v) => app(app(v[0], app(v[1], v[2])), app(v[1], v[3]))), // Psittacosaurus
];

/** Zoo (Pokédex) metadata for a combinator: its Smullyan bird name (if any), a
 *  short description of what it does, and the formula it's built from. */
export interface Meta {
  bird?: string;
  blurb: string;
  recipe: string;
}

export const META: Record<string, Meta> = {
  ι: { blurb: "The universal combinator: every other bird grows from it alone — hand it to itself and the Identity bird hatches, keep nesting and out come the Kestrel, then the Starling. Linguist Chris Barker coined it in 2001 and named it for iota, the smallest letter of the Greek alphabet — the smallest possible seed for the calculus.", recipe: "primitive" },
  A: { bird: "Albatross", blurb: "Always answers with its second argument, throwing the first away — the mirror of the Kestrel. That makes it Boolean false, the number zero, and a pair's second projection (snd). It is simply the Kestrel handed an Identity bird; here it takes the letter A and the Albatross.", recipe: "K I" },
  B: { bird: "Bluebird", blurb: "The forest's composition law: it feeds one function's result straight into another. Curry gave it the letter B — relettering Schönfinkel's original composition combinator — and the Bluebird heads a whole dynasty of composers: the Blackbird, Bunting and Becard all grow from it.", recipe: "S (K S) K" },
  B1: { bird: "Blackbird", blurb: "The Blackbird stretches the Bluebird's reach, composing a function after a three-argument one. Woven from three Bluebirds, it is one of a clutch of B-birds named for the composition family they belong to.", recipe: "B B B" },
  B2: { bird: "Bunting", blurb: "The Bunting reaches a step past the Blackbird, composing a function after a four-argument one. Like its kin it is pure Bluebird — another B-named rung on the composition ladder.", recipe: "B B (B B B)" },
  B3: { bird: "Becard", blurb: "The Becard chains functions in sequence, threading a value through three of them in turn. Another all-Bluebird composer, it takes its B for the family and the bird's own initial.", recipe: "B (B B) B" },
  C: { bird: "Cardinal", blurb: "The Cardinal flips its next two arguments; on Church Booleans that swap becomes logical NOT. Curry assigned the letter C, relettering Schönfinkel's interchange combinator, and matched it to the cardinal. The Thrush falls out when its first argument is the Identity.", recipe: "S (S (K B) S) (K K)" },
  D: { bird: "Dove", blurb: "The Dove is a Bluebird reaching one slot deeper, composing into a binary function's second argument. It is two Bluebirds stacked; the name is simply a D-bird for Curry's letter.", recipe: "B B" },
  E: { bird: "Eagle", blurb: "The Eagle stretches the Dove's pattern wider, onto a binary function whose second argument is a three-way application. Pure Bluebird inside — an E-bird for its letter.", recipe: "B (B B B)" },
  F: { bird: "Finch", blurb: "The Finch fully reverses three arguments, last-first. It is the Cardinal's flip laid over the pairing Vireo, read backwards — an F-bird for the conventional letter.", recipe: "C V" },
  G: { bird: "Goldfinch", blurb: "The Goldfinch sends its last argument straight through while routing the earlier ones via a second function — composition wedded to a swap, built from two Bluebirds and a Cardinal. A G-bird for the letter.", recipe: "B B C" },
  H: { bird: "Hummingbird", blurb: "The Hummingbird hands a function two arguments, then slips the first back in at the tail — a Warbler's knack for reuse wrapped in a Bluebird and a Cardinal. Smullyan named it to fit the letter H.", recipe: "B W (B C)" },
  I: { bird: "Identity (Idiot Bird)", blurb: "The do-nothing bird — it answers with exactly the bird it was handed. Its letter comes from Schönfinkel's Identitätsfunktion, one of the few names Curry left untouched. The Starling and Kestrel can rebuild it, so it survives only because it keeps things readable; here it hatches when ι hears itself.", recipe: "ι ι" },
  J: { bird: "Jay", blurb: "The Jay duplicates its first argument deep inside a four-way application, feeding it in twice while reshuffling the rest — a trick it owes to the Warbler and the Bluebird. Smullyan named it the Jay, a J-bird; this is the forest's canonical Jay.", recipe: "λx y z w. x y (x w z)" },
  K: { bird: "Kestrel", blurb: "The constant bird: it answers with its first argument and forgets the second, which makes it Boolean true and a pair's first projection (fst). Its letter is Schönfinkel's Konstanzfunktion (constant function); Smullyan matched it to the kestrel, beside the Starling.", recipe: "primitive" },
  L: { bird: "Lark", blurb: "The Lark composes a function with self-application — a Cardinal, Bluebird and Mockingbird in concert. Pair a Lark with an Identity bird and a Mockingbird hatches; fed to one another, Larks grow the fixpoint-making Sage. An L-bird for its letter.", recipe: "C B M" },
  M: { bird: "Mockingbird", blurb: "The forest's namesake, woven from a Starling and two Identity birds: it echoes its argument back, applied to itself. A mockingbird mimics other birds' songs — exactly what M does — so Smullyan gave it the title role. That self-application sparks recursion (and, fed itself, never settles); on Booleans it is logical OR.", recipe: "S I I" },
  M2: { bird: "Double Mockingbird", blurb: "A two-argument Mockingbird — a Bluebird perched on the original — that echoes a whole application back onto itself. Named the Double Mockingbird for doubling M's trick.", recipe: "B M" },
  N: { bird: "Nuthatch", blurb: "A small shuffler: it discards its middle argument and applies the last to the first. Built from a Bluebird, a Kestrel and a Thrush, the Kestrel doing the forgetting. Not a classical bird; it takes the free letter N and the Nuthatch.", recipe: "B K T" },
  O: { bird: "Owl", blurb: "The Owl feeds a value back through a function — a close relative of the Sage, made from a Starling and an Identity bird. Every fixpoint combinator is a fixed point of it, so stacking Owls walks the whole family of recursion-makers. An O-bird for the letter.", recipe: "S I" },
  Q: { bird: "Queer", blurb: "The Queer bird is composition with the order flipped from the Bluebird's: it runs the first function, then pours the result into the second. Built by laying a Cardinal over a Bluebird. 'Queer' for odd — a fitting Q-name for the patriarch of the Quixotic, Quizzical, Quirky and Quacky birds.", recipe: "C B" },
  Q1: { bird: "Quixotic", blurb: "One of the Queer bird's clan of reordered composers: it hands its second argument to the third, then runs the first over the result. Like its siblings it springs from the Queer bird; Smullyan gave each a playful Q-word — this one Quixotic.", recipe: "B (C B T) B" },
  Q2: { bird: "Quizzical", blurb: "A Queer-family composer that lets the second function have the last say, applied to the first argument fed through the third. Another of the Queer bird's cousins, named Quizzical to keep the Q.", recipe: "B (C B) T" },
  Q3: { bird: "Quirky", blurb: "The leanest Queer cousin — little more than a Bluebird and a Thrush — it lets the third function close over a paired-up result. Named Quirky, one more playful Q-word in the family.", recipe: "B T" },
  Q4: { bird: "Quacky", blurb: "The last Queer cousin: hand it three things and the last runs on the second applied to the first. It is the Quirky bird with a Cardinal flipping that inner pair. Quacky rounds out the Q-words.", recipe: "C (B T)" },
  R: { bird: "Robin", blurb: "The Robin rotates three arguments, sending the first to the back — and its letter R conveniently reads as 'rotate'. It is just the Cardinal applied to itself, two swaps making a turn, and three Robins fold back into a single Cardinal. The robin is the matching R-bird.", recipe: "C C" },
  S: { bird: "Starling", blurb: "The substitution bird: it hands one argument to two birds, then feeds the first's answer the second's. The letter is Schönfinkel's own — folklore even hears the S as a nod to Schönfinkel himself. Paired with the Kestrel it can conjure every other bird; Smullyan matched it to the starling.", recipe: "primitive" },
  T: { bird: "Thrush", blurb: "The Thrush is reverse application — it hands its first argument to its second. A stripped-down Cardinal, it is that swapping bird fed an Identity. The letter T traces to Schönfinkel's interchange function (which Curry later renamed C); Smullyan reuses T for the thrush, and it underpins the pairing Vireo.", recipe: "C I" },
  U: { bird: "Turing", blurb: "Hand this bird to itself and it becomes a fixpoint combinator — a wellspring of recursion beside the Sage. Alan Turing described it in a one-page 1937 note, and Smullyan named it the Turing bird in his honour: a rare combinator named for a person, not a letter-matching species. Unlike Curry's Y it reduces straight onward into its own unfolding.", recipe: "λx y. y (x x y)" },
  V: { bird: "Vireo", blurb: "The Vireo bundles two values and, given a head and tail, serves as a list's cons cell — the trick to encoding data among pure functions. Pull the parts back with the Kestrel (first) and the Albatross (second). Woven from a Bluebird, Cardinal and Thrush; a V-bird for the letter.", recipe: "B C (C I)" },
  W: { bird: "Warbler", blurb: "The Warbler hands the same argument to a function twice — a duplicator. It is one of the four primitives of Curry's BCKW basis, where it plays the role of contraction, reusing an argument rather than spending it. The warbler is Curry's W-bird.", recipe: "S S (K I)" },
  X: { bird: "Xenops", blurb: "Logical AND on Church Booleans — it answers true only when both arguments are true, and is built from a pair of Starlings and a Kestrel. X is no classical combinator letter, so it borrows the Xenops, one of the very few birds whose name begins with X.", recipe: "S S K" },
  Y: { bird: "Sage", blurb: "The sage bird of the forest: hand it any bird and it returns one that bird is fond of — a fixed point of itself — which is what lets the forest recurse. Curry called it the paradoxical combinator and wrote it Y; Smullyan's 'Sage' captures the wisdom of always knowing a bird's fixed point. Grown from Mockingbirds and Bluebirds.", recipe: "B M (C B M)" },
  Z: { bird: "Zebra Finch", blurb: "Hands a function two arguments, then quietly swallows a trailing third — a tidy way to ignore an argument. It is a Bluebird perched on a Kestrel, the Kestrel doing the discarding. The letter Z was Schönfinkel's old mark for composition; here it takes a Zebra Finch for its name.", recipe: "B K" },
  Z2: { bird: "Zebra Dove", blurb: "Z reaching one rung deeper: it applies a function to its next two arguments and lets a trailing fourth fall away. Built by composing a Bluebird onto Z. Named the Zebra Dove — a Z-bird, and a Dove nodding to the Bluebird composition inside it.", recipe: "B Z" },
  "Φ": { bird: "Phoenix", blurb: "The Phoenix hands one shared argument to two different functions, then merges their results with a third — the fork-and-join cousin of the Starling, and Haskell's liftA2. Φ is the Greek letter 'Phi', so the Phoenix, a Ph-bird, fits the symbol.", recipe: "B (B S) B" },
  "Ψ": { bird: "Psittacosaurus", blurb: "The Psi bird applies one function to two separate arguments, then feeds the results to a second that combines them — functional programmers' `on` operator. No bird's name begins with the Greek Ψ, so it borrows a dinosaur: Psittacosaurus, the 'parrot lizard'.", recipe: "λx y z w. x (y z) (y w)" },
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
