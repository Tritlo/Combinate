import { type Node, type NodeId, app, comb, decode, freeVar, iotaTreeFrom } from "./term";

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
   * Direct reduction rule (the law itself), used by the optimize mode
   * (`reduce.ts` `fast`): a saturated named combinator reduces by this in one
   * step — `args` are the actual argument terms — instead of unfolding its SKI
   * `def`. For the recursive birds it is the Scott recursion via named
   * sub-combinators (no Y). Omitted for I/K/S (built-in rules).
   */
  rule?: (args: Node[]) => Node;
  /**
   * The underlying tree a collapsed named node stands for, so the reducer can
   * unfold it when applied. Omitted for I/K/S, which the reducer handles with
   * built-in rules.
   */
  def?: () => Node;
  /** True for a player-authored combinator (ADR 0006): it lives in the catalog
   *  like any other, but the behavioural probe skips it (it is *defined*, not
   *  *discovered*, so it never auto-collapses another tree). */
  userDefined?: boolean;
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
 *  that need captured outer vars — e.g. the recursive list/arithmetic folds). */
function lamN(names: string[], body: (v: Node[]) => Node): Node {
  let t = body(names.map(freeVar));
  for (let i = names.length - 1; i >= 0; i--) t = bracket(names[i], t);
  return t;
}

// ---- Scott data — the encoding MicroHs compiles `data` to (EncodeData.hs). A
// value applies the eliminator arm for its own constructor, in declaration
// order, carrying its fields; pattern-matching IS that application. Constructors
// and the structural eliminators (head/tail/uncons/null/Pred) are clean reads;
// the folds carry no built-in recursion, so they recurse explicitly via Y. ----

/** `K I` — the "return the second" selector: Scott True, a pair's snd, and the
 *  cons / successor eliminator arm. */
const KI = (): Node => app(K(), I());
/** The Vireo `λx y z. z x y`; `V_ x y` is the Scott pair `(x, y)`. */
const V_ = (): Node => lamN(["x", "y", "z"], ([x, y, z]) => app(app(z, x), y));

// Nat = Z | S Nat:  Z = K,  S p = λz s. s p
const zeroDef = (): Node => K(); // Z
const succBody = (v: Node[]): Node => app(v[2], v[0]); // Succ n z s = s n
const succDef = (): Node => lam(3, succBody);
// Pred (S p) = p,  Pred Z = Z:  λm. m Z I
const predBody = (v: Node[]): Node => app(app(v[0], zeroDef()), I());
const predDef = (): Node => lam(1, predBody);

// [] = [] | (:) a [a]:  nil = K,  cons h t = λn c. c h t
const nilDef = (): Node => K();
const consBody = (v: Node[]): Node => app(app(v[3], v[0]), v[1]); // cons h t n c = c h t
const consDef = (): Node => lam(4, consBody);

// ---- recursive ops (folds / arithmetic). Scott data carries no fold, so these
// recurse via the Sage Y. The fresh-var probe can't reach them (they stick on an
// opaque argument), so they read "built, not discovered": a sentinel reference
// no real normal form equals keeps them from ever matching another tree. ----
const Yc = (): Node => app(app(B(), M()), app(app(C(), B()), M())); // B M (C B M)
/** `f = Y (λrec a b … . body)`; `body` receives `[rec, a, b, …]`. */
const recDef = (names: string[], body: (v: Node[]) => Node): Node => app(Yc(), lamN(["$r", ...names], body));
const noProbe = (sym: string) => (): Node => freeVar(`$norec_${sym}`);

// append xs ys = case xs of []→ys; (h:t)→ h : (t ++ ys)
const appendDef = (): Node =>
  recDef(["xs", "ys"], ([r, xs, ys]) => app(app(xs, ys), lamN(["h", "t"], ([h, t]) => app(app(consDef(), h), app(app(r, t), ys)))));
// map f xs = case xs of []→[]; (h:t)→ f h : map f t
const mapDef = (): Node =>
  recDef(["f", "xs"], ([r, f, xs]) => app(app(xs, nilDef()), lamN(["h", "t"], ([h, t]) => app(app(consDef(), app(f, h)), app(app(r, f), t)))));
// concat xss = case xss of []→[]; (h:t)→ h ++ concat t
const concatDef = (): Node =>
  recDef(["xss"], ([r, xss]) => app(app(xss, nilDef()), lamN(["h", "t"], ([h, t]) => app(app(appendDef(), h), app(r, t)))));
// (+) m n = case m of Z→n; S p→ S (p + n)
const plusDef = (): Node =>
  recDef(["m", "n"], ([r, m, n]) => app(app(m, n), lamN(["p"], ([p]) => app(succDef(), app(app(r, p), n)))));
// (-) m n = case n of Z→m; S p→ Pred (m - p)   (monus)
const minusDef = (): Node =>
  recDef(["m", "n"], ([r, m, n]) => app(app(n, m), lamN(["p"], ([p]) => app(predDef(), app(app(r, m), p)))));
// (*) m n = case m of Z→Z; S p→ n + (p * n)
const timesDef = (): Node =>
  recDef(["m", "n"], ([r, m, n]) => app(app(m, zeroDef()), lamN(["p"], ([p]) => app(app(plusDef(), n), app(app(r, p), n)))));

// ---- equality / ordering on Scott numerals. The MicroHs post-processor (mhs.ts)
// substitutes the Int/Char comparison primitives to these; a Char IS its ASCII
// numeral (Char ≡ Int), so chars reuse them. True = A (= K I), False = K. ----
// (==) m n = m (n True (λq. False)) (λp. n False (λq. p == q))
const eqNatDef = (): Node =>
  recDef(["m", "n"], ([r, m, n]) =>
    app(app(m, app(app(n, KI()), app(K(), K()))), lamN(["p"], ([p]) => app(app(n, K()), lamN(["q"], ([q]) => app(app(r, p), q))))));
// (<) m n = n False (λq. m True (λp. p < q))   — nothing is < 0; 0 < S q
const ltNatDef = (): Node =>
  recDef(["m", "n"], ([r, m, n]) => app(app(n, K()), lamN(["q"], ([q]) => app(app(m, KI()), lamN(["p"], ([p]) => app(app(r, p), q))))));
// (<=) m n = m True (λp. n False (λq. p <= q))
const leNatDef = (): Node =>
  recDef(["m", "n"], ([r, m, n]) => app(app(m, KI()), lamN(["p"], ([p]) => app(app(n, K()), lamN(["q"], ([q]) => app(app(r, p), q))))));
// (/=) m n = not (m == n) = (m == n) True False;  (>) = flip (<);  (>=) = flip (<=)
const neNatDef = (): Node => lamN(["m", "n"], ([m, n]) => app(app(app(app(eqNatDef(), m), n), KI()), K()));
const gtNatDef = (): Node => app(C(), ltNatDef());
const geNatDef = (): Node => app(C(), leNatDef());
// Ordering = LT | EQ | GT — a Scott 3-constructor, selecting arm 1 / 2 / 3.
const ordLtDef = (): Node => lam(3, (v) => v[0]);
const ordEqDef = (): Node => lam(3, (v) => v[1]);
const ordGtDef = (): Node => lam(3, (v) => v[2]);
// compare m n = m (n EQ (λq. LT)) (λp. n GT (λq. compare p q))
const compareDef = (): Node =>
  recDef(["m", "n"], ([r, m, n]) =>
    app(app(m, app(app(n, ordEqDef()), app(K(), ordLtDef()))), lamN(["p"], ([p]) => app(app(n, ordGtDef()), lamN(["q"], ([q]) => app(app(r, p), q))))));

/** A bird whose def is the bracket abstraction of its law (so def ≡ law). Its
 *  law doubles as the optimize-mode `rule` (applied to actual args directly). */
function bird(sym: string, lawText: string, arity: number, body: (v: Node[]) => Node): Law {
  return { sym, lawText, arity, reference: body, rule: body, def: () => lam(arity, body) };
}

// ---- optimize-mode rules for the recursive ops: the direct Scott recursion via
// *named* sub-combinators (`mk` below), no Y. Mirrors the Y-based defs above but
// reduces step-by-step through named birds (each then reduced by its own rule)
// instead of grinding the SKI Y-blob. Args reused twice are made id-unique by the
// reducer (dedupIds), so these bodies can share freely. ----
const appendRule = ([xs, ys]: Node[]): Node => app(app(xs, ys), lamN(["h", "t"], ([h, t]) => app(app(mk("cons"), h), app(app(mk("<>"), t), ys))));
const mapRule = ([f, xs]: Node[]): Node => app(app(xs, K()), lamN(["h", "t"], ([h, t]) => app(app(mk("cons"), app(f, h)), app(app(mk("map"), f), t))));
const concatRule = ([xss]: Node[]): Node => app(app(xss, K()), lamN(["h", "t"], ([h, t]) => app(app(mk("<>"), h), app(mk("concat"), t))));
const plusRule = ([m, n]: Node[]): Node => app(app(m, n), lamN(["p"], ([p]) => app(mk("Succ"), app(app(mk("(+)"), p), n))));
const minusRule = ([m, n]: Node[]): Node => app(app(n, m), lamN(["p"], ([p]) => app(mk("Pred"), app(app(mk("(-)"), m), p))));
const timesRule = ([m, n]: Node[]): Node => app(app(m, K()), lamN(["p"], ([p]) => app(app(mk("(+)"), n), app(app(mk("(*)"), p), n))));
// comparison/ordering rules: mirror the Y-defs but recurse through named birds.
const eqNatRule = ([m, n]: Node[]): Node =>
  app(app(m, app(app(n, KI()), app(K(), K()))), lamN(["p"], ([p]) => app(app(n, K()), lamN(["q"], ([q]) => app(app(mk("(==)"), p), q)))));
const ltNatRule = ([m, n]: Node[]): Node =>
  app(app(n, K()), lamN(["q"], ([q]) => app(app(m, KI()), lamN(["p"], ([p]) => app(app(mk("(<)"), p), q)))));
const leNatRule = ([m, n]: Node[]): Node =>
  app(app(m, KI()), lamN(["p"], ([p]) => app(app(n, K()), lamN(["q"], ([q]) => app(app(mk("(<=)"), p), q)))));
const neNatRule = ([m, n]: Node[]): Node => app(app(app(app(mk("(==)"), m), n), KI()), K());
const gtNatRule = ([m, n]: Node[]): Node => app(app(mk("(<)"), n), m);
const geNatRule = ([m, n]: Node[]): Node => app(app(mk("(<=)"), n), m);
const compareRule = ([m, n]: Node[]): Node =>
  app(app(m, app(app(n, mk("EQ")), app(K(), mk("LT")))), lamN(["p"], ([p]) => app(app(n, mk("GT")), lamN(["q"], ([q]) => app(app(mk("compare"), p), q)))));
const yRule = ([f]: Node[]): Node => app(f, app(mk("Y"), f)); // Y f → f (Y f)

// Alphabetical by symbol. I/K/S reduce by built-in rules (no def); Y is the
// recursive fixpoint (probed finitely); the rest derive their def from their law.
export const CATALOG: Law[] = [
  { sym: "(+)", lawText: "(+) Z n = n;  (+) (S p) n = S (p + n)", arity: 2, reference: noProbe("(+)"), rule: plusRule, def: plusDef }, // Peano addition
  { sym: "(-)", lawText: "(-) m Z = m;  (-) m (S p) = Pred (m - p)", arity: 2, reference: noProbe("(-)"), rule: minusRule, def: minusDef }, // Peano monus
  { sym: "(*)", lawText: "(*) Z n = Z;  (*) (S p) n = n + (p * n)", arity: 2, reference: noProbe("(*)"), rule: timesRule, def: timesDef }, // Peano product
  { sym: "(==)", lawText: "(==) Z Z = True;  (==) (S p) (S q) = p == q;  else False", arity: 2, reference: noProbe("(==)"), rule: eqNatRule, def: eqNatDef }, // Peano equality
  { sym: "(/=)", lawText: "(/=) m n = not (m == n)", arity: 2, reference: noProbe("(/=)"), rule: neNatRule, def: neNatDef },
  { sym: "(<)", lawText: "(<) m Z = False;  (<) Z (S q) = True;  (<) (S p) (S q) = p < q", arity: 2, reference: noProbe("(<)"), rule: ltNatRule, def: ltNatDef },
  { sym: "(<=)", lawText: "(<=) Z n = True;  (<=) (S p) Z = False;  (<=) (S p) (S q) = p <= q", arity: 2, reference: noProbe("(<=)"), rule: leNatRule, def: leNatDef },
  { sym: "(>)", lawText: "(>) m n = n < m", arity: 2, reference: noProbe("(>)"), rule: gtNatRule, def: gtNatDef },
  { sym: "(>=)", lawText: "(>=) m n = n <= m", arity: 2, reference: noProbe("(>=)"), rule: geNatRule, def: geNatDef },
  { sym: "compare", lawText: "compare m n = LT | EQ | GT (three-way)", arity: 2, reference: noProbe("compare"), rule: compareRule, def: compareDef },
  bird("LT", "LT l e g = l", 3, (v) => v[0]), // Ordering: less-than
  bird("EQ", "EQ l e g = e", 3, (v) => v[1]), // Ordering: equal
  bird("GT", "GT l e g = g", 3, (v) => v[2]), // Ordering: greater-than
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
  bird("Pred", "Pred (S p) = p;  Pred Z = Z", 1, predBody), // strips one successor (Z stays Z)
  bird("Q", "Q x y z = y (x z)", 3, (v) => app(v[1], app(v[0], v[2]))), // Queer
  bird("Q1", "Q1 x y z = x (z y)", 3, (v) => app(v[0], app(v[2], v[1]))), // Quixotic
  bird("Q2", "Q2 x y z = y (z x)", 3, (v) => app(v[1], app(v[2], v[0]))), // Quizzical
  bird("Q3", "Q3 x y z = z (x y)", 3, (v) => app(v[2], app(v[0], v[1]))), // Quirky
  bird("Q4", "Q4 x y z = z (y x)", 3, (v) => app(v[2], app(v[1], v[0]))), // Quacky
  bird("R", "R x y z = y z x", 3, (v) => app(app(v[1], v[2]), v[0])), // Robin
  { sym: "S", lawText: "S x y z = x z (y z)", arity: 3, reference: (v) => app(app(v[0], v[2]), app(v[1], v[2])) }, // Starling
  bird("Succ", "Succ n z s = s n", 3, succBody), // Scott successor
  bird("T", "T x y = y x", 2, (v) => app(v[1], v[0])), // Thrush
  bird("U", "U x y = y (x x y)", 2, (v) => app(v[1], app(app(v[0], v[0]), v[1]))), // Turing
  bird("V", "V x y z = z x y", 3, (v) => app(app(v[2], v[0]), v[1])), // Vireo (pairing)
  bird("W", "W x y = x y y", 2, (v) => app(app(v[0], v[1]), v[1])), // Warbler
  bird("X", "X x y = x y x", 2, (v) => app(app(v[0], v[1]), v[0])), // Xenops (= S S K)
  // ---- Scott boolean operators (False = K, True = A); the case `if c t e = c e t`
  // is just the Cardinal C.
  bird("not", "not b = if b then False else True", 1, (v) => app(app(v[0], KI()), K())), // b True False
  bird("and", "and p q = if p then q else False", 2, (v) => app(app(v[0], K()), v[1])), // p False q
  bird("or", "or p q = if p then True else q", 2, (v) => app(app(v[0], v[1]), KI())), // p q True
  // ---- Scott list operations; the structural ops read off one eliminator arm,
  // the folds (<>, concat, map) recurse via Y (built, not discovered).
  bird("cons", "cons h t n c = c h t", 4, consBody), // prepend (Scott cons cell)
  bird("head", "head (h : t) = h", 1, (v) => app(app(v[0], K()), K())), // xs nil-default K
  { sym: "<>", lawText: "[] <> ys = ys;  (h:t) <> ys = h : (t <> ys)", arity: 2, reference: noProbe("<>"), rule: appendRule, def: appendDef }, // append
  { sym: "concat", lawText: "concat [] = [];  concat (xs:xss) = xs <> concat xss", arity: 1, reference: noProbe("concat"), rule: concatRule, def: concatDef }, // flatten
  { sym: "map", lawText: "map f [] = [];  map f (h:t) = f h : map f t", arity: 2, reference: noProbe("map"), rule: mapRule, def: mapDef },
  bird("null", "null [] = True;  null (h : t) = False", 1, (v) => app(app(v[0], KI()), lamN(["h", "t"], () => K()))), // xs True (λh t. False)
  bird("uncons", "uncons (h : t) = (h, t)", 1, (v) => app(app(v[0], app(app(V_(), K()), K())), V_())), // xs (nil,nil) (λh t. (h,t))
  bird("tail", "tail (h : t) = t", 1, (v) => app(app(v[0], K()), KI())), // xs nil-default (λh t. t)
  // Sage Θ — recursive, so probed as Y (K a) ≡ a (Y a diverges).
  {
    sym: "Y",
    lawText: "Y f = f (Y f)",
    arity: 1,
    args: (v) => [app(K(), v[0])],
    reference: (v) => v[0],
    rule: yRule,
    def: () => app(app(B(), M()), app(app(C(), B()), M())), // B M (C B M)
  },
  bird("Z", "Z x y z = x y", 3, (v) => app(v[0], v[1])), // Zebra Finch (drops its 3rd arg, = B K)
  bird("Z2", "Z2 x y z w = x y z", 4, (v) => app(app(v[0], v[1]), v[2])), // Zebra Dove (= B Z)
  bird("Φ", "Φ x y z w = x (y w) (z w)", 4, (v) => app(app(v[0], app(v[1], v[3])), app(v[2], v[3]))), // Phoenix
  bird("Ψ", "Ψ x y z w = x (y z) (y w)", 4, (v) => app(app(v[0], app(v[1], v[2])), app(v[1], v[3]))), // Psittacosaurus
];

const LAW_BY_SYM = new Map(CATALOG.map((l) => [l.sym, l] as const));

/** Build a rule-carrying named combinator node, by symbol — used inside the
 *  optimize-mode rules to reference other birds (and themselves) by name rather
 *  than inlining their SKI def. */
function mk(sym: string): Node {
  const l = LAW_BY_SYM.get(sym);
  if (!l) throw new Error(`mk: no law for ${sym}`);
  return comb(sym, l.def?.(), l.arity);
}

/** Build a rule-carrying named combinator node by catalog symbol (its SKI `def`
 *  and `arity`), for callers that assemble trees from catalog combinators — e.g.
 *  the MicroHs post-processor building Scott numerals/lists and substituting
 *  primitives. Throws on an unknown symbol. */
export function named(sym: string): Node {
  return mk(sym);
}

/** Optimize-mode reduction rules by symbol (catalog-driven). `reduce.ts` uses
 *  these in `fast` mode to reduce a saturated named combinator by its law in one
 *  step, instead of unfolding its SKI def and grinding ι/S/K/I. No entry → that
 *  symbol reduces the raw way (so I/K/S/ι and undiscovered combinators are
 *  unaffected, and raw SKI play is exactly as before). */
export const RULES: Record<string, (args: Node[]) => Node> = Object.fromEntries(
  CATALOG.flatMap((l) => (l.rule ? [[l.sym, l.rule] as const] : [])),
);

/** Zoo (field-guide) metadata for a combinator: its Smullyan bird name (if any), a
 *  short description of what it does, and the formula it's built from. */
export interface Meta {
  bird?: string;
  blurb: string;
  recipe: string;
}

export const META: Record<string, Meta> = {
  "(+)": { blurb: "Addition on Scott numerals. A Scott number can't fold the way a Church numeral does, so this recurses through the Sage Y: peel one S off the first number, and wrap the answer in that many S's.", recipe: "Y (λr m n. m n (λp. S (r p n)))" },
  "(-)": { blurb: "Truncated subtraction (monus): m minus n, clamped at zero. Peel S off n, applying Pred to m each time. Recursive via Y — Scott data carries no built-in fold.", recipe: "Y (λr m n. n m (λp. Pred (r m p)))" },
  "(*)": { blurb: "Multiplication on Scott numerals: add n to itself m times, recursing through the Sage Y.", recipe: "Y (λr m n. m Z (λp. n + r p n))" },
  "(==)": { blurb: "Equality on Scott numerals, returning a Scott Boolean. Peels one S off each side in lock-step (recursing via Y): equal only if both bottom out at Z together. A Char is its ASCII numeral, so char equality is exactly this.", recipe: "Y (λr m n. m (n True (λq. False)) (λp. n False (λq. r p q)))" },
  "(/=)": { blurb: "Inequality — the negation of (==). Computes m == n and flips the resulting Boolean.", recipe: "λm n. not (m == n)" },
  "(<)": { blurb: "Strict less-than on Scott numerals → a Scott Boolean. Nothing is below zero; zero is below any successor; otherwise peel one S off each and recurse via Y. Char order (alphabetical for letters) is this on ASCII codes.", recipe: "Y (λr m n. n False (λq. m True (λp. r p q)))" },
  "(<=)": { blurb: "Less-than-or-equal on Scott numerals → a Scott Boolean. Zero is ≤ anything; a successor is > zero; otherwise peel and recurse via Y.", recipe: "Y (λr m n. m True (λp. n False (λq. r p q)))" },
  "(>)": { blurb: "Greater-than: the Cardinal-flipped less-than, m > n = n < m.", recipe: "C (<)" },
  "(>=)": { blurb: "Greater-than-or-equal: the Cardinal-flipped (<=), m >= n = n <= m.", recipe: "C (<=)" },
  compare: { blurb: "Three-way comparison of two Scott numerals, yielding an Ordering (LT, EQ or GT). Peels one S off each in lock-step via Y; whichever bottoms out first decides. The basis for sorting.", recipe: "Y (λr m n. m (n EQ (λq. LT)) (λp. n GT (λq. r p q)))" },
  LT: { blurb: "The 'less-than' Ordering: a three-armed case that selects its first branch. Returned by compare when the left operand is smaller.", recipe: "λl e g. l" },
  EQ: { blurb: "The 'equal' Ordering: selects its second (middle) branch. Returned by compare when the operands are equal.", recipe: "λl e g. e" },
  GT: { blurb: "The 'greater-than' Ordering: selects its third branch. Returned by compare when the left operand is larger.", recipe: "λl e g. g" },
  Succ: { blurb: "The successor: S, the second Nat constructor. It simply remembers its predecessor (Succ n = λz s. s n), so the number 3 is just S (S (S Z)).", recipe: "λn z s. s n" },
  Pred: { blurb: "The predecessor, and under the Scott encoding it is trivial: a number is a case on Z / S, so Pred just hands back the stored predecessor (and leaves Z at Z). The famous Church-numeral dentist-chair trick is gone — Scott pays the cost at construction instead.", recipe: "λm. m Z I" },
  cons: { blurb: "Prepends a head onto a list. A Scott cons cell stores its head and tail and, when matched, hands them to the cons branch (cons h t = λn c. c h t) — there is no fold built in, unlike the Church encoding.", recipe: "λh t n c. c h t" },
  head: { blurb: "Takes the first element of a list (or the empty list, if there is none). It matches the list with the Kestrel as the cons branch — K keeps the head, drops the tail — and a default for the empty case.", recipe: "λxs. xs nil K" },
  uncons: { blurb: "Splits a non-empty list into its head and tail, paired together with the Vireo. Under Scott both halves are already to hand in the cons cell, so it is a single clean case — no rebuilding.", recipe: "λxs. xs (nil,nil) (λh t. (h, t))" },
  tail: { blurb: "Drops the first element and returns the rest. Under the Scott encoding this is trivial — the tail sits right there in the cons cell, so tail just reads it off (the cons branch is `λh t. t`). The Church encoding's pair-shuffling tail is gone.", recipe: "λxs. xs nil (λh t. t)" },
  "<>": { blurb: "Appends one list onto another (xs ++ ys) — the Semigroup of lists. Scott lists carry no fold, so it recurses via the Sage Y, re-consing each head of xs onto the growing result.", recipe: "Y (λr xs ys. xs ys (λh t. h : r t ys))" },
  concat: { blurb: "Flattens a list of lists, [[a]] down to [a], by appending them in turn — the list monad's join. Recursive via Y.", recipe: "Y (λr xss. xss [] (λh t. h <> r t))" },
  map: { blurb: "Applies a function to every element, building a fresh list. With no built-in fold under Scott, it recurses via Y, re-consing each transformed head onto the rest.", recipe: "Y (λr f xs. xs [] (λh t. f h : r f t))" },
  null: { blurb: "Tests whether a list is empty, answering with a Scott Boolean. The empty list returns True; any cons cell returns False.", recipe: "λxs. xs True (λh t. False)" },
  not: { blurb: "Logical NOT on Scott Booleans: it matches the boolean and returns the opposite constructor (not b = b True False).", recipe: "λb. b True False" },
  and: { blurb: "Logical AND on Scott Booleans: if the first is False it answers False, otherwise it answers the second (and p q = p False q).", recipe: "λp q. p False q" },
  or: { blurb: "Logical OR on Scott Booleans: if the first is True it answers True, otherwise it answers the second (or p q = p q True).", recipe: "λp q. p q True" },
  ι: { blurb: "The universal combinator: every other bird grows from it alone — hand it to itself and the Identity bird hatches, keep nesting and out come the Kestrel, then the Starling. Linguist Chris Barker coined it in 2001 and named it for iota, the smallest letter of the Greek alphabet — the smallest possible seed for the calculus.", recipe: "primitive" },
  A: { bird: "Albatross", blurb: "Always answers with its second argument, throwing the first away — the mirror of the Kestrel. Under the Scott encoding that makes it Boolean True (the second of two case branches) and a pair's second projection (snd). It is simply the Kestrel handed an Identity bird; here it takes the letter A and the Albatross.", recipe: "K I" },
  B: { bird: "Bluebird", blurb: "The forest's composition law: it feeds one function's result straight into another. Curry gave it the letter B — relettering Schönfinkel's original composition combinator — and the Bluebird heads a whole dynasty of composers: the Blackbird, Bunting and Becard all grow from it.", recipe: "S (K S) K" },
  B1: { bird: "Blackbird", blurb: "The Blackbird stretches the Bluebird's reach, composing a function after a three-argument one. Woven from three Bluebirds, it is one of a clutch of B-birds named for the composition family they belong to.", recipe: "B B B" },
  B2: { bird: "Bunting", blurb: "The Bunting reaches a step past the Blackbird, composing a function after a four-argument one. Like its kin it is pure Bluebird — another B-named rung on the composition ladder.", recipe: "B B (B B B)" },
  B3: { bird: "Becard", blurb: "The Becard chains functions in sequence, threading a value through three of them in turn. Another all-Bluebird composer, it takes its B for the family and the bird's own initial.", recipe: "B (B B) B" },
  C: { bird: "Cardinal", blurb: "The Cardinal flips its next two arguments — which is exactly the Scott boolean conditional `if c t e = c e t`. Curry assigned the letter C, relettering Schönfinkel's interchange combinator, and matched it to the cardinal. The Thrush falls out when its first argument is the Identity.", recipe: "S (S (K B) S) (K K)" },
  D: { bird: "Dove", blurb: "The Dove is a Bluebird reaching one slot deeper, composing into a binary function's second argument. It is two Bluebirds stacked; the name is simply a D-bird for Curry's letter.", recipe: "B B" },
  E: { bird: "Eagle", blurb: "The Eagle stretches the Dove's pattern wider, onto a binary function whose second argument is a three-way application. Pure Bluebird inside — an E-bird for its letter.", recipe: "B (B B B)" },
  F: { bird: "Finch", blurb: "The Finch fully reverses three arguments, last-first. It is the Cardinal's flip laid over the pairing Vireo, read backwards — an F-bird for the conventional letter.", recipe: "C V" },
  G: { bird: "Goldfinch", blurb: "The Goldfinch sends its last argument straight through while routing the earlier ones via a second function — composition wedded to a swap, built from two Bluebirds and a Cardinal. A G-bird for the letter.", recipe: "B B C" },
  H: { bird: "Hummingbird", blurb: "The Hummingbird hands a function two arguments, then slips the first back in at the tail — a Warbler's knack for reuse wrapped in a Bluebird and a Cardinal. Smullyan named it to fit the letter H.", recipe: "B W (B C)" },
  I: { bird: "Identity (Idiot Bird)", blurb: "The do-nothing bird — it answers with exactly the bird it was handed. Its letter comes from Schönfinkel's Identitätsfunktion, one of the few names Curry left untouched. The Starling and Kestrel can rebuild it, so it survives only because it keeps things readable; here it hatches when ι hears itself.", recipe: "ι ι" },
  J: { bird: "Jay", blurb: "The Jay duplicates its first argument deep inside a four-way application, feeding it in twice while reshuffling the rest — a trick it owes to the Warbler and the Bluebird. Smullyan named it the Jay, a J-bird; this is the forest's canonical Jay.", recipe: "λx y z w. x y (x w z)" },
  K: { bird: "Kestrel", blurb: "The constant bird: it answers with its first argument and forgets the second. Under the Scott encoding that one combinator is the empty list nil, the number zero (Z), Boolean False, and a pair's first projection (fst) — the value every trivial case collapses onto. Its letter is Schönfinkel's Konstanzfunktion; Smullyan matched it to the kestrel, beside the Starling.", recipe: "primitive" },
  L: { bird: "Lark", blurb: "The Lark composes a function with self-application — a Cardinal, Bluebird and Mockingbird in concert. Pair a Lark with an Identity bird and a Mockingbird hatches; fed to one another, Larks grow the fixpoint-making Sage. An L-bird for its letter.", recipe: "C B M" },
  M: { bird: "Mockingbird", blurb: "The forest's namesake, woven from a Starling and two Identity birds: it echoes its argument back, applied to itself. A mockingbird mimics other birds' songs — exactly what M does — so Smullyan gave it the title role. That self-application sparks recursion (and, fed itself, never settles).", recipe: "S I I" },
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
  X: { bird: "Xenops", blurb: "A duplicator that hands its first argument to its second and then back to itself (`x y x`), built from a pair of Starlings and a Kestrel. X is no classical combinator letter, so it borrows the Xenops, one of the very few birds whose name begins with X.", recipe: "S S K" },
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
  "(+)": "Scott numbers don't fold, so recurse with Y: Y (λr m n. m n (λp. S (r p n))) — peel one S off m and wrap the result in one more S.",
  "(-)": "Recurse with Y: Y (λr m n. n m (λp. Pred (r m p))) — peel S off n, Pred-ing m each time; matching Z bottoms out, clamped at zero.",
  "(*)": "Repeated addition: Y (λr m n. m Z (λp. n + r p n)) — add n once per S in m.",
  "<>": "Scott lists carry no fold, so recurse with Y: append matches xs — [] gives ys, (h:t) re-conses h onto (t <> ys).",
  A: "Feed the Kestrel an Identity bird as its FIRST argument (K I): K keeps that I, which then returns your second argument and drops the first.",
  B: "Composition — pipe one bird's output into the next. Build it by feeding the Starling two args: (K S) then a Kestrel, giving S(KS)K.",
  B1: "Stretch the Bluebird to swallow a 3-arg call: perch a Bluebird on a Bluebird on a Bluebird — B B B, the Blackbird.",
  B2: "The Blackbird B B B composes after a 3-arg function; chain one more Bluebird onto it, B B (B B B), to reach the 4-arg Bunting.",
  B3: "Compose three in a row, x(y(zw)): take the deep composer B and pre-feed it B with B B, giving B(B B)B — the Becard.",
  C: "The Cardinal swaps its 2nd and 3rd arguments (the Scott `if c t e = c e t`); coax it from two Starlings and Kestrels caging a Bluebird: S(S(KB)S)(KK).",
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
  Pred: "Trivial under Scott — hand back the stored predecessor, leaving Z at Z: λm. m Z I.",
  Q: "Build C B: the Cardinal flips the Bluebird's first two args so the first function runs and pours into the second — x z first, then y over it (y (x z)).",
  Q1: "Quixotic feeds arg three onto arg two, then runs the first over the result (x (z y)): give the Queer bird (C B) a Thrush, then frame it with two Bluebirds — B (C B T) B.",
  Q2: "Run the third function on arg1, then the second over that — hang a Thrush under the Queer bird via a Bluebird: B (C B) T.",
  Q3: "Quirky is the leanest Queer cousin: hand x its arg y, then let the third bird z pounce on the result (x y) — compose Bluebird before Thrush: B T.",
  Q4: "Take Quirky B T (gives z(xy)); prepend a Cardinal to flip the inner pair: C (B T) yields z(yx) — last bird run on second-applied-to-first.",
  R: "The Robin rotates three args, sending the first to the back — two Cardinal swaps make one turn, so perch a Cardinal on itself: C C.",
  S: "The Starling shares one arg with two birds. It's just one ι past the Kestrel — ι(ι(ι(ι ι))).",
  Succ: "S, the second Nat constructor: it just stores its predecessor — λn z s. s n. Then 3 is S (S (S Z)).",
  T: "Thrush flips its two args (T x y = y x). The Cardinal C x y z = x z y already does the swap, so put Identity in its first slot: C I.",
  U: "Build U as S (K (S I)) (W I): S hands x to W I, which doubles it to x x, and to the K-guarded S I; then U U is Turing's fixpoint.",
  V: "Build V (Vireo) as B C (C I): the Bluebird composes the Cardinal with the Thrush (C I), so V x y z reduces to z x y — a swap then a flip.",
  W: "Warbler the duplicator: feed Starling two things, Starling itself and a Kestrel-guarded Identity (S S (K I)), to copy its last argument.",
  X: "Feed a Starling to a Starling and a Kestrel — S applied to (S, K) — and it reduces x y x: x runs on y, then falls back to x.",
  Y: "The Sage gives each bird its fixed point: Bluebird-compose a Mockingbird onto a Lark, with the Lark spelled C B M — so B M (C B M).",
  Z: "Perch a Bluebird on a Kestrel (B K): B hands x its single argument y, then the Kestrel quietly swallows the trailing third, z.",
  Z2: "Compose a Bluebird onto Z (B Z): the same trailing-argument-swallowing trick reaching one rung deeper, dropping the fourth argument instead of the third.",
  and: "Match the first boolean: λp q. p False q — if p is False answer False, otherwise answer q.",
  concat: "Recurse with Y, appending each sublist onto the rest: Y (λr xss. xss [] (λh t. h <> r t)).",
  cons: "A Scott cons cell just stores its head and tail for the cons branch to read: λh t n c. c h t.",
  head: "Match the list with the Kestrel as the cons branch (K keeps the head, drops the tail): λxs. xs nil K.",
  map: "No fold under Scott, so recurse with Y, re-consing f h each step: Y (λr f xs. xs [] (λh t. f h : r f t)).",
  not: "Match the boolean and swap the branches: λb. b True False.",
  null: "Match the list: the empty case gives True, any cons cell gives False — λxs. xs True (λh t. False).",
  or: "Match the first boolean: λp q. p q True — if p is True answer True, otherwise answer q.",
  tail: "Trivial under Scott — the tail is stored in the cons cell, so read it straight off: λxs. xs nil (λh t. t).",
  uncons: "Both halves sit in the cons cell; pair them with the Vireo: λxs. xs (nil,nil) (λh t. (h, t)).",
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
const ARITH_OPS = new Set(["Succ", "Pred", "(+)", "(-)", "(*)", "(==)", "(/=)", "(<)", "(<=)", "(>)", "(>=)", "compare", "LT", "EQ", "GT"]);
const LIST_OPS = new Set(["cons", "head", "tail", "<>", "concat", "map", "null", "uncons"]);
const BOOL_OPS = new Set(["not", "and", "or"]);

/** The pages, shared by the Zoo catalogue and the hotbar. "Programs" holds the
 *  general-purpose combinators; the topic pages re-present combinators (often the
 *  same birds) under the role they play there. */
export const PAGES: PageDef[] = [
  {
    name: "Programs",
    entries: [{ sym: "ι" }, ...CATALOG.filter((l) => !ARITH_OPS.has(l.sym) && !LIST_OPS.has(l.sym) && !BOOL_OPS.has(l.sym)).map((l) => ({ sym: l.sym }))],
  },
  {
    name: "Booleans",
    entries: [
      { sym: "K", alias: "False", role: "Scott False — selects the first (else) arm" },
      { sym: "A", alias: "True", role: "Scott True (= K I) — selects the second (then) arm" },
      { sym: "not", alias: "Not", role: "flips a boolean" },
      { sym: "and", alias: "And", role: "true only when both are true" },
      { sym: "or", alias: "Or", role: "true when either is true" },
      { sym: "C", alias: "If", role: "`if c t e = c e t` — the Cardinal is the Scott boolean case" },
    ],
  },
  {
    name: "Arithmetic",
    entries: [
      { sym: "K", alias: "0", role: "Scott zero (Z) — also nil and false" },
      { sym: "Succ", alias: "Succ", role: "S — wraps a number as its own successor" },
      { sym: "Pred", alias: "Pred", role: "strips one successor (Z stays Z)" },
      { sym: "(+)", alias: "Plus", role: "adds two numerals (recurses via Y)" },
      { sym: "(-)", alias: "Sub", role: "truncated subtraction / monus (recurses via Y)" },
      { sym: "(*)", alias: "Mult", role: "multiplies (recurses via Y)" },
      { sym: "(==)", alias: "==", role: "numeral equality → Bool (recurses via Y)" },
      { sym: "(/=)", alias: "/=", role: "numeral inequality → Bool" },
      { sym: "(<)", alias: "<", role: "strict less-than → Bool" },
      { sym: "(<=)", alias: "<=", role: "less-than-or-equal → Bool" },
      { sym: "(>)", alias: ">", role: "strict greater-than → Bool" },
      { sym: "(>=)", alias: ">=", role: "greater-than-or-equal → Bool" },
      { sym: "compare", alias: "compare", role: "three-way comparison → LT | EQ | GT" },
      { sym: "LT", alias: "LT", role: "Ordering: the left operand is smaller" },
      { sym: "EQ", alias: "EQ", role: "Ordering: the operands are equal" },
      { sym: "GT", alias: "GT", role: "Ordering: the left operand is larger" },
    ],
  },
  {
    name: "Char",
    entries: [
      { sym: "Succ", alias: "Succ", role: "a Char is its ASCII code — 'A' is 65, built with Succ from 0" },
      { sym: "I", alias: "chr/ord", role: "Char ≡ Int, so chr and ord are both just the identity" },
      { sym: "(==)", alias: "==", role: "char equality is numeral equality" },
      { sym: "(/=)", alias: "/=", role: "char inequality" },
      { sym: "(<)", alias: "<", role: "char order is numeral order (alphabetical for letters)" },
      { sym: "(<=)", alias: "<=", role: "char ≤" },
      { sym: "compare", alias: "compare", role: "three-way char comparison → LT | EQ | GT" },
    ],
  },
  {
    name: "Lists",
    entries: [
      { sym: "K", alias: "nil", role: "the empty list ([]) — also zero and false" },
      { sym: "cons", alias: "cons", role: "the Scott cons cell: (h:t) = λn c. c h t" },
      { sym: "head", alias: "head", role: "the first element" },
      { sym: "tail", alias: "tail", role: "everything after the head (a trivial read under Scott)" },
      { sym: "uncons", alias: "uncons", role: "splits a list into (head, tail)" },
      { sym: "null", alias: "null", role: "is the list empty?" },
      { sym: "<>", alias: "<>", role: "appends one list onto another (Semigroup, recurses via Y)" },
      { sym: "concat", alias: "concat", role: "flattens a list of lists (recurses via Y)" },
      { sym: "map", alias: "map", role: "applies a function to every element (recurses via Y)" },
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

/** Barker bit-code of a pure-ι tree (`1` = ι, `0 <fn> <arg>` = app). */
const encodeIota = (n: Node): string => (n.kind === "app" ? "0" + encodeIota(n.fn) + encodeIota(n.arg) : "1");

/** Each combinator's full ι-tree as a bit-code, for the "expand everything to ι"
 *  view — keyed by symbol (includes the transient I/K/S). */
export const IOTA_BITCODE: Record<string, string> = Object.fromEntries(CATALOG.map((l) => [l.sym, encodeIota(iotaTreeOf(l))]));

/** Expand a term into its DISPLAY form: undiscovered S/K/I become their ι-trees (the discovery
 *  mask), and — when `expandAll` — every combinator becomes its full ι-tree. Memoised by id so a
 *  shared subterm (graph mode) expands once (the display stays a DAG). Pure: the predicates are
 *  injected. Shared by the 2D tree and the 3D sphere so they render the same thing. */
export function expandDisplay(root: Node, opts: { expandAll: boolean; isDiscovered: (sym: string) => boolean }): Node {
  const memo = new Map<NodeId, Node>();
  const go = (n: Node): Node => {
    const hit = memo.get(n.id);
    if (hit) return hit;
    let out: Node;
    switch (n.kind) {
      case "comb": {
        const code = opts.expandAll ? IOTA_BITCODE[n.sym] : !opts.isDiscovered(n.sym) ? IOTA_CODE[n.sym] : undefined;
        out = code ? iotaTreeFrom(code, n.id) : n;
        break;
      }
      case "app":
        out = { ...n, fn: go(n.fn), arg: go(n.arg) };
        break;
      default:
        out = n;
    }
    memo.set(n.id, out);
    return out;
  };
  return go(root);
}
