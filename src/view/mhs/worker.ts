/**
 * Live MicroHs compile worker (ADR 0007) — the **rust-js-ffi** backend.
 *
 * A *module* worker that owns ONE warm runtime instance across every compile
 * (the old emscripten path spawned a fresh classic worker per compile). On
 * `init` it dynamic-imports the vendored `compiler.mjs`, loads the manifest's
 * lib files + the pre-typechecked `base.pkg` into the runtime VFS, and builds a
 * warm `createCompiler({ wasm, comb, files, packages, onPoll })` — `packages`
 * adds `-p<pkg>` so `Prelude`/`Data.*` load from the package instead of
 * recompiling (this replaced the old prewarm `.mhscache`/`-CR` path).
 *
 * Each `compile` calls `toCombinators(source, entry, { module })`, which roots
 * and prunes the program at the entry value (the compiler's `--entry` flag — no
 * fake `main`, no failure to scrape) and returns the reachable closure as a
 * structured JSON `defs` array + the explicit qualified `root`. `core/mhs.ts`
 * (`combinatorsToTree`) turns that into the ι tree; the worker just forwards it.
 *
 * `toCombinators()` is synchronous — it blocks the worker thread through the whole
 * reduction — so the timeout is enforced by the `onPoll` **deadline** the runtime
 * checks between reduction slices (cooperative cancel → `status: "cancelled"`),
 * which stops a runaway WITHOUT discarding the warm instance. A posted message
 * could not interrupt the blocked thread anyway, so there is no cancel channel;
 * the main thread's hard-timeout worker reset (compiler.ts) is the rare fallback
 * if the runtime never returns.
 */
/// <reference lib="webworker" />
export {};

type InitMessage = {
  type: "init";
  id: number;
  compilerUrl: string;
  baseUrl: string;
  wasmUrl: string;
  combUrl: string;
  manifestUrl: string;
};

type CompileMessage = {
  type: "compile";
  id: number;
  source: string;
  module?: string;
  entry?: string;
  timeoutMs: number;
};

type InMessage = InitMessage | CompileMessage;

type CompileStats = {
  reductions: bigint;
  liveNodes: bigint;
  currentNodes: bigint;
  gcCollections: bigint;
  lastLiveNodes: bigint;
  highWaterNodes: bigint;
};

/** A `toCombinators` result: the entry's pruned closure as structured JSON `defs`
 *  (opaque here — `core/mhs.ts` interprets them) plus the explicit qualified root. */
type CombinatorsOut = {
  status: string;
  root: string;
  defs: unknown[];
  error: string;
  stats: CompileStats | null;
};

type Compiler = {
  toCombinators(source: string, entry: string, opts?: { module?: string; flags?: string[] }): CombinatorsOut;
  close(): void;
};

type CompilerModule = {
  createCompiler(input: {
    wasm: ArrayBuffer;
    comb: ArrayBuffer;
    files: Record<string, Uint8Array>;
    packages: string[];
    onPoll: (stepsSoFar: bigint | number) => boolean;
  }): Promise<Compiler>;
};

type Manifest = {
  includeFiles: Record<string, string>;
  packages?: { dist: string; vfs: string }[];
};

type ActiveCompile = { id: number; deadline: number };

let compiler: Compiler | null = null;
let active: ActiveCompile | null = null;

const post = (msg: {
  id: number;
  status: string;
  root?: string;
  defs?: unknown[];
  error?: string;
  stats?: CompileStats | null;
}): void => self.postMessage(msg);

self.onmessage = (event: MessageEvent<InMessage>): void => {
  const msg = event.data;
  if (msg.type === "init") void init(msg);
  else compile(msg);
};

async function init(msg: InitMessage): Promise<void> {
  try {
    const mod = (await import(/* @vite-ignore */ msg.compilerUrl)) as CompilerModule;
    const manifest = (await fetchJson(msg.manifestUrl)) as Manifest;
    const files: Record<string, Uint8Array> = {};
    const packages = (manifest.packages ?? []).map((p) => p.vfs);

    for (const [distRel, vfsPath] of Object.entries(manifest.includeFiles)) {
      files[vfsPath] = new Uint8Array(await fetchBytes(new URL(distRel, msg.baseUrl).href));
    }
    for (const p of manifest.packages ?? []) {
      files[p.vfs] = new Uint8Array(await fetchBytes(new URL(p.dist, msg.baseUrl).href));
    }

    compiler?.close();
    compiler = await mod.createCompiler({
      wasm: await fetchBytes(msg.wasmUrl),
      comb: await fetchBytes(msg.combUrl),
      files,
      packages,
      onPoll: () => active !== null && performance.now() >= active.deadline,
    });
    post({ id: msg.id, status: "ready" });
  } catch (error) {
    post({ id: msg.id, status: "error", error: errorMessage(error) });
  }
}

function compile(msg: CompileMessage): void {
  if (!compiler) {
    post({ id: msg.id, status: "error", error: "compiler is not initialized" });
    return;
  }
  active = { id: msg.id, deadline: performance.now() + msg.timeoutMs };
  try {
    const out = compiler.toCombinators(msg.source, msg.entry ?? "out", { module: msg.module ?? "Ex", flags: ["-q"] });
    post({ id: msg.id, status: out.status, root: out.root, defs: out.defs, error: out.error, stats: out.stats });
  } catch (error) {
    post({ id: msg.id, status: "error", error: errorMessage(error) });
  } finally {
    active = null;
  }
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
