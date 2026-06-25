import { type Node } from "./term";
import { matchNumeral, matchList, matchBool, renderListForced } from "./value";

/**
 * Typing here is a *lens*, not a gate (ADR 0003): a tag you point at a tree to
 * read it as a value, never a check that blocks a build. Roles are not in the
 * term — `A` is `0`, `False`, and `nil` all at once — so the tag is the seed
 * that picks which reading you want.
 *
 * `value.ts: readValue` auto-discovers an encoding and *defers* on the trivial
 * values that coincide with bare combinators (`0`/`[]`/`false` are all `A`).
 * `readAs` is the forced counterpart: given a tag it runs that one encoding's
 * matcher and renders even the trivial cases — so a tag resolves the ambiguity
 * `readValue` leaves open (`A` as `0` under `Int`, as `[]` under `List`). The
 * read-as mode comes from the current hotbar page (Arithmetic → Int, Booleans →
 * Bool, Lists → List); `null` means a tree that doesn't fit that reading, so the
 * caller falls back to `readValue` / the combinator re-folder / the raw sexp.
 */

/** A reading to force a tree into. Mirrors the typed hotbar pages. */
export type Ty = "Int" | "Bool" | "List";

/** Read a tree under a forced type tag, resolving the bare-combinator ambiguity
 *  that `readValue` defers, or `null` if it doesn't fit that reading. */
export function readAs(ty: Ty, n: Node): string | null {
  switch (ty) {
    case "Int": {
      const k = matchNumeral(n);
      return k === null ? null : String(k);
    }
    case "Bool": {
      const b = matchBool(n);
      return b === null ? null : String(b);
    }
    case "List": {
      const heads = matchList(n);
      return heads === null ? null : renderListForced(heads);
    }
  }
}
