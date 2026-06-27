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
import { makeGoal, isSupported, type Puzzle } from "../src/core/skiq/engine";
import { parseExpr } from "../src/core/skiq/parse";

const empty = (_: string): null => null;

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
    return makeGoal(p)(parseExpr(SOLUTIONS[p.id], empty));
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
