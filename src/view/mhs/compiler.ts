/**
 * The compile surface for the Haskell panel (ADR 0007, post-process approach).
 * Both paths end in `core/mhs.ts`'s `combinatorsToTree` over a `toCombinators`
 * JSON closure (`{ root, defs }`):
 *
 *  - **gallery** (always available): fetch a curated example's pre-compiled,
 *    pruned closure (a vendored JSON asset). No wasm — the instant path.
 *  - **live**: the Rust MicroHs web dist under `public/vendor/mhs/`. A single
 *    module worker owns one warm runtime instance and reuses it across compiles;
 *    the main thread resolves base-aware asset URLs, forwards init/compile, and
 *    runs the worker's closure through `combinatorsToTree`. Gated on the vendored
 *    dist (built by `scripts/build-mhs-rust.sh`).
 */
import { combinatorsToTree, type CombDef, type DumpResult } from "../../core/mhs";
import { vendorUrl } from "../../vendorUrl";

type RustStats = {
  reductions: bigint;
  liveNodes: bigint;
  currentNodes: bigint;
  gcCollections: bigint;
  lastLiveNodes: bigint;
  highWaterNodes: bigint;
};

type WorkerReply = {
  id: number;
  status: string;
  root?: string;
  defs?: CombDef[];
  error?: string;
  stats?: RustStats | null;
};

type Pending = {
  resolve: (result: DumpResult) => void;
  reject: (error: Error) => void;
  hardTimer: number;
};

const exampleUrl = (name: string): string => vendorUrl(`vendor/mhs/examples/${name}.json`);
const distBaseUrl = (): string => vendorUrl("vendor/mhs/");
const distUrl = (name: string): string => vendorUrl(`vendor/mhs/${name}`);

/** Fetch a curated example's pre-compiled (pruned) combinator closure and post-
 *  process it to a spawnable ι tree (or a reject reason) — the gallery's instant
 *  path. Throws if the asset isn't vendored (the caller falls back to live compile). */
export async function exampleTree(name: string): Promise<DumpResult> {
  const r = await fetch(exampleUrl(name));
  if (!r.ok) throw new Error(`example '${name}' not vendored — run scripts/gen-mhs-examples.ts`);
  const { root, defs } = (await r.json()) as { root: string; defs: CombDef[] };
  return combinatorsToTree(defs, root);
}

/** Warm the Rust compiler worker during the boot splash (dynamic-import the
 *  runtime, load the lib VFS + `base.pkg`). Best-effort — a missing local dist
 *  just reports honestly when the user actually compiles. */
export async function preloadCompiler(): Promise<void> {
  await compilerReady().catch(() => undefined);
}

/** Compile free-typed Haskell through the resident Rust MicroHs worker (one warm
 *  runtime, `base.pkg`): `toCombinators` returns the entry's pruned closure, which
 *  `combinatorsToTree` turns into a spawnable ι tree (or an honest reject reason).
 *  A type/compile error rejects; the runtime self-cancels at its `onPoll` deadline
 *  (`timeoutMs`); the hard timer only fires if the runtime never returns. */
export async function liveCompile(source: string, timeoutMs = 180_000): Promise<DumpResult> {
  await compilerReady();
  return new Promise((resolve, reject) => {
    const worker = compilerWorker;
    if (!worker) {
      reject(new Error("live compiler worker is not running"));
      return;
    }
    const id = ++seq;
    const hardTimer = window.setTimeout(() => resetWorker(new Error("compile timed out")), timeoutMs + 30_000);
    pending.set(id, { resolve, reject, hardTimer });
    worker.postMessage({ type: "compile", id, source, module: "Ex", entry: "out", timeoutMs });
  });
}

let compilerWorker: Worker | null = null;
let ready: Promise<void> | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function compilerReady(): Promise<void> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      ready = null;
      reject(new Error(`live compiler unavailable: ${(error as Error).message}`));
      return;
    }

    compilerWorker = worker;
    const initId = ++seq;
    const initTimer = window.setTimeout(() => resetWorker(new Error("compiler initialization timed out")), 180_000);
    // resetWorker rejects `pending`; the init promise is settled here directly.
    initReject = reject;

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const msg = event.data;
      if (msg.id === initId) {
        window.clearTimeout(initTimer);
        initReject = null;
        if (msg.status === "ready") resolve();
        else resetWorker(new Error(msg.error || "compiler failed to initialize"));
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return; // already settled (e.g. by a hard-timeout reset)
      pending.delete(msg.id);
      window.clearTimeout(entry.hardTimer);
      if (msg.stats) console.debug("MicroHs compile stats", msg.stats);
      // status "ok" → post-process the JSON closure (which may still reject with a
      // "no ι form"); any other status is a compile/type error → reject the promise.
      if (msg.status === "ok" && msg.defs && msg.root) entry.resolve(combinatorsToTree(msg.defs, msg.root));
      else entry.reject(new Error(msg.error || `compiler returned ${msg.status}`));
    };

    worker.onerror = (event) => {
      window.clearTimeout(initTimer);
      resetWorker(new Error(event.message || "compiler worker failed"));
    };

    worker.postMessage({
      type: "init",
      id: initId,
      compilerUrl: distUrl("compiler.mjs"),
      baseUrl: distBaseUrl(),
      wasmUrl: distUrl("microhs_runtime.wasm"),
      combUrl: distUrl("mhs.comb"),
      manifestUrl: distUrl("manifest.json"),
    });
  });
  return ready;
}

// The pending init promise's reject, so `resetWorker` can fail a stalled init.
let initReject: ((error: Error) => void) | null = null;

/** Tear down the worker and fail everything in flight — the hard-failure path
 *  (init/compile timeout or a worker error). The next compile re-inits fresh. */
function resetWorker(error: Error): void {
  compilerWorker?.terminate();
  compilerWorker = null;
  ready = null;
  for (const entry of pending.values()) {
    window.clearTimeout(entry.hardTimer);
    entry.reject(error);
  }
  pending.clear();
  initReject?.(error);
  initReject = null;
}
