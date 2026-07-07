/**
 * The SKI-Quest case engine: turn a puzzle's `cases` into a goal predicate over a
 * built term. Pure — runs on Combinate's own reducer (no native numbers, no second
 * engine). Three kinds of case:
 *
 *  - **reduction equality** `["phi x y", "y"]` — substitute the built term, reduce
 *    both sides to normal form, compare structurally.
 *  - **numeral** `["phi 5 0 + 0", "7"]` — the `+ 0` is SKI-Quest's "read a Church
 *    numeral" idiom; we instead strip it and read the numeral directly (apply to two
 *    fresh markers, count) — pure, no native arithmetic.
 *  - **canonize** (recursion) — terms that never reach a normal form (Y, Z); equal if
 *    they share a reduct (their reduction sequences intersect), or — for self-equal
 *    cases — if the term simply reaches a normal form (a termination/laziness check).
 *
 * `allow` restricts the *named* combinators the source may use; ι (Combinate's one
 * primitive) is always permitted, so `I-I` ("ι only") is the empty named set and
 * every chapter stays solvable from ι.
 */
import { type Node, app, freeVar } from "../term";
import { normalize, step } from "../reduce";
import { structKey } from "../probe";
import { parseExpr, freezeFree, type Scope } from "./parse";

const CAP = 4000; // reduction budget for an equality case; SKI-Quest caps at ~1000
// Numeral readback budget. SKI-Quest reads numerals natively (O(1)); we reduce Church
// arithmetic for real, and factorial(5)=120 alone is ~20k steps — so numeral cases get
// a far larger budget. Only numeric cases pay it; correct terms settle before it.
const NUM_CAP = 60_000;
const DIVERGE_CAP = 8000; // a lower bar for "non-terminating": a finite Church
// approximation (e.g. `C 1000 (KI)` posing as Y, settles at ~7k steps) is seen to
// settle and gets rejected, while a true fixpoint keeps growing and is accepted

// ---- one case, as authored in the chapter JSON ----
type RawCase = unknown[]; // [e1, e2] | [{max?,canonize?,caps?}, e1, e2] | [{caps}, e1]

/** One input the puzzle asks you to build (multi-input puzzles list several). */
interface InputSpec {
  name: string;
  note?: string;
  fancy?: string;
  lambdas?: boolean;
  allow?: string;
}

/** A quest puzzle, as carried verbatim in the vendored SKI-Quest chapter data. */
export interface Puzzle {
  id: string;
  name: string;
  intro: string | string[];
  hint?: string;
  unlock?: string;
  allow?: string;
  env?: string[];
  input: string | InputSpec | InputSpec[];
  cases: RawCase[];
  /** Upstream authoring metadata, ignored here. */
  created_at?: string;
  comment?: string;
}

/** The name of a puzzle's (first) input — the placeholder you build. */
function inputName(input: Puzzle["input"]): string | undefined {
  if (typeof input === "string") return input;
  return Array.isArray(input) ? input[0]?.name : input.name;
}

// ---- numeral reading: apply to two fresh markers and count (Church) ----
function readChurch(n: Node): number | null {
  const applied = app(app(n, freeVar("§f")), freeVar("§x"));
  // `{}` enables always-on kernels (the Church `cmod`, ADR 11) but not the native-value
  // toggles — so a kernel-assisted answer (gcd via Euclid + cmod) reduces under budget,
  // while every other puzzle reduces exactly as before.
  const { term, done } = normalize(applied, NUM_CAP, true, {});
  if (!done) return null;
  let t = term;
  let k = 0;
  while (t.kind === "app" && t.fn.kind === "free" && t.fn.name === "§f") {
    k++;
    t = t.arg;
  }
  return t.kind === "free" && t.name === "§x" ? k : null;
}

// ---- structural / behavioral comparison ----
function nfEqual(n1: Node, n2: Node): boolean {
  const r1 = normalize(n1, CAP, true);
  const r2 = normalize(n2, CAP, true);
  return r1.done && r2.done && structKey(r1.term) === structKey(r2.term);
}

/** For terms that may never reach normal form (Y/Z fixpoints): two terms are equal
 *  iff they share a common reduct (Church–Rosser). Walk both reduction sequences
 *  within a step budget and look for an intersection — `Y f a b c d` reduces *to*
 *  `Y f (a b c d)`, so the sequences meet even though neither settles. */
function canonEqual(n1: Node, n2: Node, maxSteps: number): boolean {
  const seen = new Set<string>();
  let cur: Node | null = n1;
  for (let i = 0; i <= maxSteps && cur; i++) {
    seen.add(structKey(cur));
    cur = step(cur, true);
  }
  cur = n2;
  for (let i = 0; i <= maxSteps && cur; i++) {
    if (seen.has(structKey(cur))) return true;
    cur = step(cur, true);
  }
  return false;
}

// ---- env scope (`["V=BC(CI)", "nil=KI", "f"]`) ----
export function buildEnvScope(env: string[] | undefined): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const entry of env ?? []) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue; // a bare free-variable declaration — parser defaults to free
    const name = entry.slice(0, eq).trim();
    map.set(name, parseExpr(entry.slice(eq + 1), (n) => map.get(n) ?? null));
  }
  return map;
}

// ---- allow ----
// `allow` restricts which *named* combinators the source may use. ι is Combinate's
// one primitive — always on the hotbar, and the only block you start with — so it is
// always permitted; SKI-Quest's `I-I` ("ι only") falls out as the empty named set.
const ALLOW_ALIAS: Record<string, string> = { "I-I": "" };

/** The combinator symbols appearing in the env term definitions. They're the given
 *  building blocks (e.g. `M=WI` supplies W and I), so they're permitted even under a
 *  tight `allow` — when the source uses `M`, the parser splices in `W I`, and `allowOk`
 *  walks the spliced tree, so without this the env basis would reject its own answers. */
function envCombs(env: Map<string, Node>): Set<string> {
  const syms = new Set<string>();
  const walk = (n: Node): void => {
    if (n.kind === "comb") syms.add(n.sym);
    else if (n.kind === "app") { walk(n.fn); walk(n.arg); }
  };
  for (const t of env.values()) walk(t);
  return syms;
}

function allowOk(source: Node, allow: string | undefined, given: Set<string>): boolean {
  if (!allow) return true;
  const allowed = new Set([...(ALLOW_ALIAS[allow] ?? allow).split(""), ...given]);
  let ok = true;
  const walk = (n: Node): void => {
    switch (n.kind) {
      case "comb": if (!allowed.has(n.sym)) ok = false; break;
      case "app": walk(n.fn); walk(n.arg); break;
      default: break; // ι and free variables are always fine
    }
  };
  walk(source);
  return ok;
}

/** Build the goal predicate for a puzzle: given the built (source) tree, does it
 *  satisfy every case (and the `allow` restriction)? */
export function makeGoal(p: Puzzle): (source: Node) => boolean {
  const input = inputName(p.input);
  const env = buildEnvScope(p.env);
  // Bare-name env entries are abstract free variables the solution must consume
  // (e.g. "Join em" gives f, g and wants f(g x)). Combinate builds closed terms, so
  // we lift them to leading arguments of the input: the player builds the composition
  // B and we check `B f g x = f (g x)`. (Defs `name=expr` stay in `env`.)
  const lifted = (p.env ?? []).filter((e) => !e.includes("=")).map((e) => e.trim());
  const given = envCombs(env);
  return (source: Node): boolean => {
    if (!allowOk(source, p.allow, given)) return false;
    const applied = (): Node => lifted.reduce<Node>((acc, v) => app(acc, freeVar(v)), freezeFree(source));
    const scope: Scope = (name) => (name === input ? applied() : env.get(name) ?? null);
    try {
      return p.cases.every((c) => runCase(c, scope));
    } catch {
      return false;
    }
  };
}

function runCase(c: RawCase, scope: Scope): boolean {
  let opts: { canonize?: { max?: number }; caps?: unknown; max?: number } = {};
  let strs = c;
  if (typeof c[0] === "object" && c[0] !== null) {
    opts = c[0] as typeof opts;
    strs = c.slice(1);
  }
  if (opts.caps) return false; // structural-property cases not yet supported — isSupported filters these puzzles out before they reach here; this is the defensive fallback
  const e1 = strs[0] as string;
  const e2 = strs[1] as string;
  // A self-equal case `[e, e]` is a termination / laziness check: `e` must reach a
  // normal form (this is what tells a lazy fixed point `Z f` from an eager `Y f`).
  if (e1.trim() === e2.trim()) return normalize(parseExpr(e1, scope), CAP, true).done;
  if (/^\d+$/.test(e2.trim())) {
    const stripped = e1.replace(/\s*\+\s*0\s*$/, "");
    return readChurch(parseExpr(stripped, scope)) === Number(e2.trim());
  }
  const n1 = parseExpr(e1, scope);
  const n2 = parseExpr(e2, scope);
  // Equality is behavioral ("action on enough arguments"). By Church–Rosser, two
  // terms are equal iff they share a reduct: settle to the same NF, or — for terms
  // that don't settle (a fixed point `Y K`, whose `K x a` and `x a` both reduce back
  // to `x`) — their reduction sequences intersect. This is sound: distinct normal
  // forms can never share a reduct, so it never accepts a genuinely wrong answer.
  const max = opts.canonize?.max ?? opts.max ?? 300;
  if (nfEqual(n1, n2) || canonEqual(n1, n2, max)) return true;
  if (!opts.canonize) return false;
  // genuinely divergent with no common finite reduct (different Y-wrappings of one
  // infinite value) — our reducer can't decide it; accept only if BOTH truly diverge
  // (a settling mismatch is a real failure). The puzzle's NF / self-equal cases gate.
  return !normalize(n1, DIVERGE_CAP, true).done && !normalize(n2, DIVERGE_CAP, true).done;
}

/** Whether Combinate can check this puzzle on its single canvas. Excludes multi-term
 *  builds and structural-property (`caps`) goals — the 4 such puzzles are left out of
 *  the playable chapters (a known gap, noted in the port's commit), not faked. */
export function isSupported(p: Puzzle): boolean {
  if (Array.isArray(p.input) && p.input.length > 1) return false;
  return !p.cases.some((c) => typeof c[0] === "object" && c[0] !== null && "caps" in (c[0] as object));
}
