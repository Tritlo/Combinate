/**
 * MicroHs `-ddump-combinator` → Combinate tree (ADR 0007, §B3).
 *
 * A MicroHs program compiles to a parenthesised-prefix combinator program: a set
 * of named top-level definitions over the fixed basis `S K I B C A U Z P R O S'
 * B' C' C'B K2 K3 K4 J Y` plus opaque *primitive* leaves (arithmetic, IO, FFI,
 * machine literals). This module ports the parse + inline + basis→SKI expansion
 * from `../../MicroHs/iota/Iota.hs` into the pure core:
 *
 *   dump ──parse──► named defs
 *        ──inline (from a root, Y-wrapping self-recursion)──► one term
 *        ──map basis→catalog comb nodes, reject primitives──► a Combinate tree
 *
 * The resulting tree loads via the normal spawn path: every basis combinator is a
 * named `comb` node carrying its arity and an S/K/I definition, so the reducer
 * unfolds it exactly like a discovered law. A primitive leaf has no ι form, so the
 * whole term is rejected with a clear message.
 *
 * Pure: no Pixi / DOM / wasm. The wasm blob that produces the dump lives in the
 * Worker adapter (`../view/mhs/`).
 */

import { type Node, app, comb, decode } from "./term";
import { IOTA_CODE } from "./catalog";

// ---------------------------------------------------------------------------
// Parse tree: a binary application tree with string leaves (Iota.hs `Tm`).

type Tm = { tag: "lf"; s: string } | { tag: "ap"; a: Tm; b: Tm };
const lf = (s: string): Tm => ({ tag: "lf", s });
const ap = (a: Tm, b: Tm): Tm => ({ tag: "ap", a, b });

// ---------------------------------------------------------------------------
// Tokenizer + parser for the -ddump-combinator format (fully-parenthesised,
// left-associative applications; quoted string literals are single atoms).

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
 * Parse a whole dump into an *ordered* map of `name → term`. Blank lines are
 * dropped and continuation lines (the pretty-printer wraps wide terms onto
 * indented lines) are joined onto their definition.
 */
export function parseDump(dump: string): Map<string, Tm> {
  const raw = dump.split("\n").filter((l) => l.trim() !== "");
  // Join continuation lines (start with whitespace) onto the preceding def.
  const lines: string[] = [];
  for (const l of raw) {
    if (/^\s/.test(l) && lines.length > 0) lines[lines.length - 1] += " " + l.trim();
    else lines.push(l.trim());
  }
  const defs = new Map<string, Tm>();
  for (const line of lines) {
    const eq = line.indexOf(" = ");
    if (eq < 0) continue; // skip non-def lines (e.g. gmhs's "combinators:" header)
    const name = line.slice(0, eq).trim();
    const rhs = line.slice(eq + 3);
    defs.set(name, new Parser(tokenize(rhs)).apps());
  }
  return defs;
}

// ---------------------------------------------------------------------------
// Inlining references from a root into a single term.

function occurs(x: string, t: Tm): boolean {
  return t.tag === "lf" ? t.s === x : occurs(x, t.a) || occurs(x, t.b);
}

/** Naive bracket abstraction `\x. t` over a leaf variable (Iota.hs `absTm`). */
function absTm(x: string, t: Tm): Tm {
  if (t.tag === "lf") return t.s === x ? lf("I") : ap(lf("K"), t);
  return ap(ap(lf("S"), absTm(x, t.a)), absTm(x, t.b));
}

/**
 * Inline top-level references reachable from `root` into one finite term.
 * MicroHs leaves top-level recursion as self-referential defs (`f = …f…`); each
 * is rewritten into a finite `Y (\f. body)` so the result is a tree, not a cycle.
 * A mutual cycle is left as a `<rec:name>` marker (rejected downstream).
 */
function inline(defs: Map<string, Tm>, root: string): Tm {
  const wrapped = new Map<string, Tm>();
  for (const [name, body] of defs) wrapped.set(name, occurs(name, body) ? ap(lf("Y"), absTm(name, body)) : body);
  const go = (stack: string[], t: Tm): Tm => {
    if (t.tag === "ap") return ap(go(stack, t.a), go(stack, t.b));
    if (stack.includes(t.s)) return lf(`<rec:${t.s}>`);
    const body = wrapped.get(t.s);
    return body ? go([t.s, ...stack], body) : t;
  };
  return go([], lf(root));
}

// ---------------------------------------------------------------------------
// The basis: each combinator's arity, S/K/I definition, and the Combinate
// catalog symbol it displays as (chosen so a same-meaning bird reduces correctly
// in optimize mode too). Ported from Iota.hs `zoo` arities + `algebraDefs`.

/** S/K/I expansions of the non-atomic basis combinators (Iota.hs `algebraDefs`). */
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

/** Display symbol: remap a MicroHs combinator to the Combinate catalog bird of
 *  the same meaning (so it renders as a known bird and, where it carries a
 *  catalog rule, reduces correctly in optimize mode). `O` would collide with the
 *  Owl, so it gets a distinct non-rule name. */
const SYM: Record<string, string> = { U: "T", P: "V", J: "N", "S'": "Φ", "B'": "D", O: "O4" };

const isAtomicComb = (s: string): boolean => s === "S" || s === "K" || s === "I";
const isBasis = (s: string): boolean => isAtomicComb(s) || s in ALGEBRA;

/** Build the pure S/K/I term a basis combinator expands to (Iota.hs `combSK`),
 *  recursively inlining references in `ALGEBRA` down to S/K/I leaves. */
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
// Term → Combinate tree, rejecting primitive leaves.

/** Honest rejection message for a leaf with no combinatory form. */
const rejectMsg = (s: string): string =>
  s.startsWith("<rec:")
    ? `no ι form: mutual recursion via '${s.slice(5, -1)}' has no finite combinator tree`
    : `no ι form: '${s}' is a primitive (IO / FFI / arithmetic / literal) — use only Peano/Scott data`;

function toNode(t: Tm): Node {
  if (t.tag === "ap") return app(toNode(t.a), toNode(t.b));
  if (isBasis(t.s)) return basisNode(t.s);
  throw new Error(rejectMsg(t.s));
}

/** The result of compiling a dump: a spawnable tree, or a reject reason. */
export type DumpResult = { tree: Node } | { error: string };

/**
 * Turn a `-ddump-combinator` dump into a Combinate tree, inlining from `root`
 * (default: the last definition in the dump). Returns `{ error }` if the term
 * references a primitive / FFI / IO leaf (no ι form) or the root is missing.
 */
export function dumpToTree(dump: string, root?: string): DumpResult {
  let defs: Map<string, Tm>;
  try {
    defs = parseDump(dump);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (defs.size === 0) return { error: "mhs: empty dump (no definitions)" };
  const r = root ?? [...defs.keys()][defs.size - 1];
  if (!defs.has(r)) return { error: `mhs: no top-level definition '${r}' in the dump` };
  try {
    return { tree: toNode(inline(defs, r)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Tree → Barker bit-code (the pure-ι form), for the store / leaderboard path.

/** Expand a basis tree to its pure ι form: S/K/I leaves become their canonical
 *  ι-trees, named combinators expand through their S/K/I definition. */
function toIota(n: Node): Node {
  switch (n.kind) {
    case "comb":
      if (IOTA_CODE[n.sym]) return decode(IOTA_CODE[n.sym]); // S/K/I
      if (n.def) return toIota(n.def); // named basis combinator → expand its def
      throw new Error(`mhs: cannot encode combinator ${n.sym} (no ι form)`);
    case "app":
      return app(toIota(n.fn), toIota(n.arg));
    default:
      throw new Error(`mhs: cannot encode ${n.kind} node as ι`);
  }
}

const encodeIota = (n: Node): string => (n.kind === "app" ? "0" + encodeIota(n.fn) + encodeIota(n.arg) : "1");

/** Barker bit-code (`1` = ι, `0 <fn> <arg>` = app) of a basis tree — the
 *  canonical pure-ι program, e.g. for leaderboard submission. */
export function treeToBitcode(tree: Node): string {
  return encodeIota(toIota(tree));
}
