import { type Node, app, freeVar } from "./term";
import { normalize } from "./reduce";
import { type Law } from "./catalog";

const VAR_NAMES = ["a", "b", "c", "d"];

/**
 * Behavioural discovery (§7.1): apply `tree` to `law.arity` fresh free variables,
 * normal-order reduce, and check the normal form equals the law's reference
 * output on those same variables. Discovery is behavioural, not syntactic —
 * `(ι ι)` normalises to `S K (K K)` yet `(ι ι) a ≡ a`, so it realises `I`.
 *
 * Returns false if the term fails to reach a normal form within the step cap.
 */
export function probe(tree: Node, law: Law, cap = 10_000): boolean {
  const vars = Array.from({ length: law.arity }, (_, i) => freeVar(VAR_NAMES[i]));
  const applied = vars.reduce((acc, v) => app(acc, v), tree);
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
