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
 * bare-combinator ambiguity (`A` is `0`/`[]`/`false` only once a tag says which);
 * without it we auto-discover and defer the trivial values, so a bare `A` stays
 * `A`.
 */

/** A reading to force a tree into. Mirrors the typed hotbar pages. */
export type Ty = "Int" | "Bool" | "List";

/** A decoded value: the data shapes, plus a `comb` escape hatch for any subterm
 *  that isn't data (named as far as a behavioural pass can fold it). */
export type Val =
  | { t: "int"; n: number }
  | { t: "bool"; b: boolean }
  | { t: "list"; xs: Val[] }
  | { t: "pair"; a: Val; b: Val }
  | { t: "comb"; sexp: string };

const MAX_DEPTH = 8; // nesting guard, matches value.ts

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

/** A non-data subterm, named as far as the behavioural pass reaches (S(KS)K → B). */
const routed = (n: Node): Val => ({ t: "comb", sexp: sexp(recognizeDeep(n)) });

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
  // auto-discover — defer trivial values (`0` always; `1`/`true` at the top).
  const k = matchNumeral(n);
  if (k !== null && (k >= 2 || (k === 1 && depth > 0))) return { t: "int", n: k };
  const heads = matchList(n);
  if (heads && heads.length > 0) return readList(heads, depth);
  const pair = matchPair(n);
  if (pair) return readPair(pair, depth);
  if (depth > 0 && matchBool(n) === true) return { t: "bool", b: true };
  return null;
}

/** Read a list's heads: auto each, propagate a sibling's type to the ambiguous
 *  ones (lists are homogeneous), then route any leftover non-data head to `comb`.
 *  Always succeeds — a matched list spine never sinks to null. */
function readList(heads: Node[], depth: number): Val {
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
  return { t: "list", xs: xs.map((v, i) => v ?? routed(heads[i])) };
}

/** Read a pair's two components (heterogeneous → no propagation); route a
 *  non-data component to `comb`. */
function readPair([x, y]: [Node, Node], depth: number): Val {
  return { t: "pair", a: read(x, null, depth + 1) ?? routed(x), b: read(y, null, depth + 1) ?? routed(y) };
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
    case "comb":
      return v.sexp;
  }
}

/** Read a tree under a forced type tag (the hotbar page), or null if it doesn't
 *  fit — the read-out then falls back to the combinator re-folder / raw sexp. */
export function readAs(ty: Ty, n: Node): string | null {
  const v = read(n, ty);
  return v ? render(v) : null;
}
