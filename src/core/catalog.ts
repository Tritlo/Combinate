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
  bird("Z2", "Z2 x y z w = x y z", 4, (v) => app(app(v[0], v[1]), v[2])), // = B Z, drops its 4th arg
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
  ι: { blurb: "The universal combinator: every other bird in the forest can be grown from it alone. Hand it to itself and the do-nothing Identity bird hatches; keep nesting and out come the Kestrel, then the Starling. Linguist Chris Barker dreamed it up in 2001 as the smallest possible seed for the whole calculus.", recipe: "primitive" },
  B: { bird: "Bluebird", blurb: "The forest's composition law: it feeds the result of one function straight into another, the way functions chain in mathematics. One of Schoenfinkel's original 1920s combinators, the Bluebird anchors a whole dynasty of composers — the Blackbird, Bunting and Becard all grow from it.", recipe: "S (K S) K" },
  B1: { bird: "Blackbird", blurb: "The Blackbird is the Bluebird reaching one argument deeper: where the Bluebird feeds a plain function the result of a one-argument function, the Blackbird feeds it the result of a two-argument one. Built from three Bluebirds, it heads the family of deep composers alongside the Bunting and Becard.", recipe: "B B B" },
  B2: { bird: "Bunting", blurb: "The Bunting reaches one step past the Blackbird, composing a plain function after a three-argument one. Like the rest of its kin it is woven entirely from Bluebirds, each a thread of composition — another rung on the ladder of B-combinators that Smullyan's birds made famous.", recipe: "B B (B B B)" },
  B3: { bird: "Becard", blurb: "The Becard chains three functions back to back, a composition of compositions. Where the Blackbird stretches one function's reach across two arguments, the Becard nests three in sequence, threading a value through each in turn — and like its cousins it is assembled purely from Bluebirds.", recipe: "B (B B) B" },
  C: { bird: "Cardinal", blurb: "The Cardinal flips its next two arguments, handing them to the work in swapped order. Feed it Church Booleans and that swap becomes logical NOT, turning true into false and back again. One of Schönfinkel's original building blocks, it is the elementary permuter and kin to the other argument-shuffling birds, with the Thrush falling out when its first argument is the Identity.", recipe: "S (S (K B) S) (K K)" },
  D: { bird: "Dove", blurb: "The Dove is a Bluebird that reaches one slot deeper: it composes its last two arguments and feeds the result into a binary function's second slot, leaving the first argument untouched. It is simply two Bluebirds stacked, sitting one rung up the compositor family from B itself.", recipe: "B B" },
  E: { bird: "Eagle", blurb: "The Eagle reaches onto a binary function whose second argument is itself a three-way application — the Dove's pattern stretched one rung wider. Like the rest of its clan it is woven entirely from Bluebirds, a tidy nest of pure composition.", recipe: "B (B B B)" },
  F: { bird: "Finch", blurb: "The Finch fully reverses three arguments, handing them back last-first. It is the Cardinal's twist laid over the Vireo, the same wiring that builds a pair but read in reverse. Where the Robin and Vireo cycle their arguments around, the Finch simply swaps the outer two and leaves the middle fixed.", recipe: "C V" },
  G: { bird: "Goldfinch", blurb: "The Goldfinch feeds a two-argument function its final argument straight through, while routing the earlier argument in via a second function — Bluebird-style composition wedded to a Cardinal's argument-swap. Fittingly, it is assembled from two Bluebirds and a Cardinal, composition and permutation working in concert.", recipe: "B B C" },
  H: { bird: "Hummingbird", blurb: "The Hummingbird hands a function two arguments, then slips the first one back in at the tail end — a Warbler's instinct for reuse, with a Bluebird and a Cardinal wrapped around it to route the extra copy into place. Smullyan named it in To Mock a Mockingbird.", recipe: "B W (B C)" },
  I: { bird: "Identity (Idiot Bird)", blurb: "The do-nothing bird — it answers with exactly the bird it was handed. It is the one member of the founding trio you could throw away, since the Starling and Kestrel together already reproduce it; it survives only because it keeps things readable. In this forest it hatches the moment ι is made to hear itself.", recipe: "ι ι" },
  J: { blurb: "A shuffler that throws away its middle argument and applies the last one to the first. The Zoo builds it from a Bluebird, a Kestrel, and a Thrush — the Kestrel does the discarding, the Thrush the flip. Like the Kestrel, its forgetfulness comes from weakening, the logical move that lets an unused argument simply vanish.", recipe: "B K T" },
  K: { bird: "Kestrel", blurb: "The constant bird: it answers with its first argument and quietly forgets the second. That forgetfulness makes it Boolean true and a pair's first projection, so the Vireo's bundles are unwrapped by the Kestrel and its partner the Kite. Schönfinkel pared his logic down to just two primitives, and this one anchors the forest beside the Starling.", recipe: "primitive" },
  KI: { bird: "Kite", blurb: "Always answers with its second argument, throwing the first away — the mirror image of the Kestrel. That single habit makes it serve triple duty as Boolean false, the number zero, and a pair's second projection (snd). It is simply the Kestrel handed an Identity bird to hold.", recipe: "K I" },
  L: { bird: "Lark", blurb: "Composes a function with self-application — a Cardinal, Bluebird, and Mockingbird working in concert. The Lark is a seed of recursion: pair one with an Identity bird and a Mockingbird is sure to hatch, and Larks fed to one another are a classic way to grow the fixpoint-making Sage.", recipe: "C B M" },
  M: { bird: "Mockingbird", blurb: "The forest's namesake, woven from a Starling and a pair of Identity birds: it echoes its argument back, applied to itself. That self-application is the spark of recursion — and, handed to itself, the Mockingbird becomes an endless echo that never settles. On Church Booleans it stands in for logical OR.", recipe: "S I I" },
  M2: { bird: "Double Mockingbird", blurb: "A two-argument Mockingbird, no more than a Bluebird perched on the original: it applies its first input to its second, then echoes that result back onto itself. Where the Mockingbird doubles a single bird, the Double Mockingbird doubles a whole application.", recipe: "B M" },
  O: { bird: "Owl", blurb: "Feeds a value back through a function — a close cousin of the Sage, put together from a Starling and an Identity bird. Every fixpoint combinator turns out to be a fixed point of this little bird, so by appending an Owl to one recursion-maker after another you walk the whole infinite family of them.", recipe: "S I" },
  Q: { bird: "Queer", blurb: "The Queer bird is composition with the running order flipped from the Bluebird's: it applies the first function, then pours that result into the second. Build it by laying the Cardinal over the Bluebird, which swaps which function leads. As patriarch of the Quixotic, Quizzical, Quirky and Quacky birds, it heads a whole clan of reshuffled composers.", recipe: "C B" },
  Q1: { bird: "Quixotic", blurb: "The Quixotic bird belongs to the Queer clan of reordered composers: it hands its second argument to the third, then runs the first over whatever comes back. Like its relatives it springs from the Queer bird, the reverse-composition patriarch, each member differing only in how the three arguments are threaded.", recipe: "B (C B T) B" },
  Q2: { bird: "Quizzical", blurb: "The Quizzical bird is one of the numbered variants of Smullyan's Queer bird, a clutch of combinators that compose three arguments in shuffled orders. It lets the second function have the final say, applying it to the result of feeding the first argument through the third. All four numbered Q-birds branch from that original Queer combinator.", recipe: "B (C B) T" },
  Q3: { bird: "Quirky", blurb: "The Quirky bird is a Queer-family composer that lets the third function have the last word on a paired-up result. It is the leanest of the siblings, built from little more than a Bluebird and a Thrush. Like its Quixotic, Quizzical and Quacky kin, it merely re-wires the Queer bird's compose-and-shuffle.", recipe: "B T" },
  Q4: { bird: "Quacky", blurb: "The Quacky bird closes out the Queer family of argument-shufflers: hand it three things and the last is run on the second applied to the first. It is just the Quirky bird with a Cardinal flipping that inner pair, so its two ingredients meet in the opposite order. All of them are reorderings around the Queer bird, the family's reverse-composition namesake.", recipe: "C (B T)" },
  R: { bird: "Robin", blurb: "The Robin rotates three arguments, sending the first to the back of the line. It is nothing more than the Cardinal applied to itself, two swaps that together make a turn. Run three Robins in a row and they fold back into a single Cardinal, closing the little ring of permuting birds.", recipe: "C C" },
  S: { bird: "Starling", blurb: "The substitution bird: it hands one argument to two other birds, then feeds the first's answer the second's. Paired with the Kestrel it is all you ever need — together they conjure every other bird in the forest. Hand a Starling two Kestrels and the Identity bird flies out, a reminder of how little is truly primitive.", recipe: "primitive" },
  T: { bird: "Thrush", blurb: "The Thrush is reverse application: it hands its first argument to its second, letting the value pick the function. A stripped-down cousin of the Cardinal, it is just that swapping bird fed an Identity. Small as it is, it underpins the pairing Vireo and turns up inside the Queer family of reordered compositions.", recipe: "C I" },
  U: { bird: "Turing", blurb: "Handed to itself, this bird becomes a fixed-point combinator — a wellspring of recursion to set beside the Sage. Alan Turing described it in a one-page 1937 note, and unlike Curry's Y it doesn't merely sit equal to its own unfolding: it reduces straight onward into it, which often makes it the handier engine for recursion.", recipe: "λx y. y (x x y)" },
  V: { bird: "Vireo", blurb: "The Vireo bundles two values together and, paired with a head and tail, serves as a list's cons cell — the trick to encoding data in a forest of pure functions. Pull the parts back out with the Kestrel for the first and the Kite for the second. It is the Cardinal-flipped Finch, woven from a Bluebird, a Cardinal and a Thrush.", recipe: "B C (C I)" },
  W: { bird: "Warbler", blurb: "The duplicator: it hands the same argument to a function twice, so one value fills both slots where two were expected. One of the four primitives of Curry's BCKW basis, where it plays the role of contraction — the rule that lets an argument be reused rather than spent.", recipe: "S S (K I)" },
  X: { blurb: "Logical AND on Church Booleans: it answers true only when both of its arguments are true. Build it from a pair of Starlings capped with Kestrels and you have working conjunction — proof that even logic is just birds calling to birds across the forest.", recipe: "S S K" },
  Y: { bird: "Sage", blurb: "The sage bird of the forest: hand it any other bird and it returns one that bird is fond of, a fixed point of itself, which is exactly what lets the forest recurse with no bird ever naming itself. Curry called it the paradoxical combinator, born of the same self-reference as his famous paradox; here it grows from Mockingbirds and Bluebirds.", recipe: "B M (C B M)" },
  Z: { blurb: "Hands its first bird a single argument, then quietly swallows a trailing third — a tidy way to ignore an argument you do not want. It is just a Bluebird perched on a Kestrel: the Bluebird composes while the Kestrel forgets. That borrowed Kestrel is the source of the discard, the same constant-picking bird that stands in for Boolean true.", recipe: "B K" },
  Z2: { blurb: "Z reaching one rung deeper: it applies a function to its next two arguments and lets a trailing fourth fall away. The Zoo grows it by composing a Bluebird onto Z, the classic way to push a bird's reach further along the line. Its discarding habit traces back, like Z's, to the Kestrel — the bird that embodies logic's weakening rule.", recipe: "B Z" },
  "Φ": { bird: "Phoenix", blurb: "The Phoenix hands one shared argument to two different functions, then merges their results with an outer one. It's the fork-and-join cousin of the Starling, which instead feeds its argument straight through alongside a single function. Fittingly, Φ is a Bluebird wrapped around an S: composition's spin on substitution.", recipe: "B (B S) B" },
  "Ψ": { bird: "Psi", blurb: "The Psi bird takes one function, applies it to two separate arguments, then feeds the two results into a second function that combines them. Functional programmers know it as the \"on\" operator — comparing or merging things \"on\" some derived key — making it one of the quietly practical birds in the zoo.", recipe: "λx y z w. x (y z) (y w)" },
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
