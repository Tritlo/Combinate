import { type Node, sexp } from "./term";
import { matchNumeral, matchList, matchPair, matchBool } from "./value";
import { recognizeDeep } from "./refold";

/**
 * Type-guided reading (ADR 0003): a tag points at a tree and reads it as a value,
 * never a gate that blocks a build. Built on the re-folder's structural matchers
 * (`value.ts`), this adds the two things the flat auto-reader can't do:
 *
 *  - **Propagation.** A list is homogeneous, so one unambiguous element fixes the
 *    reading of its ambiguous siblings: `[2, 0]` reads because the `2` says
 *    "numeric list", letting the `0` (= bare `A`, normally deferred) resolve.
 *  - **Routing.** Each component that isn't data falls to the combinator re-folder
 *    rather than sinking the whole structure: `cons 2 (cons B nil) → [2, B]`.
 *
 * Reading returns a typed `Val` tree; the shell renders it. The `hint` (from the
 * hotbar page, or propagated from a sibling) forces a reading and resolves the
 * bare-combinator ambiguity. Under the Scott encoding the three trivial values
 * `0`/`[]`/`false` all coincide on the Kestrel `K`, so a bare `K` is deferred
 * (stays `K`) until a tag says which it is; everything else — numerals ≥ 1,
 * non-empty lists, `true` (= `A`), pairs — has an unambiguous shape and reads on
 * its own.
 */

/** A reading to force a tree into. Mirrors the typed hotbar pages. `Char` reads
 *  text — a Scott numeral as its glyph, a Scott list of numerals as a string
 *  (a Char IS its ASCII numeral, so this is a *display lens* over Int/[Int], not
 *  a distinct HM type — `infer.ts` types a Char exactly as a numeral). */
export type Ty = "Int" | "Bool" | "List" | "Char";

/** A decoded value: the data shapes, plus a `comb` escape hatch for any subterm
 *  that isn't data (named as far as a behavioral pass can fold it). */
export type Val =
  | { t: "int"; n: number }
  | { t: "bool"; b: boolean }
  | { t: "list"; xs: Val[] }
  | { t: "pair"; a: Val; b: Val }
  | { t: "char"; c: number }
  | { t: "str"; cs: number[] }
  | { t: "comb"; sexp: string };

const MAX_DEPTH = 8; // nesting guard

/** The data type a value carries, for propagating across homogeneous list
 *  siblings; null for `pair`/`comb`, which have no forceable bare form. */
function tyOf(v: Val): Ty | null {
  switch (v.t) {
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "list":
      return "List";
    default:
      return null;
  }
}

/** A non-data subterm, named as far as the behavioral pass reaches (S(KS)K → B). */
const routed = (n: Node): Val => ({ t: "comb", sexp: sexp(recognizeDeep(n)) });

/** Does a term mention a free variable? Real data is closed; a component that
 *  carries a probe variable means the structural match was spurious — e.g. `M`
 *  probed as a list yields `c c n`, a fake `[c]` whose head *is* the fold var. */
function hasFreeVar(n: Node): boolean {
  return n.kind === "free" || (n.kind === "app" && (hasFreeVar(n.fn) || hasFreeVar(n.arg)));
}

/**
 * Read a term as a typed value, or null if it isn't data under this reading.
 * `hint` forces one encoding (resolving the bare-combinator ambiguity); without
 * it we auto-discover and defer the trivial values per `depth`.
 */
export function read(n: Node, hint: Ty | null = null, depth = 0): Val | null {
  if (depth > MAX_DEPTH) return null;
  if (hint === "Int") {
    const k = matchNumeral(n);
    return k === null ? null : { t: "int", n: k };
  }
  if (hint === "Bool") {
    const b = matchBool(n);
    return b === null ? null : { t: "bool", b };
  }
  if (hint === "List") {
    const heads = matchList(n);
    return heads === null ? null : readList(heads, depth);
  }
  if (hint === "Char") {
    // text reading: a list of numerals is a string; a bare numeral is a char.
    const heads = matchList(n);
    if (heads !== null) return readString(heads, depth);
    const k = matchNumeral(n);
    return k === null ? null : { t: "char", c: k };
  }
  // auto-discover — the only deferred reading is the bare `K` (= `0`/`[]`/`false`,
  // all three coincide on the Kestrel); a numeral ≥ 1, a non-empty list, `true`
  // (= `A`) and a pair each have an unambiguous shape, so read them at any depth.
  const k = matchNumeral(n);
  if (k !== null && k >= 1) return { t: "int", n: k };
  const heads = matchList(n);
  if (heads && heads.length > 0) {
    const v = readList(heads, depth);
    if (v) return v; // else a spurious match — fall through
  }
  const pair = matchPair(n);
  if (pair) {
    const v = readPair(pair, depth);
    if (v) return v;
  }
  if (matchBool(n) === true) return { t: "bool", b: true };
  return null;
}

/** Read a list's heads: auto each, propagate a sibling's type to the ambiguous
 *  ones (lists are homogeneous), then route any leftover *closed* non-data head
 *  to `comb`. Returns null if a head carries a probe variable (a spurious match,
 *  e.g. `M`), so the caller falls through to the combinator re-folder. */
function readList(heads: Node[], depth: number): Val | null {
  const xs: (Val | null)[] = heads.map((h) => read(h, null, depth + 1));
  const types = new Set<Ty>();
  for (const v of xs) {
    const t = v && tyOf(v);
    if (t) types.add(t);
  }
  if (types.size === 1) {
    const [T] = types;
    for (let i = 0; i < xs.length; i++) if (xs[i] === null) xs[i] = read(heads[i], T, depth + 1);
  }
  const out: Val[] = [];
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v) out.push(v);
    else if (hasFreeVar(heads[i])) return null; // probe artifact — not a real list
    else out.push(routed(heads[i]));
  }
  return { t: "list", xs: out };
}

/** Read a list of numerals as a string (every head a Scott numeral = a char
 *  code). Falls back to an ordinary list reading if any head isn't a numeral, so
 *  `"ab" ++ [B]` still reads structurally rather than vanishing. */
function readString(heads: Node[], depth: number): Val | null {
  const cs: number[] = [];
  for (const h of heads) {
    const k = matchNumeral(h);
    if (k === null) return readList(heads, depth); // not pure text → ordinary list
    cs.push(k);
  }
  return { t: "str", cs };
}

/** Read a pair's two components (heterogeneous → no propagation); route a closed
 *  non-data component to `comb`, or bail if either carries a probe variable. */
function readPair([x, y]: [Node, Node], depth: number): Val | null {
  const a = read(x, null, depth + 1) ?? (hasFreeVar(x) ? null : routed(x));
  const b = read(y, null, depth + 1) ?? (hasFreeVar(y) ? null : routed(y));
  return a && b ? { t: "pair", a, b } : null;
}

/** Render one char code for the read-out: printable ASCII verbatim, the rest as
 *  an escape; `quote` (the surrounding ' or ") is escaped too. */
function showChar(c: number, quote: number): string {
  if (c === quote || c === 92) return "\\" + String.fromCharCode(c);
  if (c === 10) return "\\n";
  if (c === 9) return "\\t";
  if (c === 13) return "\\r";
  if (c >= 32 && c < 127) return String.fromCharCode(c);
  return `\\x${c.toString(16)}`;
}

/** Render a decoded value to the compact read-out string. */
export function render(v: Val): string {
  switch (v.t) {
    case "int":
      return String(v.n);
    case "bool":
      return String(v.b);
    case "list":
      return `[${v.xs.map(render).join(", ")}]`;
    case "pair":
      return `(${render(v.a)}, ${render(v.b)})`;
    case "char":
      return `'${showChar(v.c, 39)}'`;
    case "str":
      return `"${v.cs.map((c) => showChar(c, 34)).join("")}"`;
    case "comb":
      return v.sexp;
  }
}
