import { type Node, app, freeVar } from "./term";
import { normalize } from "./reduce";

/**
 * Typing here is a *lens*, not a gate (ADR 0002): a tag you point at a tree to
 * read it as a value, never a check that blocks a build. Roles are not in the
 * term — `A` is `0`, `False`, and `nil` all at once — so the tag is the seed
 * that says which reading you want. Decoding then *runs* the term against that
 * reading's eliminators and reads the answer back; a tree that doesn't fit
 * decodes to `null` ("doesn't read as Int"), which is information, not an error.
 */

/** A semantic type a tree can be read as. Bool / List / Pair follow. */
export type Ty = { kind: "Int" };

// Eliminator names for decoding. Player trees are variable-free, so these can't
// clash; the `·` keeps them distinct from the probe's a…f even if one leaks in.
const F = "·f";
const X = "·x";

/**
 * Read a Church numeral as a JS number by running it: `n f x` normalises to
 * `f (f … (f x))`, so apply the term to fresh eliminators, normalise, and count
 * the `f`-nesting. Returns `null` if it doesn't reach a numeral shape — a term
 * that loops past the cap, or whose normal form isn't `fⁿ x`, simply isn't an
 * Int under this lens.
 */
export function decodeNat(tree: Node, cap = 10_000): number | null {
  const nf = normalize(app(app(tree, freeVar(F)), freeVar(X)), cap);
  if (!nf.done) return null;
  let count = 0;
  let cur = nf.term;
  while (cur.kind === "app") {
    if (!(cur.fn.kind === "free" && cur.fn.name === F)) return null; // not `f (…)`
    count++;
    cur = cur.arg;
  }
  return cur.kind === "free" && cur.name === X ? count : null; // bottoms out at `x`?
}

/** Read a tree as a value of the given type, or `null` if it doesn't fit. */
export function decode(ty: Ty, tree: Node, cap = 10_000): number | null {
  switch (ty.kind) {
    case "Int":
      return decodeNat(tree, cap);
  }
}
