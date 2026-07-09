import { type Node, type NodeId, app, comb, decode, freeVar, iotaTreeFrom } from "./term";
import { bracket } from "./church";

/**
 * Canonical ι-tree bit-codes (§4) for the combinators that can appear transient
 * during reduction. Used by the view to render an undiscovered S/K/I as its full
 * ι-tree (rather than a placeholder) until it's discovered.
 */
export const IOTA_CODE: Record<string, string> = {
  // The canonical ladder — each rung is ι applied to the previous: I = ιι, A = ι I (= S K),
  // K = ι A, S = ι K (exactly the quest prologue's constructions). Without A's entry here it
  // fell back to skToIota(K I) — a 7-ι picture for a 3-ι bird.
  I: "011",
  A: "01011",
  K: "0101011",
  S: "010101011",
  // Census-born bird (ADR 27): M3's code is its PROVEN-minimal ι-form — certified by
  // exhaustive enumeration + the TS re-proof (spec/minimal-forms.md), canonical from birth.


  M3: "0001010101101010101011011",
  "Ψ": "00010100101010101101100101010110001010010101010110110101001010101011011000100001010101101100010101011110001010101110101011010101101010010101010110110101001010101011011", // 84ι — recipe composition B (S (B B (C B))) B, gate-verified (was 131ι)
  cons: "0001010010101010110110010100101010101101101010110001010010101010110110010000101010110110001010101111000101010111010101101010110001000010101011011000101010111100010101011101010110101011011", // 94ι — recipe composition B (B K) V (was 96ι)
  G: "0001010010101010110110101001010101011011001000010101011011000101010111100010101011101010110101011", // 49ι — recipe composition B B C (was 81ι def-expansion)
  Q4: "000100001010101101100010101011110001010101110101011010101100101001010101011011000101010110010101100101010110110101011", // 59ι — recipe composition C (B T) (was 67ι)
  V: "0001010010101010110110010000101010110110001010101111000101010111010101101010110001000010101011011000101010111100010101011101010110101011011", // 70ι — recipe composition B C (C I) (was 74ι)
  Y: "00010101011001010110001010101101101100010101011000101010110010101101010101101010110010101100010101011011011", // 54ι — Curry's textbook Y, S(K(SII))(S(S(KS)K)(K(SII))); display-only (no NF, never probe-recognized; was 99ι via B M (C B M))
  // The great shrinking (ADR 27/28): every entry below is a CERTIFIED-EQUAL form — proven
  // in TypeScript to share the bird's normal form on fresh variables at its declared arity
  // (equality at n implies equality above; adoption can never change behavior). Minimality
  // is proven by exhaustion where marked; otherwise it is the smallest form the class-DP
  // search has found (32ι bound, minimality modulo bounded-arity congruence). Also extends
  // the discovery mask: undiscovered birds now render as raw ι like S/K/I always did.
  // Adoption rule: the form must also RECOGNIZE within the app's own probe caps — Pred's
  // and tail's minimal forms don't (they need escalated budgets), so they keep their old
  // encodings until probe caps or smaller forms arrive.
  X: "01010101011", // 6ι — proven minimal (≤17ι exhaustion)
  GT: "0010101101011", // 7ι — proven minimal (≤17ι exhaustion)
  B: "0101001010101011011", // 10ι — proven minimal (≤17ι exhaustion)
  W: "0100101010110001010101111", // 13ι — proven minimal (≤17ι exhaustion)
  and: "000101010110010101110101011", // 14ι — proven minimal (≤17ι exhaustion)
  D: "0000101010111101001010101011011", // 16ι — smallest known (was 36ι)
  "1": "00101011000101010110010101110101011", // 18ι — smallest known (was 37ι)
  B1: "0000101010110101010101110101001010101011011", // 22ι — smallest known (was 45ι)
  U: "000101010110010101011001010110010101011011011", // 23ι — smallest known (was 25ι)
  Q: "0000010101011101010101101010010101010110110101011", // 25ι — smallest known (was 36ι)
  head: "000100010101011101010101101100101011001010110101011", // 26ι — smallest known (was 28ι)
  "Φ": "000010101011010101011100101010101100101011010101011", // 26ι — smallest known (was 41ι)
  B3: "00001010101100101010110101010101110101001010101011011", // 27ι — smallest known (was 99ι)
  L: "00101000101010110110101010110010101100010101011011011", // 27ι — smallest known (was 36ι)
  E: "0000101010111000101010110101010101110101001010101011011", // 28ι — smallest known (was 81ι)
  Q3: "0010101011010000101010111010101011001010110010101011011", // 28ι — smallest known (was 38ι)
  B2: "000010101011001000101010111010101011110101001010101011011", // 29ι — smallest known (was 72ι)
  C: "001000010101011011000101010111100010101011101010110101011", // 29ι — smallest known (was 45ι)
  H: "00010101011000010101011110001010101110101011001010110101011", // 30ι — smallest known (was 41ι)
  R: "001010001010101101100010101011101000101010110110101010110101011", // 32ι — smallest known (was 36ι)
};

/** Fewest-STEPS equivalents (the hare to IOTA_CODE's turtle). Minimal ι ≠ minimal steps:
 *  golfed forms can unfold slower (C's 29ι form takes 345 contractions; its 34ι sibling
 *  takes 120). Every entry is TS-certified EQUAL at the declared arity; "fastest" means
 *  fewest-steps KNOWN at the ≤40ι class-DP bound (2026-07-09 hunt, `--smallest 40`) —
 *  a deeper/bigger-budget hunt may still beat these. Gameplay expansion (the expand-all
 *  view, the discovery mask) uses these so unfolds animate snappily; IOTA_CODE stays the
 *  canonical MINIMAL form (golf costs, Barker readouts, the Zoo's default picture). */
export const IOTA_FASTEST_BOUND = 40;

/** Birds whose fastest form runs in ≤ IOTA_FASTEST_BOUND steps: by the live-core theorem
 *  (any term's dead code prunes to a core with iotas ≤ steps, same class, no slower —
 *  Codex-verified), a faster term would have a core inside the searched bound. Their
 *  minimal AND fastest forms are therefore GLOBAL, not bound-qualified — no disclaimer. */
export const IOTA_SETTLED = new Set(["I", "A", "K", "S", "X", "O", "GT", "EQ", "M", "M2", "M3", "Z", "B", "W", "and"]); // the hunt bound the FASTEST claims hold at (see crates/minimal)

/** Measured reduction steps at each bird's declared arity — [minimal form, fastest form] —
 *  from the ≤34ι hunt (the Rust reducer mirrors the app's exactly; parity-verified). Saved
 *  as data so the Zoo never pays a reduction at card-render time. */
export const IOTA_STEPS: Record<string, [number, number]> = {
  G: [409, 198],
  Q4: [426, 164],
  V: [727, 181],
  B1: [126, 104],
  B2: [270, 197],
  B3: [176, 147],
  C: [345, 93],
  D: [76, 54],
  E: [173, 148],
  H: [122, 105],
  Q: [101, 79],
  Q3: [134, 81],
  R: [127, 88],
  W: [33, 32],
  head: [136, 48],
  "Φ": [144, 103],
};

export const IOTA_FASTEST: Record<string, string> = {
  G: "00010101011000101010110010101101010101100010101011001010110101011000101010110010101101010101100010101011001010110101011010101011001010110010101011001010110101011", // 198 steps (vs 409) — the pre-adoption def-form kept as the hare
  Q4: "0001010101100101011001010101100101011001010101101100010101011001010110010101011001010110101011000101010110010101100101010110110101011", // 164 steps (vs 426)
  V: "000101010110001010101100101011010101011000101010110010101101010110001010101100101011010101011000101010110010101100101010110110101011001010110101011", // 181 steps (vs 727)
  B1: "00010101011001001010101110010101101010010101010110110101001010101011011", // 104 steps (vs 126)
  B2: "00001010101101010101011001010001010101101101010101110101001010101011011", // 197 steps (vs 270)
  B3: "000010101011010100010101011011010101011010101011001010110101001010101011011", // 147 steps (vs 176)
  C: "00010101011001010110010100010101011011010101011001010110101011010101011", // 93 steps (vs 345)
  D: "0010101011001010110101001010101011011", // 54 steps (vs 76)
  E: "0010101011001010110000101010110101010101110101001010101011011", // 148 steps (vs 173)
  H: "000101010110010101100010101011010101011001010110101011010001010101110101011", // 105 steps (vs 122)
  Q: "01000101010110110010101100101011010100010101011011010101011", // 79 steps (vs 101)
  Q3: "00101001010101011011000101010110010101100101010110110101011", // 81 steps (vs 134)
  R: "00010101011001010110010101011010101011000101010110010101101010110101011", // 88 steps (vs 127)
  W: "0001010101101010101101011", // 32 steps (vs 33)
  head: "0001010101100010101011011001010110101011001010110101011", // 48 steps (vs 136)
  "Φ": "00010101011001010101011001010110101010110101001010101011011", // 103 steps (vs 144)
};

/** The bitcode gameplay expansion should use for `sym`: fastest when known, else the
 *  canonical minimal. Display/costing surfaces should keep using IOTA_CODE directly. */
export const fastestIotaCode = (sym: string): string | undefined => IOTA_FASTEST[sym] ?? IOTA_CODE[sym];

/**
 * A discoverable combinator law (§7.2). Data only — the probe (probe.ts) tests a
 * term against it behaviorally, and the shell turns a match into a toast +
 * hotbar slot, collapsing the recognized tree into a single named node.
 */
export interface Law {
  /** Combinator symbol, e.g. "I", "K", "B" (Smullyan's bird names). */
  sym: string;
  /** Sym-level short display form (e.g. "+" for `(+)`, "cmp" for `compare`, ":" for `cons`) — the
   *  same short glyph on every page that doesn't override it (see {@link PageEntry.label}). Display
   *  only; never semantic — `sym` stays the identifier for permalinks/probe/mhs/rules. Resolved by
   *  {@link displayLabel}. */
  label?: string;
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
   *  like any other, but the behavioral probe skips it (it is *defined*, not
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
// (the standard algorithm + η, shared with church.ts). Lets each bird's `def` be
// derived from its law, so it is correct by construction. ----
const VARS = ["x", "y", "z", "w", "v", "u"];
/** Bracket-abstract a λ-body over `arity` fresh variables `x y z …` into a closed
 *  S/K/I term — the standard algorithm + η. Used to derive each bird's `def` from
 *  its law, and (exported) to give a player-authored rule its ι/SKI fallback. */
export function lam(arity: number, body: (v: Node[]) => Node): Node {
  const names = VARS.slice(0, arity);
  let t = body(names.map(freeVar));
  for (let i = names.length - 1; i >= 0; i--) t = bracket(names[i], t);
  return t;
}

/** Bracket abstraction over explicitly-named variables (nests, for the bodies
 *  that need captured outer vars — e.g. the recursive list/arithmetic folds).
 *  Exported so tests can author nested-recursive terms (foldr/filter/quicksort)
 *  the same way the catalog derives its defs. */
export function lamN(names: string[], body: (v: Node[]) => Node): Node {
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

// Scott numeral literals: 0 = Z = K; k = Succ (k-1), built as a NAMED Succ chain
// over Z (the same shape mhs's `natTree` emits), so the behavioral refolder can
// name a raw `Succ 0` (whose SKI normal form is `K (S I (K K))`) back to `1`.
const succComb = (): Node => comb("Succ", succDef(), 3); // a named Succ node (structKey `cSucc`), not its raw ι-tree
const natLit = (k: number): Node => {
  let t: Node = zeroDef();
  for (let i = 0; i < k; i++) t = app(succComb(), t);
  return t;
};

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

/**
 * A Scott numeral literal `k` (1..) as a named catalog combinator. A Scott
 * numeral IS a two-arm eliminator — `k z s = s (k-1)` — so it is registered at
 * arity 2 (not as an arity-0 constant): behavioral recognition applies a term to
 * `arity` fresh vars, and `Succ 0` applied to `z s` reduces to `s 0`. Its `def`
 * is the named `Succ` chain, so the tree stays reducible and the refolder names
 * a bare `Succ^k Z` back to `k`.
 */
function numeral(k: number): Law {
  return { sym: String(k), label: String(k), lawText: `${k} z s = s ${k - 1}`, arity: 2, reference: (v) => app(v[1], natLit(k - 1)), def: () => natLit(k) };
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
  { sym: "(+)", label: "+", lawText: "(+) Z n = n;  (+) (S p) n = S (p + n)", arity: 2, reference: noProbe("(+)"), rule: plusRule, def: plusDef }, // Peano addition
  { sym: "(-)", label: "-", lawText: "(-) m Z = m;  (-) m (S p) = Pred (m - p)", arity: 2, reference: noProbe("(-)"), rule: minusRule, def: minusDef }, // Peano monus
  { sym: "(*)", label: "*", lawText: "(*) Z n = Z;  (*) (S p) n = n + (p * n)", arity: 2, reference: noProbe("(*)"), rule: timesRule, def: timesDef }, // Peano product
  { sym: "(==)", label: "==", lawText: "(==) Z Z = True;  (==) (S p) (S q) = p == q;  else False", arity: 2, reference: noProbe("(==)"), rule: eqNatRule, def: eqNatDef }, // Peano equality
  { sym: "(/=)", label: "/=", lawText: "(/=) m n = not (m == n)", arity: 2, reference: noProbe("(/=)"), rule: neNatRule, def: neNatDef },
  { sym: "(<)", label: "<", lawText: "(<) m Z = False;  (<) Z (S q) = True;  (<) (S p) (S q) = p < q", arity: 2, reference: noProbe("(<)"), rule: ltNatRule, def: ltNatDef },
  { sym: "(<=)", label: "<=", lawText: "(<=) Z n = True;  (<=) (S p) Z = False;  (<=) (S p) (S q) = p <= q", arity: 2, reference: noProbe("(<=)"), rule: leNatRule, def: leNatDef },
  { sym: "(>)", label: ">", lawText: "(>) m n = n < m", arity: 2, reference: noProbe("(>)"), rule: gtNatRule, def: gtNatDef },
  { sym: "(>=)", label: ">=", lawText: "(>=) m n = n <= m", arity: 2, reference: noProbe("(>=)"), rule: geNatRule, def: geNatDef },
  { sym: "compare", label: "cmp", lawText: "compare m n = LT | EQ | GT (three-way)", arity: 2, reference: noProbe("compare"), rule: compareRule, def: compareDef },
  bird("LT", "LT l e g = l", 3, (v) => v[0]), // Ordering: less-than
  bird("EQ", "EQ l e g = e", 3, (v) => v[1]), // Ordering: equal
  bird("GT", "GT l e g = g", 3, (v) => v[2]), // Ordering: greater-than
  numeral(1), // Scott 1 = Succ 0
  numeral(2), // Scott 2 = Succ (Succ 0)
  numeral(3), // Scott 3 = Succ (Succ (Succ 0))
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
  bird("M3", "M3 x = x x x", 1, (v) => app(app(v[0], v[0]), v[0])), // Triple Mockingbird — surfaced by the minimal-forms census (ADR 27): enters the pure-ι universe at exactly 13 ι
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
  { ...bird("cons", "cons h t n c = c h t", 4, consBody), label: ":" }, // prepend (Scott cons cell)
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
    def: Yc, // B M (C B M) — the same fixed-point combinator recDef folds recursive birds over
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
  "1": { blurb: "The Scott numeral 1 = Succ 0. As a value it is the two-arm case λz s. s 0 — it hands its predecessor 0 to the successor arm. Its raw ι/SKI form is K (S I (K K)).", recipe: "Succ 0" },
  "2": { blurb: "The Scott numeral 2 = Succ (Succ 0): λz s. s 1, handing its predecessor 1 to the successor arm.", recipe: "Succ (Succ 0)" },
  "3": { blurb: "The Scott numeral 3 = Succ (Succ (Succ 0)): λz s. s 2 — the pivot in `qs [3, 1, 2]`.", recipe: "Succ (Succ (Succ 0))" },
  Pred: { blurb: "The predecessor, and under the Scott encoding it is trivial: a number is a case on Z / S, so Pred just hands back the stored predecessor (and leaves Z at Z). The famous Church-numeral dentist-chair trick is gone — Scott pays the cost at construction instead.", recipe: "λm. m Z I" },
  cons: { blurb: "Prepends a head onto a list. A Scott cons cell stores its head and tail and, when matched, hands them to the cons branch (cons h t = λn c. c h t) — there is no fold built in, unlike the Church encoding.", recipe: "B (B K) V" },
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
  M3: { bird: "Triple Mockingbird", blurb: "The Mockingbird sings its argument back once; its triple cousin sings it thrice — x applied to x applied to x. Smullyan names it, but the raw ι-forest almost doesn't: it enters at exactly 13 leaves, reachable by a single tree shape out of the census's 290 thousand — the rarest song in the book.", recipe: "S M I" },
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
  "Ψ": { bird: "Psittacosaurus", blurb: "The Psi bird applies one function to two separate arguments, then feeds the results to a second that combines them — functional programmers' `on` operator. No bird's name begins with the Greek Ψ, so it borrows a dinosaur: Psittacosaurus, the 'parrot lizard'.", recipe: "B (S (B B (C B))) B" },
};


/** A combinator as it appears on a page: its symbol, an optional topic alias
 *  (e.g. "True" for K) and a one-line note on the role it plays there. */
interface PageEntry {
  sym: string;
  alias?: string;
  role?: string;
  /** Page-scoped override of the short display glyph — beats {@link Law.label} on THIS page only
   *  (e.g. Lists' `K` → "[]", Char's `I` → "chr"; a sym whose short form is the same everywhere
   *  belongs on the Law instead). Purely cosmetic — `sym` stays the semantic identifier
   *  (permalinks, probe, mhs mapping); `alias`/`role` still carry the wordy topic name shown in the
   *  zoo detail pane and the hotbar tooltip. Resolved by {@link displayLabel}. */
  label?: string;
}
/** A named tab grouping combinators (shared by the Zoo and the hotbar). */
export interface PageDef {
  name: string;
  entries: PageEntry[];
}

// Combinators that belong only to a topic page, not to the general "Programs" tab.
const ARITH_OPS = new Set(["1", "2", "3", "Succ", "Pred", "(+)", "(-)", "(*)", "(==)", "(/=)", "(<)", "(<=)", "(>)", "(>=)", "compare", "LT", "EQ", "GT"]);
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
      { sym: "K", alias: "False", label: "False", role: "Scott False — selects the first (else) arm" },
      { sym: "A", alias: "True", label: "True", role: "Scott True (= K I) — selects the second (then) arm" },
      { sym: "not", alias: "Not", role: "flips a boolean" },
      { sym: "and", alias: "And", role: "true only when both are true" },
      { sym: "or", alias: "Or", role: "true when either is true" },
      { sym: "C", alias: "If", role: "`if c t e = c e t` — the Cardinal is the Scott boolean case" },
    ],
  },
  {
    name: "Arithmetic",
    entries: [
      { sym: "K", alias: "0", label: "0", role: "Scott zero (Z) — also nil and false" },
      { sym: "1", alias: "1", role: "Scott 1 = Succ 0 (the two-arm case λz s. s 0)" },
      { sym: "2", alias: "2", role: "Scott 2 = Succ (Succ 0)" },
      { sym: "3", alias: "3", role: "Scott 3 = Succ (Succ (Succ 0))" },
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
    ],
  },
  {
    name: "Ordering",
    entries: [
      { sym: "compare", alias: "compare", role: "three-way comparison → LT | EQ | GT" },
      { sym: "LT", alias: "LT", role: "arm 1 of the three-armed Scott Ordering — the left operand is smaller" },
      { sym: "EQ", alias: "EQ", role: "arm 2 of the three-armed Scott Ordering — the operands are equal" },
      { sym: "GT", alias: "GT", role: "arm 3 of the three-armed Scott Ordering — the left operand is larger" },
    ],
  },
  {
    name: "Char",
    entries: [
      { sym: "Succ", alias: "Succ", role: "a Char is its ASCII code — 'A' is 65, built with Succ from 0" },
      { sym: "I", alias: "chr/ord", label: "chr", role: "Char ≡ Int, so chr and ord are both just the identity" },
      { sym: "(==)", alias: "==", role: "char equality is numeral equality" },
      { sym: "(/=)", alias: "/=", role: "char inequality" },
      { sym: "(<)", alias: "<", role: "char order is numeral order (alphabetical for letters)" },
      { sym: "(<=)", alias: "<=", role: "char ≤" },
      { sym: "compare", alias: "compare", role: "three-way char comparison → LT | EQ | GT (the LT/EQ/GT constructors live on the Ordering tab)" },
    ],
  },
  {
    name: "Lists",
    entries: [
      { sym: "K", alias: "nil", label: "[]", role: "the empty list ([]) — also zero and false" },
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

/**
 * Resolve a combinator's DISPLAYED short name — the one naming model shared by the hotbar cell, the
 * zoo list row, and (page-context-sensitive) the canvas node glyph (ADR 23): a page-scoped override
 * beats the sym-level short form beats the page's wordy alias beats the raw symbol. `sym` itself is
 * never affected — it stays the semantic identifier for permalinks/probe/mhs/rules; this is cosmetic
 * display only. `entry` is the `PageEntry` (or entry-shaped record, e.g. the Zoo's own row) for `sym`
 * on the page in question, or omitted/undefined when there's no page context (or no matching entry).
 */
export function displayLabel(sym: string, entry?: { label?: string; alias?: string }): string {
  return entry?.label ?? LAW_BY_SYM.get(sym)?.label ?? entry?.alias ?? sym;
}

/** Expand a tree into pure ι (the skToIota gadget, §7.3): canonical-coded leaves (I/A/K/S)
 *  become their ι-trees, any OTHER comb expands its def recursively — cycle-guarded, so a
 *  self-referencing def keeps its comb leaf (the tree stays impure and gets no bitcode,
 *  rather than a lying one). Before the recursion, a def leaf outside IOTA_CODE (e.g. Succ
 *  inside a Scott numeral) passed through silently and encodeIota stringified it as "1" —
 *  which made Scott-1's bitcode collide with S's. */
function skToIota(n: Node, expanding: Set<string> = new Set()): Node {
  switch (n.kind) {
    case "comb": {
      if (IOTA_CODE[n.sym]) return decode(IOTA_CODE[n.sym]);
      const law = LAW_BY_SYM.get(n.sym);
      if (!law?.def || expanding.has(n.sym)) return n; // unknown or cyclic → impure leaf
      expanding.add(n.sym);
      const out = skToIota(law.def(), expanding);
      expanding.delete(n.sym);
      return out;
    }
    case "app":
      return app(skToIota(n.fn, expanding), skToIota(n.arg, expanding));
    default:
      return n;
  }
}

/** The pure-ι tree for a law (its picture): I/A/K/S use their canonical code, the
 *  rest expand their SK definition (recursively through named sub-defs). */
export function iotaTreeOf(law: Law): Node {
  return IOTA_CODE[law.sym] ? decode(IOTA_CODE[law.sym]) : skToIota(law.def!());
}

/** Count the ι leaves in a term (the "number of iotas" stat). */
export function countIotas(n: Node): number {
  return n.kind === "app" ? countIotas(n.fn) + countIotas(n.arg) : n.kind === "iota" ? 1 : 0;
}

/** Barker bit-code of a PURE-ι tree (`1` = ι, `0 <fn> <arg>` = app), or undefined if the
 *  tree still contains comb/free leaves — a code must round-trip through decode, so a
 *  non-ι leaf must never be written as "1". */
const tryEncodeIota = (n: Node): string | undefined => {
  if (n.kind === "app") {
    const f = tryEncodeIota(n.fn);
    if (f === undefined) return undefined;
    const a = tryEncodeIota(n.arg);
    return a === undefined ? undefined : "0" + f + a;
  }
  return n.kind === "iota" ? "1" : undefined;
};

/** Each combinator's full ι-tree as a bit-code, for the "expand everything to ι" view —
 *  keyed by symbol (includes the transient I/K/S). A law whose expansion isn't pure ι
 *  (cyclic def) has NO entry; consumers already fall back (expandDisplay keeps the named
 *  node, barkerCode emits the sym, iotaCost charges 0 as for late-authored birds). */
export const IOTA_BITCODE: Record<string, string> = Object.fromEntries(
  CATALOG.flatMap((l) => {
    const bits = tryEncodeIota(iotaTreeOf(l));
    return bits ? [[l.sym, bits] as const] : [];
  }),
);

/** Bounded Barker bit-code of a term *as displayed* (`1` = ι, `0 <fn> <arg>` = app), expanding each
 *  known combinator inline to its full ι-tree bits. A free variable, or a combinator with no
 *  precomputed ι-bitcode (e.g. a user law registered after module load), falls back to its atom — so
 *  an open term stays lossless rather than collapsing every leaf to ι. Streams over the *original*
 *  tree against a char budget (never materialises an expanded ι-tree), so a deep / named-heavy term
 *  can't blow up; a budget overrun is truncated with an ellipsis. */
export function barkerCode(root: Node, maxChars = 4096): string {
  let out = "";
  let truncated = false;
  const emit = (s: string): void => {
    if (truncated) return;
    const room = maxChars - out.length;
    if (s.length > room) {
      out += s.slice(0, room);
      truncated = true;
    } else out += s;
  };
  const go = (n: Node): void => {
    if (truncated) return;
    switch (n.kind) {
      case "iota":
        return emit("1");
      case "app":
        emit("0"), go(n.fn), go(n.arg);
        return;
      case "comb":
        return emit(IOTA_BITCODE[n.sym] ?? n.sym); // known bird → its ι bits; late-authored → its name
      case "free":
        return emit(n.name);
    }
  };
  go(root);
  return truncated ? out + "…" : out;
}

/** Render a term as the player sees its DATA — named combinators (an undiscovered one masks to its
 *  ι-tree, like the s-expression view) plus Scott literal sugar recognized STRUCTURALLY: numerals
 *  (`Succ…K` → an int), non-empty lists (`cons…K` → `[…]`), and booleans — all WITHOUT reducing. So a
 *  term shows its current shape (`((+) 1 1)`), tracking a reduction rather than jumping to the answer.
 *  Application spines are flattened Haskell-style (`f a b`, not `((f a) b)`). A bare `K` is the shared
 *  zero/nil/false, disambiguated by the active read page (`mode`). Streams against a char budget, so a
 *  deep term / shared DAG / cycle truncates with an ellipsis instead of blowing up. */
export function sugar(root: Node, opts: { isDiscovered: (sym: string) => boolean; mode?: string }, maxChars = 4096): string {
  const { isDiscovered, mode } = opts;
  const MAX_NUM = 9999; // a longer Succ-spine isn't worth counting — fall back to structural
  const MAX_LIST = 256; // ditto for a cons-spine
  const MAX_DEPTH = 2000; // recursion bound — a deeper tree truncates rather than overflowing the stack
  let out = "";
  let truncated = false;
  const emit = (s: string): void => {
    if (truncated) return;
    const room = maxChars - out.length;
    if (s.length > room) {
      out += s.slice(0, room);
      truncated = true;
    } else out += s;
  };
  const isComb = (n: Node, sym: string): boolean => n.kind === "comb" && n.sym === sym;
  // `Succ^k K` with k ≥ 1 → k (a bare K is left to the context logic below); else null.
  const asNumeral = (n: Node): number | null => {
    if (!isDiscovered("Succ")) return null;
    let k = 0;
    let cur = n;
    while (cur.kind === "app" && isComb(cur.fn, "Succ")) {
      cur = cur.arg;
      if (++k > MAX_NUM) return null;
    }
    return k >= 1 && isComb(cur, "K") ? k : null;
  };
  // A non-empty, proper `cons h (… K)` spine → its element nodes; else null (bare K / improper tail).
  const asList = (n: Node): Node[] | null => {
    if (!isDiscovered("cons")) return null;
    const elems: Node[] = [];
    let cur = n;
    while (cur.kind === "app" && cur.fn.kind === "app" && isComb(cur.fn.fn, "cons")) {
      elems.push(cur.fn.arg);
      cur = cur.arg;
      if (elems.length > MAX_LIST) return null;
    }
    return elems.length >= 1 && isComb(cur, "K") ? elems : null;
  };
  // Stream a left-nested application spine as `f a b` (no outer parens), emitting incrementally so the
  // char budget bounds it — no pre-collected args array (a huge spine can't allocate unboundedly).
  const spine = (m: Node, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH) return void (truncated = true); // bottomless spine → truncate, don't overflow
    if (m.kind === "app") {
      spine(m.fn, depth + 1);
      emit(" ");
      go(m.arg, depth + 1);
    } else go(m, depth);
  };
  const go = (n: Node, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH) return void (truncated = true);
    const num = asNumeral(n);
    if (num !== null) return emit(String(num));
    const list = asList(n);
    if (list) {
      emit("[");
      list.forEach((e, i) => {
        if (i) emit(", ");
        go(e, depth + 1);
      });
      return emit("]");
    }
    if (mode === "Bool" && n.kind === "app" && isComb(n.fn, "K") && isComb(n.arg, "I")) return emit("true"); // True = K I
    if (isComb(n, "K")) {
      // the shared zero / nil / false — disambiguate by the active read page
      if (mode === "Int") return emit("0");
      if (mode === "List") return emit("[]");
      if (mode === "Bool") return emit("false");
      // else (Programs / Char) fall through to render it as the K combinator
    }
    switch (n.kind) {
      case "iota":
        return emit("ι");
      case "comb": {
        const code = !isDiscovered(n.sym) ? fastestIotaCode(n.sym) : undefined; // undiscovered → its ι-tree (the discovery mask; fastest form — see IOTA_FASTEST)
        return code ? go(decode(code), depth + 1) : emit(n.sym);
      }
      case "free":
        return emit(n.name);
      case "app": // flatten the spine: f a b → (f a b), not (((f) a) b)
        emit("(");
        spine(n, depth + 1);
        return emit(")");
    }
  };
  go(root, 0);
  return truncated ? out + "…" : out;
}

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
        const code = opts.expandAll ? (IOTA_FASTEST[n.sym] ?? IOTA_BITCODE[n.sym]) : !opts.isDiscovered(n.sym) ? fastestIotaCode(n.sym) : undefined;
        // Size cap: honest bitcodes for the recursive data ops are Y-based SKI blobs that can
        // run to thousands of ι — materializing those as display trees would swamp the canvas.
        // Past the cap (barkerCode's budget) the named node stays, like an absent entry.
        out = code && code.length <= 4096 ? iotaTreeFrom(code, n.id) : n;
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
