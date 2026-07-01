/**
 * MicroHs `-ddump-combinator` → Combinate tree, by **post-processing a stock
 * dump** (ADR 0007). No MicroHs fork: stock `gmhs` (build-time) or the stock web
 * blob (live) emits a parenthesised-prefix combinator program over the fixed basis
 * `S K I B C A U Z P R O S' B' C' C'B K2 K3 K4 J Y`, plus *primitive* leaves
 * (machine literals `#n`, packed strings `"…"`, and `Primitives.primIntAdd`-style
 * arithmetic / comparison / IO / FFI). This module rewrites that dump into pure ι:
 *
 *   dump ──parse──► named defs
 *        ──inline (from a root, Y-wrapping self-recursion)──► one term
 *        ──substitute──► a Combinate tree, where
 *            #n          → the Scott numeral  Succ^n Z   (a Char is its ASCII #n)
 *            "abc"       → the Scott list of its char codes
 *            primIntAdd… → the matching Scott combinator (catalog `(+)`, `(<)`, …)
 *            primChr/Ord → identity  (Char ≡ Int)
 *            S K I B C … → the basis combinator, expanded to its SKI definition
 *            anything else (Double/Float/IO/FFI/bitwise/negate, mutual recursion)
 *                        → an inert `primitive:…` sentinel
 *
 * The substituted Scott combinators come straight from the catalog, so the tree
 * loads via the normal spawn path and reduces (and, in optimize mode, reduces by
 * each combinator's rule — essential, since a Char `'A'` is 65 nested `Succ`s).
 *
 * Rejection is **by reachability, not by text**: a stock dump mentions primitives
 * we can't encode (e.g. `primIntNeg` sits in every `Num` dictionary) even when the
 * program never uses them, so we substitute a sentinel and reject only if one
 * *survives reduction* — i.e. the program actually forces it.
 *
 * Pure: no Pixi / DOM / wasm. The wasm blob that produces the dump lives in the
 * Worker adapter (`../view/mhs/`).
 */

import { type Node, app, comb } from "./term";
import { named } from "./catalog";
import { step } from "./reduce";

// ---------------------------------------------------------------------------
// Parse tree: a binary application tree with string leaves.

type Tm = { tag: "lf"; s: string } | { tag: "ap"; a: Tm; b: Tm };
const lf = (s: string): Tm => ({ tag: "lf", s });
const ap = (a: Tm, b: Tm): Tm => ({ tag: "ap", a, b });

// ---------------------------------------------------------------------------
// Tokenizer + parser for the -ddump-combinator format (fully-parenthesised,
// left-associative applications; quoted string literals are single atoms; `#n`
// literals, `Primitives.x`, `inst$…@…` and operator names are ordinary atoms).

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

/**
 * Split a dump into an *ordered* map of `name → raw-RHS-string`. Blank lines are
 * dropped and continuation lines (the pretty-printer wraps wide terms onto
 * indented lines) are joined onto their definition.
 *
 * The RHS is **not** parsed here — `inline` parses each reached def lazily. A
 * full-Prelude dump has thousands of defs whose higher-kinded instance *names*
 * carry parens inside the identifier (e.g. `inst$…Functor@(Primitives.->@a)`),
 * which the simple fully-parenthesised application grammar can't tokenise. A
 * first-order arithmetic / list / char program never reaches those, so parsing
 * lazily from the root both sidesteps them and skips ~3500 needless parses.
 */
export function parseDump(dump: string): Map<string, string> {
  const raw = dump.split("\n").filter((l) => l.trim() !== "");
  // Join continuation lines (start with whitespace) onto the preceding def.
  const lines: string[] = [];
  for (const l of raw) {
    if (/^\s/.test(l) && lines.length > 0) lines[lines.length - 1] += " " + l.trim();
    else lines.push(l.trim());
  }
  const defs = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf(" = ");
    if (eq < 0) continue; // skip non-def lines (e.g. gmhs's "combinators:" header)
    defs.set(line.slice(0, eq).trim(), line.slice(eq + 3));
  }
  return defs;
}

/** Parse one raw RHS string into a parse tree. */
const parseRhs = (rhs: string): Tm => new Parser(tokenize(rhs)).apps();

// ---------------------------------------------------------------------------
// Inlining references from a root into a single term.

function occurs(x: string, t: Tm): boolean {
  return t.tag === "lf" ? t.s === x : occurs(x, t.a) || occurs(x, t.b);
}

/** Naive bracket abstraction `\x. t` over a leaf variable. */
function absTm(x: string, t: Tm): Tm {
  if (t.tag === "lf") return t.s === x ? lf("I") : ap(lf("K"), t);
  return ap(ap(lf("S"), absTm(x, t.a)), absTm(x, t.b));
}

/**
 * Inline top-level references reachable from `root` into one finite term — as a
 * **DAG**: each def is inlined exactly once and *shared* at every reference, so a
 * dictionary referenced N times (the `Num`/`Ord` dicts are referenced heavily,
 * recursively) doesn't blow the result up exponentially. Normal-order reduction
 * later clones only the live duplicates (and never touches dead dictionary
 * fields), so sharing the build is safe.
 *
 * MicroHs leaves top-level recursion as self-referential defs (`f = …f…`); each
 * is rewritten into a finite `Y (\f. body)`. A mutual cycle is left as a
 * `<rec:name>` marker (rejected downstream). Defs are parsed lazily — only the
 * ones actually reached — so the multi-thousand-def Prelude isn't materialised.
 */
function inline(defs: Map<string, string>, root: string): Tm {
  const memo = new Map<string, Tm>(); // name → its fully-inlined sub-DAG (shared)
  const inProgress = new Set<string>();
  const resolve = (name: string): Tm => {
    const cached = memo.get(name);
    if (cached) return cached;
    // The primitive layer is opaque: `Primitives.primIntMul` etc. are themselves
    // defs aliasing a raw FFI op (`*`), so resolving through them would bury the
    // op we substitute on. Stop here and let `toNode` map/reject the named prim.
    if (name.startsWith("Primitives.")) return lf(name);
    const rhs = defs.get(name);
    if (rhs === undefined) return lf(name); // a leaf: basis / primitive / literal
    if (inProgress.has(name)) return lf(`<rec:${name}>`); // mutual cycle
    inProgress.add(name);
    const body = parseRhs(rhs);
    const wrapped = occurs(name, body) ? ap(lf("Y"), absTm(name, body)) : body;
    const out = subst(wrapped);
    inProgress.delete(name);
    memo.set(name, out);
    return out;
  };
  const subst = (t: Tm): Tm => (t.tag === "ap" ? ap(subst(t.a), subst(t.b)) : resolve(t.s));
  return resolve(root);
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
// Substituting MicroHs primitives → catalog Scott combinators. Char ≡ Int (a
// Char is its ASCII numeral), so every char op maps to its Int counterpart.

/** Supported primitive operations → the catalog combinator that computes them. */
const PRIM_OP: Record<string, string> = {
  "Primitives.primIntAdd": "(+)",
  "Primitives.primIntSub": "(-)", // truncated subtraction (monus) — naturals only
  "Primitives.primIntMul": "(*)",
  "Primitives.primIntEQ": "(==)",
  "Primitives.primIntNE": "(/=)",
  "Primitives.primIntLT": "(<)",
  "Primitives.primIntLE": "(<=)",
  "Primitives.primIntGT": "(>)",
  "Primitives.primIntGE": "(>=)",
  "Primitives.primIntCompare": "compare",
  "Primitives.primCharEQ": "(==)",
  "Primitives.primCharNE": "(/=)",
  "Primitives.primCharLT": "(<)",
  "Primitives.primCharLE": "(<=)",
  "Primitives.primCharGT": "(>)",
  "Primitives.primCharGE": "(>=)",
  "Primitives.primCharCompare": "compare",
};

/** Primitives that are the identity on our representation (Char ≡ Int, and an
 *  `Int` literal is already the Scott numeral we substitute for it). */
const PRIM_ID = new Set(["Primitives.primChr", "Primitives.primOrd", "Data.Integer_Type._integerToInt"]);

/** The Scott numeral `Succ^k Z` (Z = K). Also a Char of code `k`. */
function numeral(k: number): Node {
  let n = named("K"); // Z
  for (let i = 0; i < k; i++) n = app(named("Succ"), n);
  return n;
}

/** Decode a MicroHs string-literal atom (`"…"`, with \-escapes) to its text. */
function unescape(atom: string): string {
  const body = atom.slice(1, -1);
  try {
    return JSON.parse('"' + body.replace(/\\(?!["\\/bfnrtu])/g, "\\\\") + '"');
  } catch {
    return body.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** A Haskell `String` literal as the Scott list of its char codes (`[Char] = [Nat]`). */
function scottString(atom: string): Node {
  const s = unescape(atom);
  let list = named("K"); // nil
  for (let i = s.length - 1; i >= 0; i--) list = app(app(named("cons"), numeral(s.charCodeAt(i))), list);
  return list;
}

// ---------------------------------------------------------------------------
// Term → Combinate tree.

/** An inert sentinel for a leaf with no ι form: a `comb` with no def never
 *  reduces, so it stays in the normal form iff the program actually forces it. */
const PRIM_SENTINEL = "primitive:";
const sentinel = (s: string, sink: Set<string>): Node => {
  sink.add(s);
  return comb(PRIM_SENTINEL + s);
};

/** Convert the inlined DAG to a Combinate-node DAG, substituting primitives.
 *  Memoised on the `Tm` object so a shared sub-DAG becomes a shared sub-tree (the
 *  reducer clones live duplicates as it goes), keeping the build bounded. */
function toNode(t: Tm, sink: Set<string>, memo: Map<Tm, Node>): Node {
  const hit = memo.get(t);
  if (hit) return hit;
  let out: Node;
  if (t.tag === "ap") {
    out = app(toNode(t.a, sink, memo), toNode(t.b, sink, memo));
  } else {
    const s = t.s;
    if (s[0] === "#") {
      const k = parseInt(s.slice(1), 10);
      out = !Number.isFinite(k) || k < 0 ? sentinel(s, sink) : numeral(k); // naturals only: no negatives
    } else if (s[0] === '"') out = scottString(s);
    else if (PRIM_OP[s]) out = named(PRIM_OP[s]);
    else if (PRIM_ID.has(s)) out = named("I");
    else if (isBasis(s)) out = basisNode(s);
    else out = sentinel(s, sink); // primitive / FFI / IO / Float / mutual recursion
  }
  memo.set(t, out);
  return out;
}

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

/** True if `n` has more than `max` nodes (early-exit DFS — cheap to call). */
function exceeds(n: Node, max: number): boolean {
  let count = 0;
  const go = (m: Node): boolean => {
    if (++count > max) return true;
    return m.kind === "app" && (go(m.fn) || go(m.arg));
  };
  return go(n);
}

/**
 * Turn a stock `-ddump-combinator` dump into a Combinate tree, inlining from
 * `root` (default: the last definition in the dump) and substituting primitives.
 * Returns `{ error }` if the program *forces* a primitive with no ι form (checked
 * by reducing and looking for surviving sentinels), or the root is missing.
 */
export function dumpToTree(dump: string, root?: string): DumpResult {
  let defs: Map<string, string>;
  try {
    defs = parseDump(dump);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (defs.size === 0) return { error: "mhs: empty dump (no definitions)" };
  const r = root ?? [...defs.keys()][defs.size - 1];
  if (!defs.has(r)) return { error: `mhs: no top-level definition '${r}' in the dump` };

  const sink = new Set<string>();
  let tree: Node;
  try {
    tree = toNode(inline(defs, r), sink, new Map());
  } catch (e) {
    return { error: (e as Error).message };
  }
  // Reject by reachability: reduce (optimize mode) and see which sentinels remain.
  // A clean program drops the dead ones (e.g. the unused `primIntNeg` in every Num
  // dictionary); one that *forces* a primitive keeps it in the normal form. The
  // probe is bounded by steps *and* tree size: without graph sharing, recursive
  // multiplication blows up (`fac` is exponential), so if the term balloons or the
  // budget runs out we accept and let the shell's capped reduction surface any
  // genuinely-forced primitive. Only a *completed* small reduction is conclusive.
  if (sink.size > 0) {
    let cur = tree;
    let conclusive = false;
    for (let i = 0; i < CHECK_STEPS; i++) {
      if (exceeds(cur, CHECK_SIZE)) break; // blow-up → inconclusive, accept
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

