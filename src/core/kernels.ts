/**
 * The kernel registry (ADR 11) — bind a named combinator to a **pure** native JS
 * primitive (MicroHs-FFI style, but no IO). One registry + one reducer hook: at a
 * saturated `comb` head, `reduce.ts` asks {@link kernelFor}; if a kernel is registered
 * and its gate is open, the redex's `build` runs `kernel.run(args)` and falls back to the
 * catalog rule when it returns `null` (operands not recognised as values). A kernel emits
 * the exact canonical pure tree — it never leaks a native payload — so the round-trip
 * invariant holds by construction, exactly like native values (which are the built-in
 * kernels registered here).
 *
 * Contract: deterministic, side-effect-free, no-throw; return `null` to fall back; don't
 * force operands the rule wouldn't; cap materialised output. A kernel's own value-matching
 * must run the reducer **without** kernels (matchers pass no opts), so it can't re-enter.
 */
import { type Node, app } from "./term";
import { type NativeOpts, NUM_OPS, LIST_OPS, BOOL_OPS, numberOp, listOp, boolOp } from "./native";
import { normalize } from "./reduce";
import { matchChurch, churchNum } from "./church";

export type { NativeOpts };

/** A native primitive bound to a named combinator. */
export interface Kernel {
  /** How many applied args saturate it (cheap redex discovery). */
  arity: number;
  /** Gate: the kernel fires only if this returns true. Absent = always on. */
  enabled?: (opts: NativeOpts) => boolean;
  /** Compute the contractum from the full arg spine, or `null` to fall back. */
  run: (args: Node[]) => Node | null;
}

const KERNELS = new Map<string, Kernel>();

/** Bind a named combinator to a pure native kernel. */
export function registerKernel(sym: string, kernel: Kernel): void {
  KERNELS.set(sym, kernel);
}

/** The kernel for `sym` if registered and enabled for `opts`, else undefined. */
export function kernelFor(sym: string, opts: NativeOpts | undefined): Kernel | undefined {
  const k = KERNELS.get(sym);
  if (!k) return undefined;
  if (k.enabled && !k.enabled(opts ?? {})) return undefined;
  return k;
}

/** The arity of a registered kernel `sym`, for the SKIQ parser to resolve kernel-only
 *  primitives (which aren't catalog combinators). Undefined if not a kernel. */
export function kernelArity(sym: string): number | undefined {
  return KERNELS.get(sym)?.arity;
}

// ---- built-in kernels: native values (ADR 10), gated by their optimize toggle ----
for (const sym of NUM_OPS) registerKernel(sym, { arity: 2, enabled: (o) => !!o.numbers, run: (a) => numberOp(sym, a) });
for (const sym of LIST_OPS) registerKernel(sym, { arity: sym === "concat" ? 1 : 2, enabled: (o) => !!o.lists, run: (a) => listOp(sym, a) });
for (const sym of BOOL_OPS) registerKernel(sym, { arity: sym === "not" ? 1 : 2, enabled: (o) => !!o.booleans, run: (a) => boolOp(sym, a) });

// ---- a pure Church kernel: `cmod a b = a mod b` on Church numerals (always on). It
// unblocks the SKIQ gcd (raw Church Euclid is over budget — ADR 9/10): the answer builds
// Euclid from `cmod` + Y. Match operands with a kernel-FREE reducer so it can't re-enter.
const CHURCH_CAP = 60_000;
const MAX_CHURCH = 4096; // cap materialised output like MAX_NAT (a Church numeral is also size ∝ value)
const noKernels = (n: Node, cap: number): { term: Node; done: boolean } => normalize(n, cap, true);
registerKernel("cmod", {
  arity: 2,
  run: (args) => {
    const a = matchChurch(args[0], noKernels, CHURCH_CAP);
    if (a === null) return null;
    const b = matchChurch(args[1], noKernels, CHURCH_CAP);
    if (b === null) return null;
    const m = b === 0 ? a : a % b; // total: `a mod 0 = a` (the gcd answer never hits it; avoids a stuck term)
    if (m > MAX_CHURCH) return null;
    let res = churchNum(m);
    for (let i = 2; i < args.length; i++) res = app(res, args[i]);
    return res;
  },
});
