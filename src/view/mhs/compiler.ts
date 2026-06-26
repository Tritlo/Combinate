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

// The prewarmed Prelude cache, fetched once and reused (copied per compile, not
// transferred). Resolves to null if it isn't vendored — then the worker compiles
// cold (slower). Fetched on the main thread, NOT in the worker (an async worker
// onmessage broke the Emscripten run — see worker.ts).
let cacheP: Promise<ArrayBuffer | null> | null = null;
function preludeCache(): Promise<ArrayBuffer | null> {
  if (!cacheP) cacheP = fetch(`${VENDOR}/base.mhscache`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  return cacheP;
}

/** Batch-compile free-typed Haskell to a combinator dump via the batch blob in a
 *  Web Worker. Resolves to the dump, or rejects with an honest reason (no blob, a
 *  type error, or a forced primitive). A fresh worker per call avoids the
 *  Emscripten single-`main` / shared-state pitfalls. ~30s with the prewarmed cache,
 *  ~65s cold (the batch blob runs the whole MicroHs compiler in wasm). */
export async function liveCompile(source: string, timeoutMs = 180_000): Promise<string> {
  const cache = await preludeCache();
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
    worker.postMessage({ source, cache });
  });
}
