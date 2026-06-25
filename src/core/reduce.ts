import { type Node, app, comb, iota, freeVar } from "./term";

/** Deep-copy a term with fresh ids — used to duplicate the shared argument in
 * the S rule so every node in the result has a unique id (the view keys layout
 * and animation by id; sharing one node in two places would collapse them). */
function clone(n: Node): Node {
  switch (n.kind) {
    case "iota":
      return iota();
    case "comb":
      return comb(n.sym, n.def ? clone(n.def) : undefined, n.arity);
    case "free":
      return freeVar(n.name);
    case "app":
      return app(clone(n.fn), clone(n.arg));
  }
}

/**
 * One normal-order (leftmost-outermost) reduction step, or `null` if the term is
 * already in normal form. Mirrors the reducer in `../MicroHs/iota/Check.hs`:
 *
 * ```
 * ι x      → x S K
 * I x      → x
 * K x y    → x
 * S x y z  → x z (y z)
 * ```
 *
 * Structural app nodes above the contracted redex keep their id (so the view can
 * later tween persisting subtrees, §6.3); freshly built contracta get new ids.
 *
 * `argsAbove` is how many arguments this node is already applied to in the
 * enclosing spine; a collapsed named combinator (A, cons, …) only unfolds its
 * definition once it is *saturated* (applied to its full arity), so a partial
 * application like `(cons A)` stays a clean named node instead of dissolving
 * into its ι-tree early.
 */
export function step(n: Node, argsAbove = 0): Node | null {
  if (n.kind !== "app") return null;
  const { fn, arg } = n;

  // ι x → x S K
  if (fn.kind === "iota") return app(app(arg, comb("S")), comb("K"));
  // I x → x
  if (fn.kind === "comb" && fn.sym === "I") return arg;
  // K x y → x          (n = ((K x) y),    so fn = (K x))
  if (fn.kind === "app" && fn.fn.kind === "comb" && fn.fn.sym === "K") return fn.arg;
  // S x y z → x z (y z) (n = (((S x) y) z), so fn = ((S x) y))
  if (
    fn.kind === "app" &&
    fn.fn.kind === "app" &&
    fn.fn.fn.kind === "comb" &&
    fn.fn.fn.sym === "S"
  ) {
    const x = fn.fn.arg;
    const y = fn.arg;
    const z = arg;
    // z is duplicated: keep the original ids on the left (persist), fresh-clone
    // the right copy (the "copy" the view grows out of the source, §6.3).
    return app(app(x, z), app(y, clone(z)));
  }
  // A collapsed named combinator with no built-in rule (A, X, cons, …) in head
  // position: unfold its definition so it can reduce like its ι-tree — but only
  // once it has enough arguments to be saturated (arity defaults to 1, i.e. the
  // old eager behaviour, if unknown).
  if (fn.kind === "comb" && fn.def && argsAbove + 1 >= (fn.arity ?? 1)) {
    return app(clone(fn.def), arg);
  }

  // No rule fires at the root: recurse left spine first (one more arg above),
  // then the argument (a fresh spine).
  const fn2 = step(fn, argsAbove + 1);
  if (fn2) return { ...n, fn: fn2 };
  const arg2 = step(arg, 0);
  if (arg2) return { ...n, arg: arg2 };
  return null;
}

/** The result of running a term toward normal form. */
export interface NormalizeResult {
  term: Node;
  steps: number;
  /** `false` if the step cap was hit before reaching normal form (§6.4). */
  done: boolean;
}

/**
 * Reduce to normal form, or until `cap` steps elapse. The cap guards
 * non-terminating terms (e.g. Ω); on hitting it, returns the partial term with
 * `done: false`.
 */
export function normalize(n: Node, cap = 10_000): NormalizeResult {
  let cur = n;
  let steps = 0;
  for (; steps < cap; steps++) {
    const next = step(cur);
    if (!next) return { term: cur, steps, done: true };
    cur = next;
  }
  return { term: cur, steps, done: false };
}
