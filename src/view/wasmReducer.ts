/**
 * Browser adapter for the wasm raw reducer (`crates/reduce`) — a driven adapter (ADR 0001),
 * lazy-loaded like the egg re-folder. Wraps the resident `GraphSession` so the shell can run a
 * big raw reduction mostly in wasm (escaping the per-call codec floor): encode the term in
 * once, `stepBudget()` thousands of contractions resident, `snapshot()` the current term out
 * only for display. Used by the "turbo" reduction path (ADR 14/15) for big raw-combinator
 * trees — MicroHaskell-compiled programs — where the TS persistent reducer is GC-bound.
 */
import { type Node } from "../core/term";
import { type NativeOpts } from "../core/native";
import { encode, decode } from "../core/wasmCodec";

type WasmModule = typeof import("../../crates/reduce/pkg/reduce.js");
let mod: WasmModule | null = null;
let loading: Promise<WasmModule | null> | null = null;

/** Lazily load + init the wasm module. Returns null if it fails (caller falls back to TS). */
export async function loadWasmReducer(): Promise<WasmModule | null> {
  if (mod) return mod;
  if (!loading) {
    const t0 = performance.now();
    console.log("[combinate] loading Turbo reduce wasm (crates/reduce)…");
    loading = (async () => {
      try {
        const m = await import("../../crates/reduce/pkg/reduce.js");
        await m.default();
        mod = m;
        console.log(`[combinate] Turbo reduce wasm ready — ${(performance.now() - t0).toFixed(0)}ms`);
        return m;
      } catch (e) {
        console.warn(`[combinate] Turbo reduce wasm FAILED after ${(performance.now() - t0).toFixed(0)}ms — falling back to the TS reducer`, e);
        return null; // wasm unavailable — the shell keeps using the TS reducer
      }
    })();
  }
  return loading;
}

/** Whether the wasm reducer is loaded and ready (sync check for the eligibility gate). */
export const wasmReady = (): boolean => mod !== null;

/** A resident reduction of one term — the call-by-need GRAPH engine (sharing), so Scott
 *  arithmetic / fac-scale computations don't materialise the blown-up tree. Construct after
 *  {@link loadWasmReducer} resolves. */
export class WasmSession {
  private session: InstanceType<WasmModule["GraphSession"]> | null;
  private readonly symName: string[];
  private readonly freeName: string[];

  constructor(term: Node, opts?: NativeOpts, fast = false) {
    if (!mod) throw new Error("wasm reducer not loaded");
    const { data, symName, freeName } = encode(term, opts, fast); // opts → wasm kernels; fast → rule-based reduction
    this.symName = symName;
    this.freeName = freeName;
    this.session = new mod.GraphSession(data);
  }

  /** Run up to `maxSteps` more contractions resident in wasm; returns the steps done this
   *  call (0 once at normal form). No marshalling. */
  stepBudget(maxSteps: number): number {
    return this.session ? this.session.step_budget(maxSteps) : 0;
  }

  get isDone(): boolean {
    return this.session ? this.session.is_done() : true;
  }
  get totalSteps(): number {
    return this.session ? this.session.total_steps() : 0;
  }
  get nodeCount(): number {
    return this.session ? this.session.node_count() : 0;
  }

  /** Compact + marshal the current term out for display. */
  snapshot(): Node {
    if (!this.session) throw new Error("session freed");
    return decode(this.session.snapshot(), this.symName, this.freeName).term;
  }

  /** Release the wasm-side arena. Call when the reduction is abandoned/finished. */
  free(): void {
    this.session?.free();
    this.session = null;
  }
}
