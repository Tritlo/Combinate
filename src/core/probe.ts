import { type Node, app, freeVar } from "./term";
import { normalize } from "./reduce";
import { CATALOG, type Law } from "./catalog";

const VAR_NAMES = ["a", "b", "c", "d", "e", "f"];

/** The first catalog law a term behaves as, or null if it realises none. */
export function recognize(tree: Node, cap = 10_000): Law | null {
  for (const law of CATALOG) {
    if (law.userDefined) continue; // authored, not discovered — never auto-matched
    if (probe(tree, law, cap)) return law;
  }
  return null;
}

/**
 * Behavioural discovery (§7.1): apply `tree` to `law.arity` fresh free variables,
 * normal-order reduce, and check the normal form equals the law's reference
 * output on those same variables. Discovery is behavioural, not syntactic —
 * `(ι ι)` normalises to `S K (K K)` yet `(ι ι) a ≡ a`, so it realises `I`.
 *
 * Returns false if the term fails to reach a normal form within the step cap.
 */
export function probe(tree: Node, law: Law, cap = 2000): boolean {
  const vars = Array.from({ length: law.arity }, (_, i) => freeVar(VAR_NAMES[i]));
  // Most laws apply the term to the fresh vars directly; a law may instead
  // supply specific arguments (e.g. Y is tested as Y (K a) ≡ a, since Y a alone
  // diverges — Y has no normal form).
  const args = law.args ? law.args(vars) : vars;
  const applied = args.reduce((acc, v) => app(acc, v), tree);
  const nf = normalize(applied, cap);
  if (!nf.done) return false;
  return structKey(nf.term) === structKey(law.reference(vars));
}

/** Structural key: trees are equal iff their keys match (free vars by name,
 * combinators by symbol; ids are ignored). */
function structKey(n: Node): string {
  switch (n.kind) {
    case "iota":
      return "ι";
    case "comb":
      return `c${n.sym}`;
    case "free":
      return `v${n.name}`;
    case "app":
      return `(${structKey(n.fn)} ${structKey(n.arg)})`;
  }
}
