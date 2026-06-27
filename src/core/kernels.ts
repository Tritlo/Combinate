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
import { type Node } from "./term";
import { type NativeOpts, NUM_OPS, LIST_OPS, BOOL_OPS, numberOp, listOp, boolOp } from "./native";

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

// ---- built-in kernels: native values (ADR 10), gated by their optimize toggle ----
for (const sym of NUM_OPS) registerKernel(sym, { arity: 2, enabled: (o) => !!o.numbers, run: (a) => numberOp(sym, a) });
for (const sym of LIST_OPS) registerKernel(sym, { arity: sym === "concat" ? 1 : 2, enabled: (o) => !!o.lists, run: (a) => listOp(sym, a) });
for (const sym of BOOL_OPS) registerKernel(sym, { arity: sym === "not" ? 1 : 2, enabled: (o) => !!o.booleans, run: (a) => boolOp(sym, a) });
