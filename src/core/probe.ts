import { type Node, app, comb, freeVar, exceedsNodes } from "./term";
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
  if (law.fpc) {
    // Impostor pre-pass: a sage's t·f can never normalize (N =β f·N is impossible
    // for a finite NF), but a deep finite tower f^k·u looks f-headed to any
    // budgeted descent — the memoized normalize walks towers to their floor far
    // past what the memoless head-walk can reach (the 90-story 30ι tower's NF
    // lands at ~60k steps). Generous caps: this runs once per built tree.
    const f = freshVars(1, freeNames(tree))[0];
    const nf = normalize(app(tree, f), 400_000, true, undefined, 4_000_000);
    if (nf.done) return false; // finite behavior — not a sage, however tall
    return bohmSage(tree, cap);
  }
  const vars = freshVars(law.arity, freeNames(tree));
  const applied = vars.reduce((acc, v) => app(acc, v), tree);
  const nf = normalize(applied, cap, true, undefined, 20_000); // fast mode + a size guard so a probe that explodes (not a value) bails instead of freezing
  // fast mode: a named combinator fires its rule instead of grinding its SKI tree (same NF, but reading `((<) K)` is instant, not ~400ms)
  if (!nf.done) return false;
  return structKey(nf.term) === structKey(law.reference(vars));
}

/**
 * Head-reduce to the leftmost spine head: unwind apps, contract the head redex
 * (ι/S/K/I primitively; a named combinator unfolds its def), repeat until the
 * head is stuck — a free variable or an underapplied/opaque leaf — or the fuel
 * runs out (null). Arguments are never reduced, which is what keeps this finite
 * on fixpoint combinators (whose full normal form does not exist).
 */
function headSpine(t: Node, fuel: { steps: number }): { head: Node; args: Node[] } | null {
  let head = t;
  const args: Node[] = []; // stack — last element is the argument nearest the head
  for (;;) {
    while (head.kind === "app") {
      args.push(head.arg);
      head = head.fn;
    }
    if (head.kind === "free") return { head, args };
    if (head.kind === "iota") {
      if (args.length === 0) return { head, args };
      if (fuel.steps-- <= 0) return null;
      head = args.pop()!; // ι x → x S K
      args.push(comb("K"), comb("S"));
    } else if (head.sym === "S" && args.length >= 3) {
      if (fuel.steps-- <= 0) return null;
      const f = args.pop()!;
      const g = args.pop()!;
      const x = args.pop()!;
      args.push(app(g, x), x); // S f g x → f x (g x)
      head = f;
    } else if (head.sym === "K" && args.length >= 2) {
      if (fuel.steps-- <= 0) return null;
      const x = args.pop()!;
      args.pop();
      head = x; // K x y → x (y dropped unevaluated)
    } else if (head.sym === "I" && args.length >= 1) {
      if (fuel.steps-- <= 0) return null;
      head = args.pop()!;
    } else if (head.def) {
      if (fuel.steps-- <= 0) return null;
      head = head.def; // named bird — unfold its definition
    } else {
      return { head, args }; // underapplied primitive / opaque combinator
    }
  }
}

/** Minimum nested `f`-heads before fuel-death counts as sage evidence. */
const BOHM_DEPTH = 5;
/** Head-steps are cheap; a deep impostor tower must be walked to its floor
 *  (the 26ι pseudo-sage bottoms out at level 17 — a fixed 5-level check called
 *  it Y, and so did the census until it was walked deeper). */
const BOHM_FUEL = 20_000;

/**
 * The Böhm-prefix sage test: a fixpoint combinator's Böhm tree is `f (f (f …))`
 * — every level, forever. Head-reduce `t·f` (f fresh), demand the spine head is
 * literally `f` applied to exactly one argument, descend into that argument,
 * and KEEP descending until the fuel dies. Any non-f floor within the budget is
 * a definitive rejection (a finite tower `fᵏ·u` is not a sage, however deep);
 * fuel-death after ≥ BOHM_DEPTH f-levels is the certificate — the strongest
 * finite evidence a semi-decidable property allows (Scott–Curry).
 */
function bohmSage(tree: Node, cap: number): boolean {
  const f = freshVars(1, freeNames(tree))[0];
  if (f.kind !== "free") return false; // freshVars only mints free vars
  const fuel = { steps: Math.max(cap, BOHM_FUEL) };
  let cur: Node = app(tree, f);
  for (let depth = 0; ; depth++) {
    const sp = headSpine(cur, fuel);
    if (!sp) return depth >= BOHM_DEPTH; // fuel died with every level so far f-headed
    if (sp.head.kind !== "free" || sp.head.name !== f.name || sp.args.length !== 1) return false; // bottomed out
    cur = sp.args[0];
  }
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
