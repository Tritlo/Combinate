import { type Node, app, freeVar, exceedsNodes } from "./term";
import { normalize } from "./reduce";
import { CATALOG, type Law } from "./catalog";

// Catalog combinators are tiny; a term you build to realise one is small. Past this many
// nodes, don't even probe (each probe REDUCES the term over the whole catalog — explosive on
// e.g. a big Church numeral) — a large term isn't a named bird.
const RECOGNIZE_MAX_NODES = 256;

/** The first catalog law a term behaves as, or null if it realises none. */
export function recognize(tree: Node, cap = 10_000): Law | null {
  if (exceedsNodes(tree, RECOGNIZE_MAX_NODES)) return null; // too big to be a named combinator
  for (const law of CATALOG) {
    if (law.userDefined) continue; // authored, not discovered — never auto-matched
    if (probe(tree, law, cap)) return law;
  }
  return null;
}

/** The free-variable names occurring in a term (so probe vars can avoid them). */
function freeNames(n: Node, acc = new Set<string>()): Set<string> {
  switch (n.kind) {
    case "free":
      acc.add(n.name);
      break;
    case "app":
      freeNames(n.fn, acc);
      freeNames(n.arg, acc);
      break;
    case "comb":
      if (n.def) freeNames(n.def, acc); // a def can surface free vars when it unfolds
      break;
  }
  return acc;
}

/** `n` fresh free variables whose names avoid `used` — so applying a term to
 *  them can't capture a free variable the term already contains (a term holding
 *  a free `a` must not match `M x = x x` just because `a a` looks like `x x`). */
function freshVars(n: number, used: Set<string>): Node[] {
  const vars: Node[] = [];
  for (let i = 0; vars.length < n; i++) {
    const name = i < 26 ? String.fromCharCode(97 + i) : `v${i}`;
    if (!used.has(name)) vars.push(freeVar(name));
  }
  return vars;
}

/**
 * Behavioral discovery (§7.1): apply `tree` to `law.arity` fresh free variables,
 * normal-order reduce, and check the normal form equals the law's reference
 * output on those same variables. Discovery is behavioral, not syntactic —
 * `(ι ι)` normalises to `S K (K K)` yet `(ι ι) a ≡ a`, so it realises `I`.
 *
 * Returns false if the term fails to reach a normal form within the step cap.
 */
export function probe(tree: Node, law: Law, cap = 2000): boolean {
  const vars = freshVars(law.arity, freeNames(tree));
  // Most laws apply the term to the fresh vars directly; a law may instead
  // supply specific arguments (e.g. Y is tested as Y (K a) ≡ a, since Y a alone
  // diverges — Y has no normal form).
  const args = law.args ? law.args(vars) : vars;
  const applied = args.reduce((acc, v) => app(acc, v), tree);
  const nf = normalize(applied, cap, true, undefined, 20_000); // fast mode + a size guard so a probe that explodes (not a value) bails instead of freezing
  // fast mode: a named combinator fires its rule instead of grinding its SKI tree (same NF, but reading `((<) K)` is instant, not ~400ms)
  if (!nf.done) return false;
  return structKey(nf.term) === structKey(law.reference(vars));
}

/** Structural key: trees are equal iff their keys match (free vars by name,
 * combinators by symbol; ids are ignored). */
export function structKey(n: Node): string {
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
