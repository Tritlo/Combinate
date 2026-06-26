/**
 * The compile surface for the Haskell panel (ADR 0007, post-process approach).
 * Two paths, both ending in `core/mhs.ts` post-processing a stock dump:
 *
 *  - **gallery** (always available): fetch a curated example's pre-compiled,
 *    pruned dump (a vendored asset) — no wasm, the reliable cold-start.
 *  - **live** (best-effort): a stock MicroHs blob in a Web Worker batch-compiles
 *    free-typed source to a `-ddump-combinator` dump. Gated on the vendored blob
 *    (`scripts/vendor-wasm.sh`); a fresh worker per compile keeps it stateless.
 *
 * The dump → ι tree step is the same pure `dumpToTree` for both.
 */
import { dumpToTree, type DumpResult } from "../../core/mhs";

const VENDOR = "/vendor/mhs";

/** Fetch a curated example's pre-compiled (pruned) combinator dump. */
export async function exampleDump(name: string): Promise<string> {
  const r = await fetch(`${VENDOR}/examples/${name}.comb`);
  if (!r.ok) throw new Error(`example '${name}' not vendored — run scripts/gen-mhs-examples.ts`);
  return r.text();
}

/** Post-process a dump into a spawnable ι tree (or a reject reason). Pure. */
export function toTree(dump: string, root: string): DumpResult {
  return dumpToTree(dump, root);
}

/** Batch-compile free-typed Haskell to a combinator dump via the stock blob in a
 *  Web Worker. Resolves to the dump, or rejects with an honest reason (no blob, a
 *  type error, or a forced primitive). A fresh worker per call avoids the
 *  Emscripten single-`main` / shared-state pitfalls. */
export function liveCompile(source: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url));
    } catch (e) {
      reject(new Error(`live compiler unavailable: ${(e as Error).message}`));
      return;
    }
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("compile timed out"))), timeoutMs);
    worker.onmessage = (e: MessageEvent<{ dump?: string; error?: string }>) =>
      done(() => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.dump!)));
    worker.onerror = (e) => done(() => reject(new Error(e.message || "live compiler failed to load")));
    worker.postMessage({ source });
  });
}
