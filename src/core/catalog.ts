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

/** Bracket abstraction over explicitly-named variables (nests, for the bodies
 *  that need captured outer vars — e.g. the Church predecessor). */
function lamN(names: string[], body: (v: Node[]) => Node): Node {
  let t = body(names.map(freeVar));
  for (let i = names.length - 1; i >= 0; i--) t = bracket(names[i], t);
  return t;
}

/** The Church predecessor body, λn f x. n (λg h. h (g f)) (λu. x) (λu. u) — the
 *  famously intricate "subtract one"; the building block of Pred and (-). */
const predBody = ([n, f, x]: Node[]): Node =>
  app(app(app(n, lamN(["g", "h"], ([g, h]) => app(h, app(g, f)))), lamN(["u"], () => x)), lamN(["u"], ([u]) => u));
const predDef = (): Node => lamN(["n", "f", "x"], predBody);

// ---- Church right-fold lists: a list IS its own right fold (nil = A = KI,
// fold = V). cons/head/map/null are clean; tail needs a predecessor-style
// pair-shuffle, and append (join) shares Y's finite probe (so it sits before Y).
const nilDef = (): Node => app(K(), I()); // the empty list (= false = 0)
const consBody = ([h, t, c, n]: Node[]): Node => app(app(c, h), app(app(t, c), n));
const consDef = (): Node => lamN(["h", "t", "c", "n"], consBody);
const appendBody = ([xs, ys]: Node[]): Node => app(app(xs, consDef()), ys); // xs ++ ys
const appendDef = (): Node => lamN(["xs", "ys"], appendBody);
const pairDef = (): Node => lamN(["x", "y", "f"], ([x, y, f]) => app(app(f, x), y)); // = V
const sndDef = (): Node => lamN(["p"], ([p]) => app(p, nilDef())); // second of a pair
/** tail via the predecessor trick: fold the list building (rest, whole) pairs,
 *  then take the first component — `fst (l step (nil,nil))`, fst inlined as `· K`. */
const tailBody = ([l]: Node[]): Node => {
  const step = lamN(["h", "p"], ([h, p]) => app(app(pairDef(), app(sndDef(), p)), app(app(consDef(), h), app(sndDef(), p))));
  const base = lamN(["f"], ([f]) => app(app(f, nilDef()), nilDef())); // the (nil, nil) pair, already reduced
  return app(app(app(l, step), base), K());
};
const mapBody = ([f, l]: Node[]): Node =>
  app(app(l, lamN(["h", "t"], ([h, t]) => app(app(consDef(), app(f, h)), t))), nilDef());
// uncons l = the pair (head l, tail l), built directly in normal form (λf. f h t);
// the tail half carries the pair-shuffling fold. tail is then snd · uncons.
const unconsBody = ([l]: Node[]): Node =>
  lamN(["f"], ([f]) => app(app(f, app(app(l, K()), nilDef())), tailBody([l])));

/** A bird whose def is the bracket abstraction of its law (so def ≡ law). */
function bird(sym: string, lawText: string, arity: number, body: (v: Node[]) => Node): Law {
  return { sym, lawText, arity, reference: body, def: () => lam(arity, body) };
}

// Alphabetical by symbol. I/K/S reduce by built-in rules (no def); Y is the
// recursive fixpoint (probed finitely); the rest derive their def from their law.
export const CATALOG: Law[] = [
  bird("(+)", "(+) m n f x = m f (n f x)", 4, (v) => app(app(v[0], v[2]), app(app(v[1], v[2]), v[3]))), // Church addition
  bird("(-)", "(-) m n = m ∸ n", 2, (v) => app(app(v[1], predDef()), v[0])), // Church subtraction (monus, via pred)
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
  bird("Pred", "Pred n = n ∸ 1", 3, predBody), // Church predecessor
  bird("Q", "Q x y z = y (x z)", 3, (v) => app(v[1], app(v[0], v[2]))), // Queer
  bird("Q1", "Q1 x y z = x (z y)", 3, (v) => app(v[0], app(v[2], v[1]))), // Quixotic
  bird("Q2", "Q2 x y z = y (z x)", 3, (v) => app(v[1], app(v[2], v[0]))), // Quizzical
  bird("Q3", "Q3 x y z = z (x y)", 3, (v) => app(v[2], app(v[0], v[1]))), // Quirky
  bird("Q4", "Q4 x y z = z (y x)", 3, (v) => app(v[2], app(v[1], v[0]))), // Quacky
  bird("R", "R x y z = y z x", 3, (v) => app(app(v[1], v[2]), v[0])), // Robin
  { sym: "S", lawText: "S x y z = x z (y z)", arity: 3, reference: (v) => app(app(v[0], v[2]), app(v[1], v[2])) }, // Starling
  bird("Succ", "Succ n f x = f (n f x)", 3, (v) => app(v[1], app(app(v[0], v[1]), v[2]))), // Church successor (= S B)
  bird("T", "T x y = y x", 2, (v) => app(v[1], v[0])), // Thrush
  bird("U", "U x y = y (x x y)", 2, (v) => app(v[1], app(app(v[0], v[0]), v[1]))), // Turing
  bird("V", "V x y z = z x y", 3, (v) => app(app(v[2], v[0]), v[1])), // Vireo (pairing)
  bird("W", "W x y = x y y", 2, (v) => app(app(v[0], v[1]), v[1])), // Warbler
  bird("X", "X x y = x y x", 2, (v) => app(app(v[0], v[1]), v[0])), // Xenops (logical AND, = S S K)
  // ---- list operations (right-fold encoding); kept together, and <> must
  // precede Y since append shares Y's finite probe.
  bird("cons", "cons h t c n = c h (t c n)", 4, consBody), // prepend
  bird("head", "head (h : t) = h", 1, (v) => app(app(v[0], K()), nilDef())),
  bird("<>", "xs <> ys = xs ++ ys", 2, appendBody), // append (Semigroup)
  bird("concat", "concat (xs : xss) = xs <> concat xss", 1, (v) => app(app(v[0], appendDef()), nilDef())), // monadic join / concat
  bird("map", "map f (h : t) = f h : map f t", 2, mapBody),
  bird("null", "null [] = K,  null (h : t) = KI", 1, (v) => app(app(v[0], app(K(), app(K(), nilDef()))), K())),
  bird("uncons", "uncons (h : t) = (h, t)", 1, unconsBody),
  bird("tail", "tail (h : t) = t", 1, tailBody),
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
  "(+)": { blurb: "Church addition: it runs one numeral's stack of applications, then the other's, on the same arguments. A Starling-and-Bluebird scaffold — or simply Succ fed to a numeral n times. Multiplication needs no new bird at all: that is the Bluebird itself, and exponentiation is the Thrush.", recipe: "B S (B B)" },
  "(-)": { blurb: "Truncated subtraction (monus): m minus n, clamped at zero. It applies the predecessor to m, n times over — short once you have Pred, but an enormous ι-tree when Pred is unfolded inline, the largest in the zoo.", recipe: "C (T Pred)" },
  Succ: { blurb: "The successor: it wraps one more application around a Church numeral, turning n into n+1. It is the Starling perched on the Bluebird — a small reminder that all of arithmetic can be grown from a couple of birds.", recipe: "S B" },
  Pred: { blurb: "The predecessor: it strips one application back off a Church numeral, turning n+1 into n (and leaving 0 at 0). Famously hard to define — Stephen Kleene is said to have hit on the trick in 1932 in the dentist's chair, under nitrous oxide. Succ's mirror image, and the engine inside subtraction.", recipe: "λn f x. n (λg h. h (g f)) (λu. x) (λu. u)" },
  cons: { blurb: "Prepends a head onto a list. In this encoding a list IS its own right fold, so cons just remembers to fold the new head in before the rest. It is the Vireo's pairing instinct grown into a first-class list-builder.", recipe: "B S (B (B B) T)" },
  head: { blurb: "Takes the first element of a list (or the empty list, if there is none). It folds with the Kestrel, which keeps the head and discards the tail — the very trick that pulls the first value out of a pair.", recipe: "C (T K) nil" },
  uncons: { blurb: "Splits a non-empty list into its head and tail, paired together — the one honest way to take a list apart. Conceptually tail is its second projection (snd · uncons), though tail is cheaper computed on its own.", recipe: "λl. (head l, tail l)" },
  tail: { blurb: "Drops the first element and returns the rest. Like the predecessor for numbers, it is the hard one: a list keeps no direct 'rest', so tail rebuilds it with a pair-shuffling fold. The list world's answer to Pred.", recipe: "λl. fst (l step (nil, nil))" },
  "<>": { blurb: "Appends one list onto another (xs ++ ys) — the Semigroup of lists — by folding xs with cons onto ys. Curiously it passes the exact same finite test as the Sage bird: append and the fixpoint combinator are twins under that probe, so it roosts just ahead of Y.", recipe: "T cons" },
  concat: { blurb: "Flattens a list of lists, [[a]] down to [a], by folding them together with append. This is the list monad's join — concat is exactly that operation.", recipe: "C (T <>) nil" },
  map: { blurb: "Applies a function to every element, building a fresh list. A fold that re-conses each transformed head onto the rest — the workhorse of list processing.", recipe: "λf l. l (B cons f) nil" },
  null: { blurb: "Tests whether a list is empty, answering with a Church Boolean. Any cons folds its way to false; only the empty list is left as true.", recipe: "C (T (K (K nil))) K" },
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
  U: { bird: "Turing", blurb: "Hand this bird to itself and it becomes a fixpoint combinator — a wellspring of recursion beside the Sage. Alan Turing described it in a one-page 1937 note, and Smullyan named it the Turing bird in his honour: a rare combinator named for a person, not a letter-matching species. Unlike Curry's Y it reduces straight onward into its own unfolding.", recipe: "S (K (S I)) (W I)" },
  V: { bird: "Vireo", blurb: "The Vireo bundles two values and, given a head and tail, serves as a list's cons cell — the trick to encoding data among pure functions. Pull the parts back with the Kestrel (first) and the Albatross (second). Woven from a Bluebird, Cardinal and Thrush; a V-bird for the letter.", recipe: "B C (C I)" },
  W: { bird: "Warbler", blurb: "The Warbler hands the same argument to a function twice — a duplicator. It is one of the four primitives of Curry's BCKW basis, where it plays the role of contraction, reusing an argument rather than spending it. The warbler is Curry's W-bird.", recipe: "S S (K I)" },
  X: { bird: "Xenops", blurb: "Logical AND on Church Booleans — it answers true only when both arguments are true, and is built from a pair of Starlings and a Kestrel. X is no classical combinator letter, so it borrows the Xenops, one of the very few birds whose name begins with X.", recipe: "S S K" },
  Y: { bird: "Sage", blurb: "The sage bird of the forest: hand it any bird and it returns one that bird is fond of — a fixed point of itself — which is what lets the forest recurse. Curry called it the paradoxical combinator and wrote it Y; Smullyan's 'Sage' captures the wisdom of always knowing a bird's fixed point. Grown from Mockingbirds and Bluebirds.", recipe: "B M (C B M)" },
  Z: { bird: "Zebra Finch", blurb: "Hands a function two arguments, then quietly swallows a trailing third — a tidy way to ignore an argument. It is a Bluebird perched on a Kestrel, the Kestrel doing the discarding. The letter Z was Schönfinkel's old mark for composition; here it takes a Zebra Finch for its name.", recipe: "B K" },
  Z2: { bird: "Zebra Dove", blurb: "Z reaching one rung deeper: it applies a function to its next two arguments and lets a trailing fourth fall away. Built by composing a Bluebird onto Z. Named the Zebra Dove — a Z-bird, and a Dove nodding to the Bluebird composition inside it.", recipe: "B Z" },
  "Φ": { bird: "Phoenix", blurb: "The Phoenix hands one shared argument to two different functions, then merges their results with a third — the fork-and-join cousin of the Starling, and Haskell's liftA2. Φ is the Greek letter 'Phi', so the Phoenix, a Ph-bird, fits the symbol.", recipe: "B (B S) B" },
  "Ψ": { bird: "Psittacosaurus", blurb: "The Psi bird applies one function to two separate arguments, then feeds the results to a second that combines them — functional programmers' `on` operator. No bird's name begins with the Greek Ψ, so it borrows a dinosaur: Psittacosaurus, the 'parrot lizard'.", recipe: "λx y z w. x (y z) (y w)" },
};

/** One-line discovery hints (built by a research-backed workflow from
 *  Smullyan's "To Mock a Mockingbird" + web sources): how to BUILD each
 *  combinator, shown as the "next to discover" nudge. */
export const HINTS: Record<string, string> = {
  "(+)": "Starling-on-Bluebirds scaffold B S (B B); or m Succ n (apply Succ m times to n). Builds m f (n f x): n stacks f on x, then m stacks atop.",
  "(-)": "Aim for n Pred m. T Pred n = n Pred turns n into a Pred-iterator; the Cardinal flips its args so n is the count: C (T Pred).",
  "<>": "Since a list is its own right fold, append is xs cons ys; the Thrush hands cons to the list (T cons xs = xs cons), so xs folds onto ys.",
  A: "Feed the Kestrel an Identity bird as its FIRST argument (K I): K keeps that I, which then returns your second argument and drops the first.",
  B: "Composition — pipe one bird's output into the next. Build it by feeding the Starling two args: (K S) then a Kestrel, giving S(KS)K.",
  B1: "Stretch the Bluebird to swallow a 3-arg call: perch a Bluebird on a Bluebird on a Bluebird — B B B, the Blackbird.",
  B2: "The Blackbird B B B composes after a 3-arg function; chain one more Bluebird onto it, B B (B B B), to reach the 4-arg Bunting.",
  B3: "Compose three in a row, x(y(zw)): take the deep composer B and pre-feed it B with B B, giving B(B B)B — the Becard.",
  C: "The Cardinal swaps its 2nd and 3rd arguments (Boolean NOT); coax it from two Starlings and Kestrels caging a Bluebird: S(S(KB)S)(KK).",
  D: "The Dove reaches one slot deeper than the Bluebird, composing (z w) into a binary function's second arg — stack two Bluebirds: B B.",
  E: "Prepend one more Bluebird onto the Blackbird B B B: B (B B B) widens the Dove's inner call from z w to a 3-way z w v — the Eagle.",
  F: "Want z y x? Take the pairing Vireo (V x y z = z x y) and let a Cardinal pre-swap its first two inputs: F = C V.",
  G: "Stack two Bluebirds to compose, then a Cardinal to swap: the last arg jumps to the front while the middle pair (y z) gets bundled — B B C, the Goldfinch.",
  H: "Duplicate the second arg at the tail: a Bluebird stacks a Warbler over a Bluebird-Cardinal — B W (B C) — so W copies y and C slots it last.",
  I: "Identity does nothing — and it's the cheapest bird here (just 2 iotas): build it by feeding iota to itself, ι ι.",
  J: "Reuse one operator x twice (Warbler): write x y _, then fill the blank with that same x applied to the last two args swapped, x w z.",
  K: "The Kestrel keeps the first, forgets the second. Take I = ι ι and wrap it in ι twice more: ι(ι(ι ι)).",
  L: "A Cardinal slots the Mockingbird into a Bluebird's second slot (C B M): the Lark runs x after y-squared. Feed it I and M hatches.",
  M: "The forest's namesake mimic: a Starling fed two Identity birds (S I I) shares x with both, each echoes it, then applies one to the other — x x.",
  M2: "Perch a Bluebird on the Mockingbird (B M): it feeds the application x y to M, which copies it — yielding x y (x y).",
  N: "Compose Kestrel after Thrush with a Bluebird (B K T): the Kestrel eats the middle bird, then the Thrush applies the last bird to the first.",
  O: "A near-Sage: feed Identity into the Starling's first slot (S I), so the Starling hands y the result of running x on y — i.e. y (x y).",
  Pred: "Iterate the shift λg h.h(g f) n times from base λu.x, then feed λu.u; the first step discards an f, peeling f^{n+1} down to f^n.",
  Q: "Build C B: the Cardinal flips the Bluebird's first two args so the first function runs and pours into the second — x z first, then y over it (y (x z)).",
  Q1: "Quixotic feeds arg three onto arg two, then runs the first over the result (x (z y)): give the Queer bird (C B) a Thrush, then frame it with two Bluebirds — B (C B T) B.",
  Q2: "Run the third function on arg1, then the second over that — hang a Thrush under the Queer bird via a Bluebird: B (C B) T.",
  Q3: "Quirky is the leanest Queer cousin: hand x its arg y, then let the third bird z pounce on the result (x y) — compose Bluebird before Thrush: B T.",
  Q4: "Take Quirky B T (gives z(xy)); prepend a Cardinal to flip the inner pair: C (B T) yields z(yx) — last bird run on second-applied-to-first.",
  R: "The Robin rotates three args, sending the first to the back — two Cardinal swaps make one turn, so perch a Cardinal on itself: C C.",
  S: "The Starling shares one arg with two birds. It's just one ι past the Kestrel — ι(ι(ι(ι ι))).",
  Succ: "Feed a Bluebird to a Starling (S B): S hands x to both f and n f, firing f once more on the numeral, so n becomes n+1.",
  T: "Thrush flips its two args (T x y = y x). The Cardinal C x y z = x z y already does the swap, so put Identity in its first slot: C I.",
  U: "Build U as S (K (S I)) (W I): S hands x to W I, which doubles it to x x, and to the K-guarded S I; then U U is Turing's fixpoint.",
  V: "Build V (Vireo) as B C (C I): the Bluebird composes the Cardinal with the Thrush (C I), so V x y z reduces to z x y — a swap then a flip.",
  W: "Warbler the duplicator: feed Starling two things, Starling itself and a Kestrel-guarded Identity (S S (K I)), to copy its last argument.",
  X: "Feed a Starling to a Starling and a Kestrel — S applied to (S, K) — and it reduces x y x: x runs on y, falling back to x, which is Church AND.",
  Y: "The Sage gives each bird its fixed point: Bluebird-compose a Mockingbird onto a Lark, with the Lark spelled C B M — so B M (C B M).",
  Z: "Perch a Bluebird on a Kestrel (B K): B hands x its single argument y, then the Kestrel quietly swallows the trailing third, z.",
  Z2: "Compose a Bluebird onto Z (B Z): the same trailing-argument-swallowing trick reaching one rung deeper, dropping the fourth argument instead of the third.",
  concat: "Same shape as head, but fold with append not Kestrel: C (T <>) nil glues a list of lists into one.",
  cons: "List-as-fold: S shares c and n, T gives the head to c (c h), B fires it before the folded tail t c n. Hence B S (B (B B) T).",
  head: "A list is its own right-fold: head = fold with K (K keeps the head, drops the rest). T K feeds K to the list; C ...nil gives the base.",
  map: "Fold the list with a transformed cons: l (B cons f) nil, where B cons f turns head h into cons (f h) before consing onto the folded tail.",
  null: "null xs = xs (K(K nil)) K: fold with cons-arg K(K nil) (any cons drops to nil=false) and nil-arg K=true; C(T(K(K nil)))K wires that.",
  tail: "Fold from seed (nil,nil); each step shifts new fst=old snd, new snd=h:old snd, so fst lags one cons behind — read fst for the rest.",
  uncons: "Take the list apart honestly: pair the head and tail you already built with the Vireo — V (head l) (tail l) = (head l, tail l).",
  "Φ": "The fork — hand one arg to two birds, merge results with a third (Haskell's liftA2). Sink a Starling between Bluebirds: B (B S) B.",
  "Ψ": "The 'on' bird: apply y to z and to w, then let x combine the two results — x(y z)(y w). Build it straight: λx y z w. x(y z)(y w).",
};

/** A combinator as it appears on a page: its symbol, an optional topic alias
 *  (e.g. "True" for K) and a one-line note on the role it plays there. */
export interface PageEntry {
  sym: string;
  alias?: string;
  role?: string;
}
/** A named tab grouping combinators (shared by the Zoo and the hotbar). */
export interface PageDef {
  name: string;
  entries: PageEntry[];
}

// Combinators that belong only to a topic page, not to the general "Programs" tab.
const ARITH_OPS = new Set(["Succ", "Pred", "(+)", "(-)"]);
const LIST_OPS = new Set(["cons", "head", "tail", "<>", "concat", "map", "null", "uncons"]);

/** The pages, shared by the Zoo catalogue and the hotbar. "Programs" holds the
 *  general-purpose combinators; the topic pages re-present combinators (often the
 *  same birds) under the role they play there. */
export const PAGES: PageDef[] = [
  {
    name: "Programs",
    entries: [{ sym: "ι" }, ...CATALOG.filter((l) => !ARITH_OPS.has(l.sym) && !LIST_OPS.has(l.sym)).map((l) => ({ sym: l.sym }))],
  },
  {
    name: "Booleans",
    entries: [
      { sym: "K", alias: "True", role: "selects the first of two options" },
      { sym: "A", alias: "False", role: "selects the second of two options" },
      { sym: "C", alias: "Not", role: "swaps the two options" },
      { sym: "X", alias: "And", role: "true only when both are true" },
      { sym: "M", alias: "Or", role: "true when either is true" },
      { sym: "I", alias: "If", role: "`if c t e` is just `c t e` — a boolean is its own conditional" },
    ],
  },
  {
    name: "Arithmetic",
    entries: [
      { sym: "A", alias: "Zero", role: "Church 0 — applies f zero times" },
      { sym: "I", alias: "One", role: "Church 1 — applies f exactly once" },
      { sym: "Succ", alias: "Succ", role: "adds one to a numeral" },
      { sym: "Pred", alias: "Pred", role: "subtracts one (clamped at 0) — the basis of Sub" },
      { sym: "(+)", alias: "Plus", role: "adds two numerals" },
      { sym: "B", alias: "Mult", role: "multiplies — multiplication is the Bluebird (composition)" },
      { sym: "T", alias: "Exp", role: "raises to a power — m^n is just n m" },
      { sym: "(-)", alias: "Sub", role: "truncated subtraction, via the predecessor" },
    ],
  },
  {
    name: "Lists",
    entries: [
      { sym: "A", alias: "nil", role: "the empty list — also false and zero" },
      { sym: "cons", alias: "cons", role: "prepends a head onto a list" },
      { sym: "head", alias: "head", role: "the first element" },
      { sym: "uncons", alias: "uncons", role: "splits a list into (head, tail)" },
      { sym: "tail", alias: "tail", role: "everything after the head — the list's predecessor" },
      { sym: "V", alias: "fold", role: "right fold — a list is its own fold (the Vireo)" },
      { sym: "<>", alias: "<>", role: "appends one list onto another (Semigroup, ++)" },
      { sym: "concat", alias: "concat", role: "flattens a list of lists (monadic join)" },
      { sym: "map", alias: "map", role: "applies a function to every element" },
      { sym: "null", alias: "null", role: "is the list empty?" },
    ],
  },
];

/** Expand an SK(I) tree into a pure-ι tree (the skToIota gadget, §7.3):
 *  S/K/I leaves become their ι-trees, application stays application. */
function skToIota(n: Node): Node {
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
