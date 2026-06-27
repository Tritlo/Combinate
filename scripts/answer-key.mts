/**
 * SKI-Quest answer key + regression test.
 *
 * Maps *supported* puzzles (see {@link isSupported}) to a solution source — a SKI-Quest
 * expression — and asserts the case engine ({@link makeGoal}) accepts each. This is the
 * committed replacement for the old throwaway scratchpad key (which was lost): run it to
 * prove every recorded solution still satisfies its puzzle, so an engine change that
 * breaks one fails loudly.
 *
 *   npx tsx scripts/answer-key.mts          # verify; exits non-zero on any regression
 *   npx tsx scripts/answer-key.mts --list   # also list the still-uncovered puzzles
 *
 * Pure: runs on Combinate's own reducer over the vendored `src/core/skiq/data.ts`, no
 * network, no `/tmp`. Solutions are SKI-Quest source (the same language the player
 * types): combinators by name, `->` lambdas, juxtaposition for application.
 *
 * Coverage is a partial reconstruction (the original key was lost): the two hard ones
 * were reverse-engineered, the Church-arithmetic ones authored, and the bird-combinator
 * ones auto-recovered by search. The lambda/recursion-heavy puzzles are still
 * `uncovered` (listed with --list) and can be backfilled; gcd is `PENDING` on kernels.
 */
import { SKIQ_CHAPTERS } from "../src/core/skiq/data";
import { makeGoal, isSupported, buildEnvScope, type Puzzle } from "../src/core/skiq/engine";
import { parseExpr, type Scope } from "../src/core/skiq/parse";

// A solution may reference the puzzle's env combinators (e.g. `M A` for "I from M,T,A,B"),
// so parse it in the puzzle's env scope (empty for env-less puzzles).
const scopeFor = (p: Puzzle): Scope => {
  const env = buildEnvScope(p.env);
  return (name) => env.get(name) ?? null;
};

/** puzzle id → a solution source verified to satisfy `makeGoal`. */
const SOLUTIONS: Record<string, string> = {
  // — reverse-engineered this session —
  // Identity but later: `B C C a b = C(C a) b` is a normal form (a, b never merged),
  // and `B C C a b c → C(C a) b c → C a c b → a b c`. (η-long `λabc.abc`/`I` diverge.)
  BzhFzwua: "B C C",
  // Plan first / if: `c x` (→ K/KI) selects `t x` vs `e x`.
  uvtknMlN: "c -> t -> e -> x -> c x (t x) (e x)",
  // gcd — kernel-assisted (ADR 11): Euclid (Y + iszero) over a pure Church `cmod` kernel.
  // Raw Church Euclid is over budget; the native `cmod` makes each step O(1).
  u1Sr43PU: "Y (g -> m -> n -> (m (K (KI)) K) n (g (cmod n m) m))",
  // — combinator constructions (unrestricted): the λ from the case —
  DADG8des: "f -> g -> h -> x -> f (g (h x))", // f(g(h x)) (env f,g,h)
  T89a9q7G: "x -> y -> z -> t -> t", // ignore 3, return the 4th
  WhYIkSJR: "a -> b -> c -> d -> d a b c", // v3
  EuOQExqe: "a -> b -> c -> a (c b)", // Q1
  xAqffqWv: "a -> b -> c -> b (c a)", // Q2
  DAGc1HC2: "a -> b -> c -> c (b a)", // Q4
  xWDGLJvA: "a -> b -> c -> d -> a b (a d c)", // J
  E2nhX4bs: "head -> tail -> f -> x -> f head (tail f x)", // fold-cons
  // — fold-list ops · pairs (V) · booleans · recursion (Y) — authored —
  YAN4Mxrt: "b -> b S K", // x -> x(S)(K)
  Uu9HxTCJ: "p -> q -> t -> f -> p (q f t) t", // nand
  fWb8i2Gg: "f -> p -> p (a -> b -> x -> x (f a) (f b))", // pair map
  NmPkROHm: "f -> g -> p -> p (a -> b -> f a (g b))", // f a (g b) over a pair
  gjDIpuTl: "f -> g -> p -> p (a -> b -> x -> x (f a b) (g a b))", // pair transform
  A4fAPvZb: "f -> d -> arg -> arg (a -> b -> K (f a b)) d", // maybe/pattern-match
  u27lZ0cN: "l -> l (K (S B)) (K I)", // len = fold succ over 0 (succ = S B, 0 = K I)
  uGAfI2SW: "xs -> ys -> f -> x -> xs f (ys f x)", // cat (fold-list append)
  e1NlHHr6: "f -> xs -> xs (a -> r -> g -> y -> g (f a) (r g y)) (K I)", // map
  RtjKvs82: "xs -> xs (a -> r -> f -> x -> r f (f a x)) (K I)", // reverse
  BkuOGuwe: "n -> f -> x -> n (g -> h -> h (g f)) (u -> x) (u -> u)", // Church predecessor
  "3JcMqUYU": "Y (self -> n -> x -> x (self (S B n)) n) (K I)", // count K's before KI
  Z5FPLOrV: "Y K", // quine: q x = q
  TdfaCuW3: "Y (self -> x -> x self)", // crawl: f x = x f
  // — restricted-basis builds (only the allowed/env combinators) —
  NPQ1PIwx: "B (B W) B", // a(b c)c, from B,C,K,I,W
  TNgeTiRp: "M A", // I, from M,T,A,B (M A = (K I)(K I) = I)
  Jv13RWtU: "B (T B) K", // I, from B,K,T
  lphEyMXf: "J I I", // T x y = y x, from J,I
  "7gLQo32W": "J I", // Q1 x y z = x(z y), from J,I
  "4e3mymsq": "X X", // I, from the universal X
  XUVE0eoI: "X (X X)", // omit-first, from X
  "63bwJwPZ": "X (X (X X))", // K, from X
  QqpxVpZk: "X (X (X (X X)))", // S, from X
  // — V-pair (Scott) linked-list ops + fixed points —
  bMdsUR5U: "z -> x -> y -> z (a -> b -> K y) x", // is_empty (K for nil, KI for a pair)
  "5yxwDzNg": "z -> z (a -> b -> K b) (K I)", // failsafe tail (pair → b, nil → nil)
  VvbGJqE1: "Y (self -> z -> f -> x -> z (a -> b -> K (f a (self b f x))) x)", // fold
  SltEHvuL: "xs -> xs (a -> p -> s -> s (lst a (p K)) (p K)) (s -> s nil nil) (K I)", // tail (fold-list)
  "2vWAfjsP": "Y K", // K x = x  (the K-fixed-point is the quine)
  "1fz2DwNy": "Y T", // T x = x
  bmXggXLn: "xs -> (xs (a -> r -> f -> x -> r f (f a x)) (K I)) (a -> r -> a) nil", // last = head ∘ reverse
  EPtKyvC9: "tail=xs->xs (a->p->s->s (lst a (p K)) (p K)) (s->s nil nil) (K I); head=xs->xs (a->r->a) nil; n -> xs -> head (n tail xs)", // nth = head ∘ drop n
  // — Church numerics via the pair-iteration trick (counter, accumulator) —
  l79rFZSF: "V=u->v->s->s u v; mul=m->n->f->m(n f); one=f->x->f x; n -> n (p -> V (S B (p K)) (mul (p K) (p (K I)))) (V one one) (K I)", // factorial
  ifb4SqXX: "V=u->v->s->s u v; add=m->n->f->x->m f(n f x); one=f->x->f x; n -> n (p -> V (p (K I)) (add (p K) (p (K I)))) (V (K I) one) K", // fibonacci
  JrSTFmW9: "V=u->v->s->s u v; n -> n (p -> p (r -> g -> g (V (S B r) (K I)) (V r K))) (V (K I) (K I)) K", // n/2
  Rpc0i8ff: "double=n->f->x->n f(n f x); Y (self -> z -> z (b -> rest -> K (b (S B (double (self rest))) (double (self rest)))) (K I))", // little-endian binary → numeral
  // — authored Church arithmetic —
  FYutDKYw: "m -> n -> f -> x -> m f (n f x)", // add
  ZssuKELX: "m -> n -> f -> m (n f)", // mult
  Q3UWpMFt: "m -> n -> n m", // power
  aVXplSUP: "n -> n (K (KI)) K", // is-zero (selector)
  c9RywwUB: "n -> n (b -> b (KI) K) K", // parity (even → K, odd → KI)
  // — auto-recovered bird combinators (verified against makeGoal) —
  O3BfTzg2: "K I",
  UZdEyeiN: "B",
  VbnUGtfn: "T",
  "4LmjXm1E": "C",
  Jz41j8ae: "S I I",
  hiwf2WWz: "W W",
  fvQITKZd: "S I",
  lNUrDS4M: "S K K",
  HQO9AiXx: "B",
  "5zTCoMld": "D B",
  zhxYRTMO: "T",
  LAhD47Yg: "W",
  cKg6FHW9: "W Z",
  WiTB9Xy0: "R",
  Qq7dQfBW: "C",
  glGifOC9: "V",
  EERaTEWg: "W K",
  MH4kIGqY: "C I",
  F9xS85rq: "W I",
  DZgmxmiQ: "B B",
  "3MuxHf1M": "C C",
  FWZDq8fU: "B W B",
  gi5mV965: "B C",
  buOZQ9o7: "Q",
  f6tNnmm1: "B T",
  M3mOh0CW: "D R",
  HRESMOB6: "B M",
  HnLa4AzW: "M L",
  Mls7TePA: "W C",
  "1WLQktu6": "C",
  ZJQC2K3h: "V",
  RQq5xiBV: "M",
  QRVhriTN: "or",
  rARLv86e: "S Q1",
  "6jZEOKHX": "S B",
  azxJgdmk: "M U",
  "8JqqvQtV": "I",
  sCvZqC2r: "I",
  Zlpj8BYe: "I",
  U2xSO7on: "B",
};

/** Supported puzzles deliberately left unsolved, with why. (gcd is now solved — ADR 11.) */
const PENDING: Record<string, string> = {};

const findName = (id: string): string => {
  for (const ch of SKIQ_CHAPTERS) for (const p of ch.content) if (p.id === id) return p.name;
  return id;
};

function passes(p: Puzzle): boolean {
  try {
    return makeGoal(p)(parseExpr(SOLUTIONS[p.id], scopeFor(p)));
  } catch {
    return false;
  }
}

const list = process.argv.includes("--list");
let total = 0,
  solved = 0,
  unsupported = 0;
const failures: string[] = [];
const uncovered: string[] = [];
for (const ch of SKIQ_CHAPTERS) {
  for (const p of ch.content) {
    if (!isSupported(p)) {
      unsupported++;
      continue;
    }
    total++;
    if (p.id in PENDING) continue;
    if (!(p.id in SOLUTIONS)) {
      uncovered.push(`${p.id}  ${p.name.replace(/<[^>]+>/g, "")}`);
      continue;
    }
    if (passes(p)) solved++;
    else failures.push(`${p.id}  ${p.name.replace(/<[^>]+>/g, "")}  →  "${SOLUTIONS[p.id]}"`);
  }
}

const pending = Object.keys(PENDING).length;
console.log(
  `answer key: ${solved}/${total} supported puzzles solved  ` +
    `(${pending} pending-kernels, ${uncovered.length} uncovered, ${unsupported} unsupported · ${failures.length} REGRESSIONS)`,
);
for (const [id, why] of Object.entries(PENDING)) console.log(`  pending: ${id} ${findName(id).replace(/<[^>]+>/g, "")} — ${why}`);
if (list && uncovered.length) console.log("uncovered:\n  " + uncovered.join("\n  "));
if (failures.length) {
  console.error("\nREGRESSIONS — these recorded solutions no longer pass:\n  " + failures.join("\n  "));
  process.exit(1);
}
