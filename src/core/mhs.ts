/**
 * MicroHs `toCombinators` closure → Combinate tree, by **post-processing a stock
 * compile** (ADR 0007). No MicroHs fork: the stock Rust MicroHs, given an entry
 * value (the `--entry` flag), returns that value's *pruned, rooted* combinator
 * closure as structured JSON — an ordered `[{name, body}]` over the fixed basis
 * `S K I B C A U Z P R O S' B' C' C'B K2 K3 K4 J Y`, plus *primitive* leaves
 * (`{int}` / `{char}` / `{string}` literals and short `{prim}` tokens for
 * arithmetic / comparison / IO / FFI). This module rewrites that closure into pure ι:
 *
 *   closure ──resolve refs from the root (shared DAG, Y-wrapping self-recursion)──►
 *        ──substitute──► a Combinate tree, where
 *            {int:n}     → the Scott numeral  Succ^n Z   (a Char is its code point)
 *            {string:s}  → the Scott list of its char codes
 *            {prim:"+"}… → the matching Scott combinator (catalog `(+)`, `(<)`, …)
 *            {prim:"S"}… → the basis combinator, expanded to its SKI definition
 *            anything else (Double / Float / IO / FFI / bignum, mutual recursion)
 *                        → an inert `primitive:…` sentinel
 *
 * The substituted Scott combinators come straight from the catalog, so the tree
 * loads via the normal spawn path and reduces (and, in optimize mode, reduces by
 * each combinator's rule — essential, since a Char `'A'` is 65 nested `Succ`s).
 *
 * Rejection is **by reachability, not by text**: a closure mentions primitives we
 * can't encode (e.g. `neg` sits in every `Num` dictionary) even when the program
 * never uses them, so we substitute a sentinel and reject only if one *survives
 * reduction* — i.e. the program actually forces it.
 *
 * Pure: no Pixi / DOM / wasm. The wasm blob that produces the closure lives in the
 * Worker adapter (`../view/mhs/`).
 */

import { type Node, app, comb, exceedsNodes } from "./term";
import { named } from "./catalog";
import { step } from "./reduce";
import { natTree } from "./native";

// ---------------------------------------------------------------------------
// Parse tree: a binary application tree with string leaves.

type Tm = { tag: "lf"; s: string } | { tag: "ap"; a: Tm; b: Tm };
const lf = (s: string): Tm => ({ tag: "lf", s });
const ap = (a: Tm, b: Tm): Tm => ({ tag: "ap", a, b });

// ---------------------------------------------------------------------------
// Tokenizer + parser for parenthesised, left-associative combinator expressions.
// The one consumer is `expandSki`, parsing each basis combinator's `ALGEBRA`
// S/K/I definition string (e.g. `B = "S (K S) K"`). The quoted-string / `#n` atom
// cases are inert leftovers (the basis definitions contain neither).

type Tok = { t: "lp" } | { t: "rp" } | { t: "atom"; s: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isAtom = (c: string) => !/\s/.test(c) && c !== "(" && c !== ")";
  while (i < src.length) {
    const c = src[i];
    if (c === "(") {
      toks.push({ t: "lp" });
      i++;
    } else if (c === ")") {
      toks.push({ t: "rp" });
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '"') {
      // string literal: consume to the matching quote, honouring \-escapes
      let s = '"';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          s += src[i] + src[i + 1];
          i += 2;
        } else {
          s += src[i++];
        }
      }
      s += '"';
      i++; // closing quote
      toks.push({ t: "atom", s });
    } else {
      let s = "";
      while (i < src.length && isAtom(src[i])) s += src[i++];
      toks.push({ t: "atom", s });
    }
  }
  return toks;
}

// A cursor-based recursive-descent parser. `expr := atom | '(' expr+ ')'`.
class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  /** Parse one expression, then left-fold any following expressions as args. */
  apps(): Tm {
    let acc = this.expr();
    for (;;) {
      const t = this.toks[this.i];
      if (!t || t.t === "rp") return acc;
      acc = ap(acc, this.expr());
    }
  }

  private expr(): Tm {
    const t = this.toks[this.i];
    if (!t) throw new Error("mhs parse: unexpected end of input");
    if (t.t === "atom") {
      this.i++;
      return lf(t.s);
    }
    if (t.t === "lp") {
      this.i++;
      const e = this.apps();
      if (this.toks[this.i]?.t !== "rp") throw new Error("mhs parse: expected ')'");
      this.i++;
      return e;
    }
    throw new Error("mhs parse: unexpected ')'");
  }
}

// ---------------------------------------------------------------------------
// The basis: each combinator's arity, S/K/I definition, and the Combinate
// catalog symbol it displays as (chosen so a same-meaning bird reduces correctly
// in optimize mode too). ALGEBRA gives each basis combinator's canonical S/K/I
// expansion, matching MicroHs's own compiler output.

/** S/K/I expansions of the non-atomic basis combinators. */
const ALGEBRA: Record<string, string> = {
  B: "S (K S) K",
  C: "S (B B S) (K K)",
  A: "K I",
  U: "C I",
  Z: "B K",
  P: "B C (C I)",
  R: "C C",
  O: "B (B K) (B C (C I))",
  J: "B K (C I)",
  "S'": "B (B S) B",
  "B'": "B B",
  "C'": "B (B C) B",
  "C'B": "C' B",
  K2: "B K K",
  K3: "B K2 K",
  K4: "B K3 K",
  // Y = BU(CBU) with U = SII (the B/C fixed-point combinator), U expanded.
  Y: "B (S I I) (C B (S I I))",
};

/** Arity of each basis combinator (how many args before it unfolds its def). */
const ARITY: Record<string, number> = {
  S: 3, K: 2, I: 1,
  B: 3, C: 3, A: 2, U: 2, Z: 3, P: 3, R: 3, O: 4,
  "S'": 4, "B'": 4, "C'": 4, "C'B": 4, K2: 3, K3: 4, K4: 5, J: 3, Y: 1,
};

/** Display symbol: remap a MicroHs basis combinator to the Combinate catalog bird
 *  of the same meaning (same algebra definition), so it renders as a known bird
 *  and, where it carries a catalog rule, reduces by that rule in optimize mode.
 *  MicroHs's list cons `(:)` is the `O` combinator (`λh t n c. c h t`), exactly
 *  the catalog `cons` — so a compiled list reads back as a list. */
const SYM: Record<string, string> = { U: "T", P: "V", J: "N", O: "cons", "S'": "Φ", "B'": "D" };

const isAtomicComb = (s: string): boolean => s === "S" || s === "K" || s === "I";
const isBasis = (s: string): boolean => isAtomicComb(s) || s in ALGEBRA;

/** Build the pure S/K/I term a basis combinator expands to, recursively
 *  inlining references in `ALGEBRA` down to S/K/I leaves. */
function expandSki(name: string): Node {
  if (isAtomicComb(name)) return comb(name);
  const def = ALGEBRA[name];
  if (!def) throw new Error(`mhs: unknown basis combinator ${name}`);
  const build = (t: Tm): Node => (t.tag === "ap" ? app(build(t.a), build(t.b)) : expandSki(t.s));
  return build(new Parser(tokenize(def)).apps());
}

/** A named `comb` node for a basis combinator: its display symbol, its S/K/I
 *  definition (so the reducer can unfold it), and its arity. */
function basisNode(name: string): Node {
  if (isAtomicComb(name)) return comb(name); // S/K/I reduce by built-in rules
  return comb(SYM[name] ?? name, expandSki(name), ARITY[name]);
}

// ---------------------------------------------------------------------------
// Term → Combinate tree: primitive sentinels + reachability rejection (shared by
// the `combinatorsToTree` JSON converter below).

/** An inert sentinel for a leaf with no ι form: a `comb` with no def never
 *  reduces, so it stays in the normal form iff the program actually forces it. */
const PRIM_SENTINEL = "primitive:";
const sentinel = (s: string, sink: Set<string>): Node => {
  sink.add(s);
  return comb(PRIM_SENTINEL + s);
};

/** Scan a (reduced) term for surviving primitive sentinels — the primitives the
 *  program actually forces, the genuine ι wall. */
function sentinelsIn(n: Node, found: Set<string>): void {
  switch (n.kind) {
    case "comb":
      if (n.sym.startsWith(PRIM_SENTINEL)) found.add(n.sym.slice(PRIM_SENTINEL.length));
      break;
    case "app":
      sentinelsIn(n.fn, found);
      sentinelsIn(n.arg, found);
      break;
  }
}

/** Honest rejection message for the primitives a program forces. */
function rejectMsg(syms: string[]): string {
  const s = syms[0];
  if (s.startsWith("<rec:")) return `no ι form: mutual recursion via '${s.slice(5, -1)}' has no finite combinator tree`;
  const name = s.replace(/^Primitives\.prim/, "");
  return `no ι form: this program forces '${name}' — IO / FFI / Float / bitwise / negation aren't representable in pure ι (the sandbox is over the naturals)`;
}

/** The result of compiling a dump: a spawnable tree, or a reject reason. */
export type DumpResult = { tree: Node } | { error: string };

const CHECK_STEPS = 6000; // reduction budget for the reachability/reject probe
const CHECK_SIZE = 8000; // tree-size guard: a program that blows past this is left to the shell

/**
 * Reject by reachability: reduce (optimize mode) and see which sentinels remain.
 * A clean program drops the dead ones (e.g. the unused `primIntNeg` in every Num
 * dictionary); one that *forces* a primitive keeps it in the normal form. The
 * probe is bounded by steps *and* tree size: without graph sharing, recursive
 * multiplication blows up (`fac` is exponential), so if the term balloons or the
 * budget runs out we accept and let the shell's capped reduction surface any
 * genuinely-forced primitive. Only a *completed* small reduction is conclusive.
 */
function rejectForcedSentinels(tree: Node, sink: Set<string>): DumpResult {
  if (sink.size > 0) {
    let cur = tree;
    let conclusive = false;
    for (let i = 0; i < CHECK_STEPS; i++) {
      if (exceedsNodes(cur, CHECK_SIZE)) break; // blow-up → inconclusive, accept
      const nx = step(cur, true);
      if (!nx) {
        conclusive = true; // reached normal form within budget
        break;
      }
      cur = nx;
    }
    if (conclusive) {
      const forced = new Set<string>();
      sentinelsIn(cur, forced);
      if (forced.size > 0) return { error: rejectMsg([...forced]) };
    }
  }
  return { tree };
}

// ---------------------------------------------------------------------------
// `toCombinators` (`--entry`) JSON closure → tree — the one compile path (both the
// live worker and the vendored gallery). MicroHs compiles a main-less value module
// and returns the entry's *pruned, rooted* combinator closure as structured JSON
// (see rust/microhs-runtime/docs/javascript-ffi.md). Primitive substitution and
// reachability rejection reuse the basis / sentinel machinery above.

/** A JSON combinator expression from `--entry`. `lam` never appears in compiled
 *  output (defs are bracket-abstracted, recursion pre-`Y`'d) but is in the schema. */
type Expr =
  | { var: string }
  | { app: [Expr, Expr] }
  | { lam: [string, Expr] }
  | { int: number }
  | { int64: number }
  | { integer: string }
  | { double: number }
  | { float: number }
  | { rat: string }
  | { char: string }
  | { string: string }
  | { bstr: string }
  | { prim: string }
  | { forimp: string }
  | { exn: string }
  | { tick: string }
  | { ctype: string };

/** One entry of a `toCombinators` closure: a qualified name and its combinator body. */
export interface CombDef {
  name: string;
  body: Expr;
}

/** JSON primitive tokens (short, from `prims.rs`) for the arithmetic / comparison
 *  ops → the catalog combinator that computes them. Char ops reuse the Int tokens
 *  (Char ≡ Int at runtime). Everything not here and not a basis combinator becomes
 *  a sentinel — rejected iff the program forces it. */
const JSON_PRIM_OP: Record<string, string> = {
  "+": "(+)",
  "-": "(-)", // truncated subtraction (monus) — naturals only
  "*": "(*)",
  "==": "(==)",
  "/=": "(/=)",
  "<": "(<)",
  "<=": "(<=)",
  ">": "(>)",
  ">=": "(>=)",
  icmp: "compare",
};

/** A `String` (given as a decoded JS string) as the Scott list of its char codes,
 *  by Unicode code point (astral chars arrive as surrogate pairs). */
function scottStringOf(s: string): Node {
  const cps = Array.from(s); // iterate by code point, not UTF-16 unit
  let list = named("K"); // nil
  for (let i = cps.length - 1; i >= 0; i--) list = app(app(named("cons"), natTree(cps[i].codePointAt(0)!)), list);
  return list;
}

/** Does the free variable `x` occur in `e`? (A `lam` binding `x` shadows it.) */
function occursExpr(x: string, e: Expr): boolean {
  if ("var" in e) return e.var === x;
  if ("app" in e) return occursExpr(x, e.app[0]) || occursExpr(x, e.app[1]);
  if ("lam" in e) return e.lam[0] !== x && occursExpr(x, e.lam[1]);
  return false;
}

/** Naive bracket abstraction `\x. e` over a variable, as an `Expr` of `S`/`K`/`I`
 *  prims — mirrors the text path's `absTm`, so a self-recursive top-level def
 *  `f = …f…` becomes `Y (\f. body)` (a finite tree) instead of a rejected cycle. */
function absExpr(x: string, e: Expr): Expr {
  if ("var" in e && e.var === x) return { prim: "I" }; // \x. x
  if (!occursExpr(x, e)) return { app: [{ prim: "K" }, e] }; // \x. e  (x not free)
  if ("app" in e) return { app: [{ app: [{ prim: "S" }, absExpr(x, e.app[0])] }, absExpr(x, e.app[1])] };
  return { app: [{ prim: "K" }, e] }; // unreachable for bracket-abstracted defs
}

/** A JSON `{prim:t}` token → its Combinate node: a basis combinator (SKI-expanded,
 *  catalog-symbol remapped), a supported arithmetic/comparison op, else a sentinel. */
function primNode(t: string, sink: Set<string>): Node {
  if (isBasis(t)) return basisNode(t);
  if (JSON_PRIM_OP[t]) return named(JSON_PRIM_OP[t]);
  return sentinel(t, sink); // Tn / TAGn / KA / seq / neg / IO.* / … — rejected iff forced
}

/**
 * Turn a `toCombinators` pruned closure (`defs`, rooted at `root`) into a Combinate
 * tree. Resolves `var` references from the root as a memoised shared DAG (only the
 * *reachable* defs are materialised, so dead dictionary/GMP/IO methods never enter
 * the tree); a mutual-recursion cycle becomes a `<rec:>` sentinel and is rejected
 * downstream (no finite ι tree — same as the text path). Primitives substitute as
 * for the dump; rejection is by reachability.
 */
export function combinatorsToTree(defs: CombDef[], root: string): DumpResult {
  const map = new Map(defs.map((d) => [d.name, d.body]));
  if (!map.has(root)) return { error: `mhs: entry '${root}' not in the compiled closure` };

  const sink = new Set<string>();
  const memo = new Map<string, Node>(); // name → its shared sub-DAG
  const inProgress = new Set<string>();

  const conv = (e: Expr): Node => {
    if ("app" in e) return app(conv(e.app[0]), conv(e.app[1]));
    if ("var" in e) return resolve(e.var);
    if ("prim" in e) return primNode(e.prim, sink);
    if ("int" in e) return e.int >= 0 ? natTree(e.int) : sentinel(`int:${e.int}`, sink);
    if ("int64" in e) return e.int64 >= 0 ? natTree(e.int64) : sentinel(`int64:${e.int64}`, sink);
    if ("integer" in e) {
      const n = Number(e.integer);
      return Number.isSafeInteger(n) && n >= 0 ? natTree(n) : sentinel(`integer:${e.integer}`, sink);
    }
    if ("char" in e) return natTree(e.char.codePointAt(0) ?? 0);
    if ("string" in e) return scottStringOf(e.string);
    if ("lam" in e) throw new Error("mhs: unexpected lambda in compiled output");
    const [k, v] = Object.entries(e)[0]; // double / float / rat / bstr / forimp / exn / tick / ctype
    return sentinel(`${k}:${String(v)}`, sink);
  };

  const resolve = (name: string): Node => {
    const hit = memo.get(name);
    if (hit) return hit;
    const body = map.get(name);
    if (body === undefined) return sentinel(name, sink); // free var / not in the closure
    if (inProgress.has(name)) return sentinel(`<rec:${name}>`, sink); // top-level mutual cycle
    inProgress.add(name);
    // Self-recursive top-level def `f = …f…` → `Y (\f. body)`; `f` is abstracted
    // out, so `conv` never re-enters `name` (only a mutual cycle trips <rec:>).
    const wrapped: Expr = occursExpr(name, body) ? { app: [{ prim: "Y" }, absExpr(name, body)] } : body;
    const out = conv(wrapped);
    inProgress.delete(name);
    memo.set(name, out);
    return out;
  };

  let tree: Node;
  try {
    tree = resolve(root);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return rejectForcedSentinels(tree, sink);
}

