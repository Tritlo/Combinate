import { type Node, type NodeId, app, comb, cloneTermDeep, exceedsNodes } from "./term";
import { RULES } from "./catalog";
import { kernelFor, type NativeOpts } from "./kernels";

/** Make every node id unique: clone any subtree whose id was already seen. An
 * optimize-mode rule may reuse an argument term twice (e.g. `(+)` threads `n`
 * into both branches); the first use keeps its ids (persists/glides in the view),
 * later uses become fresh copies — the same convention as the S rule's clone. */
function dedupIds(n: Node, seen: Set<NodeId>): Node {
  if (seen.has(n.id)) return cloneTermDeep(n);
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
 * the ι/SKI reduction rules:
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
 * (Internally, a collapsed named combinator (A, cons, …) only unfolds its
 * definition once it is *saturated* (applied to its full arity), so a partial
 * application like `(cons A)` stays a clean named node instead of dissolving
 * into its ι-tree early — tracked by `redexAtGo`'s `argsAbove` recursion param.)
 *
 * `fast` enables optimize mode: a saturated named combinator reduces by its
 * catalog `rule` (the law / Scott recursion) in ONE step, instead of unfolding
 * its SKI def and grinding ι/S/K/I. Off by default — raw SKI reduction (and
 * everything not in `RULES`: I/K/S/ι, undiscovered combinators) is unchanged.
 */
export function redexAt(n: Node, fast = false, native?: NativeOpts): Redex | null {
  return redexAtGo(n, 0, fast, native, false);
}

/** A mutable accumulator the search fills in so a caller can locate the redex without a second
 *  traversal: {@link Trace.path} is the sequence of `0` (fn) / `1` (arg) descents from the root to
 *  the redex node, and {@link Trace.oldRedex} is that node (the pre-step subtree). Only
 *  {@link stepWithPatch} passes one; every other entry point leaves it undefined (zero overhead). */
interface Trace {
  path: number[];
  oldRedex?: Node;
}

// `headChecked` skips the (kernel/rule) head scan when descending the *function* spine:
// the head comb is unchanged there, so if it didn't fire with N args it can't with N-1.
// The built-in ι/I/K/S/def handlers stay outside this scan and still run every level, so
// a deep head still fires. This turns scanning a settled D-deep spine to normal form from
// O(D²) (re-collecting the spine each level) into O(D) — the value-read/NF-check hotspot.
//
// `trace` (optional): when present, the base case that fires records `oldRedex = n` and the descent
// pushes/pops its direction onto `path`, so {@link stepWithPatch} learns the redex location as a
// by-product of the one search — see {@link Trace}. Passing it never changes what fires.
function redexAtGo(n: Node, argsAbove: number, fast: boolean, native: NativeOpts | undefined, headChecked: boolean, trace?: Trace): Redex | null {
  if (n.kind !== "app") return null;

  // optimize / native mode: reduce the leftmost-outermost *named* head redex — by a
  // native value op (ADR 10) when recognized, else by its catalog rule (fast mode).
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
          if (trace) trace.oldRedex = n;
          return { sym: head.sym, build: () => dedupIds(reapplyExtras(kernel.run(core) ?? RULES[head.sym](core), args, ka), new Set()) };
        }
        // Kernel-only primitive (e.g. Church `cmod`): no rule to fall back to, so the
        // match runs in *discovery* (only a redex if it fires; else reduce the operands
        // and revisit). This relaxes the "discovery is cheap" invariant for such syms —
        // acceptable because they're not on any canvas/hotbar (only reachable via authored
        // SKIQ source), so `firingRule`/app probes never hit them. A future kernel-only
        // primitive wanting cheap discovery should ship a catalog `def` fallback.
        const res = kernel.run(core);
        if (res) {
          if (trace) trace.oldRedex = n;
          return { sym: head.sym, build: () => dedupIds(reapplyExtras(res, args, ka), new Set()) };
        }
      }
      const rule = fast ? RULES[head.sym] : undefined;
      if (rule && args.length >= k) {
        if (trace) trace.oldRedex = n;
        return { sym: head.sym, build: () => dedupIds(reapplyExtras(rule(args.slice(0, k)), args, k), new Set()) };
      }
    }
  }

  const { fn, arg } = n;

  // ι x → x S K
  if (fn.kind === "iota") {
    if (trace) trace.oldRedex = n;
    return { sym: "ι", build: () => app(app(arg, comb("S")), comb("K")) };
  }
  // I x → x
  if (fn.kind === "comb" && fn.sym === "I") {
    if (trace) trace.oldRedex = n;
    return { sym: "I", build: () => arg };
  }
  // K x y → x          (n = ((K x) y),    so fn = (K x))
  if (fn.kind === "app" && fn.fn.kind === "comb" && fn.fn.sym === "K") {
    const x = fn.arg;
    if (trace) trace.oldRedex = n;
    return { sym: "K", build: () => x };
  }
  // S x y z → x z (y z) (n = (((S x) y) z), so fn = ((S x) y))
  if (fn.kind === "app" && fn.fn.kind === "app" && fn.fn.fn.kind === "comb" && fn.fn.fn.sym === "S") {
    const x = fn.fn.arg;
    const y = fn.arg;
    const z = arg;
    if (trace) trace.oldRedex = n;
    // z is duplicated: keep the original ids on the left (persist), fresh-clone
    // the right copy (the "copy" the view grows out of the source, §6.3).
    return { sym: "S", build: () => app(app(x, z), app(y, cloneTermDeep(z))) };
  }
  // A collapsed named combinator with no built-in rule (A, X, cons, …) in head
  // position: unfold its definition so it can reduce like its ι-tree — but only
  // once it has enough arguments to be saturated (arity defaults to 1, i.e. the
  // old eager behavior, if unknown).
  if (fn.kind === "comb" && fn.def && argsAbove + 1 >= (fn.arity ?? 1)) {
    const def = fn.def;
    if (trace) trace.oldRedex = n;
    return { sym: fn.sym, build: () => app(cloneTermDeep(def), arg) };
  }

  // No rule fires at the root: recurse left spine first (one more arg above),
  // then the argument (a fresh spine). Context apps keep their id (`{ ...n }`). The
  // function spine shares this head, so skip its head scan (`headChecked`); the argument
  // is a fresh spine, so its head must be scanned. `trace` records the descent direction
  // (0 = fn, 1 = arg) and un-does it on a dead branch, so on return `path` is the redex's location.
  if (trace) trace.path.push(0);
  const f = redexAtGo(fn, argsAbove + 1, fast, native, true, trace);
  if (f) return { sym: f.sym, build: () => ({ ...n, fn: f.build() }) };
  if (trace) trace.path[trace.path.length - 1] = 1;
  const a = redexAtGo(arg, 0, fast, native, false, trace);
  if (a) return { sym: a.sym, build: () => ({ ...n, arg: a.build() }) };
  if (trace) trace.path.pop();
  return null;
}

/** One normal-order (leftmost-outermost) reduction step, or `null` if `n` is
 *  already in normal form. See {@link redexAt} for the rules. */
export function step(n: Node, fast = false, native?: NativeOpts): Node | null {
  return redexAt(n, fast, native)?.build() ?? null;
}

/**
 * A structural description of one reduction step, for the incremental view (deeper-perf, ADR 18):
 * the whole new `root`, the rule that fired (`sym`), and — the point of it — WHERE it fired.
 * `path` locates the contracted node from the root (`0` = fn, `1` = arg); `oldRedex` is the subtree
 * there BEFORE the step and `replacement` the contractum that took its place. Everything outside
 * `oldRedex`↔`replacement` is untouched (the spine above keeps its ids and, under a frozen H-tree
 * arm, its positions), so the view can reflow just the changed neighbourhood instead of the whole
 * tree. `replacement` is the live subtree inside `root` (same ids), so no second `build()` runs.
 */
export interface StepPatch {
  root: Node;
  sym: string;
  path: number[];
  oldRedex: Node;
  replacement: Node;
}

/**
 * One reduction step as a {@link StepPatch}, or `null` if `n` is in normal form. Same
 * leftmost-outermost redex and same contractum as {@link step} — it just also reports the redex
 * location, gathered as a by-product of the one search (see {@link Trace}), so it costs no extra
 * traversal. The view derives its dirty id-set from `oldRedex` + `replacement` AFTER `expandDisplay`
 * (undiscovered-combinator expansion is a view concern, kept out of core).
 */
export function stepWithPatch(n: Node, argsAbove = 0, fast = false, native?: NativeOpts): StepPatch | null {
  const trace: Trace = { path: [] };
  const redex = redexAtGo(n, argsAbove, fast, native, false, trace);
  if (!redex || !trace.oldRedex) return null;
  const root = redex.build();
  // Follow the recorded path down the freshly-built root to the contractum — the same object that
  // build() placed there, so its ids match the tree the view will render.
  let replacement = root;
  for (const d of trace.path) {
    if (replacement.kind !== "app") break; // unreachable: the path only descends through app nodes
    replacement = d === 0 ? replacement.fn : replacement.arg;
  }
  return { root, sym: redex.sym, path: trace.path, oldRedex: trace.oldRedex, replacement };
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
export function normalize(n: Node, cap = 10_000, fast = false, native?: NativeOpts, maxNodes = 0): NormalizeResult {
  let cur = n;
  let steps = 0;
  for (; steps < cap; steps++) {
    // Size guard (opt-in): a step-capped reduction can still build a stack/heap-blowing tree
    // in few steps (the S rule clones). Checked every 32 steps so the cost is amortised; the
    // caller (e.g. the value matchers) bails to "not a value" instead of freezing/OOMing.
    if (maxNodes && (steps & 31) === 0 && exceedsNodes(cur, maxNodes)) return { term: cur, steps, done: false };
    const next = step(cur, fast, native);
    if (!next) return { term: cur, steps, done: true };
    cur = next;
  }
  return { term: cur, steps, done: false };
}

/**
 * The rule/combinator the next reduction step will fire — `"ι"`/`"I"`/`"K"`/`"S"`
 * for the built-ins, or a named bird's symbol — or `null` if `n` is in normal
 * form. Reads {@link redexAt}'s `sym` without building the contractum, so the
 * sonification layer (ADR 0005) can pick a tone per reduction
 * without allocating.
 */
export function firingRule(n: Node, fast = false, native?: NativeOpts): string | null {
  return redexAt(n, fast, native)?.sym ?? null;
}
