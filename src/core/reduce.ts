import { type Node, type NodeId, app, comb, iota, freeVar } from "./term";
import { RULES } from "./catalog";
import { kernelFor, type NativeOpts } from "./kernels";

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

/** Make every node id unique: clone any subtree whose id was already seen. An
 * optimize-mode rule may reuse an argument term twice (e.g. `(+)` threads `n`
 * into both branches); the first use keeps its ids (persists/glides in the view),
 * later uses become fresh copies — the same convention as the S rule's clone. */
function dedupIds(n: Node, seen: Set<NodeId>): Node {
  if (seen.has(n.id)) return clone(n);
  seen.add(n.id);
  if (n.kind === "app") {
    const fn = dedupIds(n.fn, seen);
    const arg = dedupIds(n.arg, seen);
    return fn === n.fn && arg === n.arg ? n : { ...n, fn, arg };
  }
  return n;
}

/** Re-apply any args beyond the first `from` to `core` — the extras past a rule's or
 *  kernel's arity (so a rule/kernel only ever sees exactly its arity). */
function reapplyExtras(core: Node, args: Node[], from: number): Node {
  for (let i = from; i < args.length; i++) core = app(core, args[i]);
  return core;
}

/** Apply a catalog `rule` to the first `k` (its arity) of `args`, re-applying any extras. */
function applyRule(rule: (args: Node[]) => Node, args: Node[], k: number): Node {
  return reapplyExtras(rule(args.slice(0, k)), args, k);
}

/** The next redex in normal order: the rule it fires (`sym`) and a thunk that
 *  builds its contractum. `build` is the *only* allocating part — finding the
 *  redex (and reading `sym`) never mints ids, so {@link firingRule} can name the
 *  next step without cloning, and a stepping caller can read `sym` and `build()`
 *  the result from one traversal. */
interface Redex {
  sym: string;
  build: () => Node;
}

/**
 * Find the leftmost-outermost redex of `n`, or `null` if it is in normal form.
 * The single dispatch behind both {@link step} and {@link firingRule}. Mirrors
 * the reducer in `../MicroHs/iota/Check.hs`:
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
 *
 * `fast` enables optimize mode: a saturated named combinator reduces by its
 * catalog `rule` (the law / Scott recursion) in ONE step, instead of unfolding
 * its SKI def and grinding ι/S/K/I. Off by default — raw SKI reduction (and
 * everything not in `RULES`: I/K/S/ι, undiscovered combinators) is unchanged.
 */
export function redexAt(n: Node, argsAbove = 0, fast = false, native?: NativeOpts): Redex | null {
  return redexAtGo(n, argsAbove, fast, native, false);
}

// `headChecked` skips the (kernel/rule) head scan when descending the *function* spine:
// the head comb is unchanged there, so if it didn't fire with N args it can't with N-1.
// The built-in ι/I/K/S/def handlers stay outside this scan and still run every level, so
// a deep head still fires. This turns scanning a settled D-deep spine to normal form from
// O(D²) (re-collecting the spine each level) into O(D) — the value-read/NF-check hotspot.
function redexAtGo(n: Node, argsAbove: number, fast: boolean, native: NativeOpts | undefined, headChecked: boolean): Redex | null {
  if (n.kind !== "app") return null;

  // optimize / native mode: reduce the leftmost-outermost *named* head redex — by a
  // native value op (ADR 10) when recognised, else by its catalog rule (fast mode).
  if ((fast || native) && !headChecked) {
    // Collect the applied spine head-first. `push`+`reverse` is O(spine); the old
    // `unshift` was O(spine²) (it shifts the whole array each arg), which — re-run at
    // every redexAt recursion level — made big-term fast reduction super-linear.
    const args: Node[] = [];
    let head: Node = n;
    while (head.kind === "app") {
      args.push(head.arg);
      head = head.fn;
    }
    args.reverse();
    if (head.kind === "comb") {
      const k = head.arity ?? 1;
      // Kernel (ADR 11 — native values are the built-in kernels): a CHEAP registry
      // lookup during discovery; the expensive match + canonical re-encode happen in
      // `build`, which falls back to the catalog rule when the kernel returns null (so
      // `firingRule`/existence checks never trigger a match).
      const kernel = kernelFor(head.sym, native);
      if (kernel && args.length >= kernel.arity) {
        const ka = kernel.arity;
        const core = args.slice(0, ka); // a kernel only ever sees exactly its arity; the reducer reapplies extras
        if (RULES[head.sym]) {
          // Has a catalog-rule fallback (native value ops): cheap discovery, match in build.
          return { sym: head.sym, build: () => dedupIds(reapplyExtras(kernel.run(core) ?? RULES[head.sym](core), args, ka), new Set()) };
        }
        // Kernel-only primitive (e.g. Church `cmod`): no rule to fall back to, so the
        // match runs in *discovery* (only a redex if it fires; else reduce the operands
        // and revisit). This relaxes the "discovery is cheap" invariant for such syms —
        // acceptable because they're not on any canvas/hotbar (only reachable via authored
        // SKIQ source), so `firingRule`/app probes never hit them. A future kernel-only
        // primitive wanting cheap discovery should ship a catalog `def` fallback.
        const res = kernel.run(core);
        if (res) return { sym: head.sym, build: () => dedupIds(reapplyExtras(res, args, ka), new Set()) };
      }
      const rule = fast ? RULES[head.sym] : undefined;
      if (rule && args.length >= k) {
        return { sym: head.sym, build: () => dedupIds(applyRule(rule, args, k), new Set()) };
      }
    }
  }

  const { fn, arg } = n;

  // ι x → x S K
  if (fn.kind === "iota") return { sym: "ι", build: () => app(app(arg, comb("S")), comb("K")) };
  // I x → x
  if (fn.kind === "comb" && fn.sym === "I") return { sym: "I", build: () => arg };
  // K x y → x          (n = ((K x) y),    so fn = (K x))
  if (fn.kind === "app" && fn.fn.kind === "comb" && fn.fn.sym === "K") {
    const x = fn.arg;
    return { sym: "K", build: () => x };
  }
  // S x y z → x z (y z) (n = (((S x) y) z), so fn = ((S x) y))
  if (fn.kind === "app" && fn.fn.kind === "app" && fn.fn.fn.kind === "comb" && fn.fn.fn.sym === "S") {
    const x = fn.fn.arg;
    const y = fn.arg;
    const z = arg;
    // z is duplicated: keep the original ids on the left (persist), fresh-clone
    // the right copy (the "copy" the view grows out of the source, §6.3).
    return { sym: "S", build: () => app(app(x, z), app(y, clone(z))) };
  }
  // A collapsed named combinator with no built-in rule (A, X, cons, …) in head
  // position: unfold its definition so it can reduce like its ι-tree — but only
  // once it has enough arguments to be saturated (arity defaults to 1, i.e. the
  // old eager behaviour, if unknown).
  if (fn.kind === "comb" && fn.def && argsAbove + 1 >= (fn.arity ?? 1)) {
    const def = fn.def;
    return { sym: fn.sym, build: () => app(clone(def), arg) };
  }

  // No rule fires at the root: recurse left spine first (one more arg above),
  // then the argument (a fresh spine). Context apps keep their id (`{ ...n }`). The
  // function spine shares this head, so skip its head scan (`headChecked`); the argument
  // is a fresh spine, so its head must be scanned.
  const f = redexAtGo(fn, argsAbove + 1, fast, native, true);
  if (f) return { sym: f.sym, build: () => ({ ...n, fn: f.build() }) };
  const a = redexAtGo(arg, 0, fast, native, false);
  if (a) return { sym: a.sym, build: () => ({ ...n, arg: a.build() }) };
  return null;
}

/** One normal-order (leftmost-outermost) reduction step, or `null` if `n` is
 *  already in normal form. See {@link redexAt} for the rules. */
export function step(n: Node, argsAbove = 0, fast = false, native?: NativeOpts): Node | null {
  return redexAt(n, argsAbove, fast, native)?.build() ?? null;
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
export function normalize(n: Node, cap = 10_000, fast = false, native?: NativeOpts): NormalizeResult {
  let cur = n;
  let steps = 0;
  for (; steps < cap; steps++) {
    const next = step(cur, 0, fast, native);
    if (!next) return { term: cur, steps, done: true };
    cur = next;
  }
  return { term: cur, steps, done: false };
}

/**
 * The rule/combinator the next reduction step will fire — `"ι"`/`"I"`/`"K"`/`"S"`
 * for the built-ins, or a named bird's symbol — or `null` if `n` is in normal
 * form. Reads {@link redexAt}'s `sym` without building the contractum, so the
 * sonification layer (PLAN.md Phase A / ADR 0005) can pick a tone per reduction
 * without allocating.
 */
export function firingRule(n: Node, fast = false, argsAbove = 0, native?: NativeOpts): string | null {
  return redexAt(n, argsAbove, fast, native)?.sym ?? null;
}
