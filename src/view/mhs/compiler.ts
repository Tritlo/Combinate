/**
 * The MicroHs compiler port (ADR 0007, §B3).
 *
 * `Compiler` is the boundary the panel talks to. Two implementations:
 *
 *  - `StubCompiler` — no wasm: keys off the bundled example sources and returns
 *    their canned `-ddump-combinator` dumps, run through the pure core. This
 *    makes the whole pipeline complete and testable *now*.
 *  - `WorkerCompiler` — a lazy adapter that (when the hosted blob lands) spins up
 *    a Web Worker on first use, dynamic-imports the MicroHs WASM off the main
 *    bundle, and calls its `compileToComb`. Today it is a scaffold that reports
 *    the blob is missing.
 *
 * Swapping the stub for the real thing is a one-line change in `makeCompiler`.
 *
 * `compile` returns the spawnable `tree` (basis combinators as named `comb`
 * nodes, so it reduces with the bird names visible) *and* its pure-ι `bitcode`
 * (the canonical Barker form for permalinks / leaderboard submission).
 */

import type { Node } from "../../core/term";
import { dumpToTree, treeToBitcode } from "../../core/mhs";
import { EXAMPLES } from "./examples";

/** A successful compile: a spawnable tree and its canonical pure-ι bit-code. */
export type CompileOk = { tree: Node; bitcode: string };
/** Compile result: a tree+bitcode, or a human-readable rejection. */
export type CompileResult = CompileOk | { error: string };

/** The compiler boundary the Haskell panel depends on. */
export interface Compiler {
  compile(source: string): Promise<CompileResult>;
}

/** Run a canned dump through the pure core into a compile result. */
function compileDump(dump: string, root?: string): CompileResult {
  const r = dumpToTree(dump, root);
  if ("error" in r) return r;
  return { tree: r.tree, bitcode: treeToBitcode(r.tree) };
}

/**
 * The default compiler until the WASM blob lands: it recognises the bundled
 * example sources (so loading an example and pressing compile works) and rejects
 * anything else honestly, rather than pretending to compile edited source.
 */
export class StubCompiler implements Compiler {
  async compile(source: string): Promise<CompileResult> {
    const norm = source.trim();
    const ex = EXAMPLES.find((e) => e.source.trim() === norm);
    if (!ex) {
      return {
        error:
          "stub compiler: only the bundled examples compile until the MicroHs→WASM blob lands (ADR 0007, Phase 0). Load an example below — your own source will compile once the real compiler is wired in.",
      };
    }
    return compileDump(ex.dump, ex.root);
  }
}

/**
 * Lazy Worker adapter for the hosted MicroHs WASM blob. The worker is created on
 * the first `compile` (never on first paint) and dynamic-imports the blob inside
 * the worker, keeping it off the main bundle. The worker returns a
 * `-ddump-combinator` string; the pure core (`dumpToTree`) turns it into a tree
 * on the main thread.
 *
 * Scaffold only: there is no blob yet, so it currently reports as much. Wire the
 * real worker by creating `./worker.ts` and switching `makeCompiler` over.
 */
export class WorkerCompiler implements Compiler {
  private worker?: Worker;
  private seq = 0;
  private readonly pending = new Map<number, (dump: string | { error: string }) => void>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      this.worker.addEventListener("message", (e: MessageEvent) => {
        const { id, dump, error } = e.data as { id: number; dump?: string; error?: string };
        const resolve = this.pending.get(id);
        if (resolve) {
          this.pending.delete(id);
          resolve(error ? { error } : (dump ?? { error: "mhs worker: empty response" }));
        }
      });
    }
    return this.worker;
  }

  async compile(source: string): Promise<CompileResult> {
    const worker = this.ensure();
    const id = ++this.seq;
    const reply = await new Promise<string | { error: string }>((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ id, source });
    });
    if (typeof reply !== "string") return reply;
    return compileDump(reply);
  }
}

/**
 * Pick the active compiler. Stub today; flip to `new WorkerCompiler()` once the
 * hosted MicroHs WASM blob and `./worker.ts` are in place.
 */
export function makeCompiler(): Compiler {
  return new StubCompiler();
}
