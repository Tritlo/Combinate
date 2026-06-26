/**
 * Live MicroHs compile worker (ADR 0007): host the stock, vendored MicroHs blob
 * (`/vendor/mhs/mhs-embed.js`, built from `MicroHs.Main` with the base package
 * embedded) and batch-compile one program to a `-ddump-combinator` dump.
 *
 * A *classic* worker — the Emscripten blob loads via `importScripts` and detects
 * `ENVIRONMENT_IS_WORKER`, so its node/`require` paths stay dormant. We override
 * `print` to capture stdout (the playground discards it), write the source to the
 * MEMFS, and `callMain(['-ddump-combinator','Ex'])`. One compile per worker — the
 * caller (`compiler.ts`) terminates us after, sidestepping Emscripten's single-run
 * `main` and any cross-compile global state.
 */
/// <reference lib="webworker" />
declare function importScripts(...urls: string[]): void;

interface EmscriptenModule {
  FS: { writeFile(path: string, data: string): void };
  callMain(args: string[]): number;
}

let out = "";
const ready: Promise<EmscriptenModule> = new Promise((resolve, reject) => {
  // Emscripten reads this global before the blob script runs.
  (self as unknown as { Module: unknown }).Module = {
    noInitialRun: true,
    noExitRuntime: true,
    print: (t: string) => {
      out += t + "\n";
    },
    printErr: () => {},
    onRuntimeInitialized: () => resolve((self as unknown as { Module: EmscriptenModule }).Module),
    onAbort: (e: unknown) => reject(new Error(`compiler aborted: ${String(e)}`)),
  };
  try {
    importScripts("/vendor/mhs/mhs-embed.js");
  } catch (e) {
    reject(new Error(`couldn't load the MicroHs blob — run scripts/vendor-wasm.sh (${(e as Error).message})`));
  }
});

self.onmessage = async (e: MessageEvent<{ source: string }>): Promise<void> => {
  try {
    const M = await ready;
    out = "";
    M.FS.writeFile("Ex.hs", e.data.source);
    try {
      M.callMain(["-ddump-combinator", "Ex"]);
    } catch (err) {
      // Emscripten throws an ExitStatus on a clean exit — fine if we got the dump.
      if (!out.includes(" = ")) throw err;
    }
    if (!out.includes(" = ")) {
      (self as unknown as Worker).postMessage({ error: "no combinators emitted — the program didn't type-check or compile" });
      return;
    }
    (self as unknown as Worker).postMessage({ dump: out });
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: (err as Error).message ?? String(err) });
  }
};
