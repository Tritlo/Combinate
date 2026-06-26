/**
 * Live MicroHs compile worker (ADR 0007): host the vendored **batch** MicroHs blob
 * (`/vendor/mhs/mhs-batch.js`, built by `nix/build-wasm.sh` from the fork) and
 * compile one program to a `-ddump-combinator` dump, headless.
 *
 * A *classic* worker — the Emscripten blob loads via `importScripts` and detects
 * `ENVIRONMENT_IS_WORKER`. We run `main` the Emscripten way: set `Module.arguments`,
 * write the source into the MEMFS in `preRun`, override `print` to capture stdout,
 * and let the runtime auto-run (`callMain` re-enters and blows the JS stack — use
 * auto-run). The dump is reported from `postRun`/`onExit` (the batch blob links
 * EXIT_RUNTIME, so stdout actually flushes — the stock interactive blob didn't).
 *
 * The base-package SOURCE is embedded in the blob's filesystem at `/lib` (the GHC
 * build can't serialize a .pkg), so we compile with `-i. -i/lib`. A trailing
 * stderr "No definition found for: Ex.main" is the harmless post-dump link error;
 * the dump itself (the lines with ` = `) is already on stdout. One compile per
 * worker — the caller (`compiler.ts`) terminates us after.
 */
/// <reference lib="webworker" />
declare function importScripts(...urls: string[]): void;

const post = (msg: { dump?: string; error?: string }): void => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<{ source: string }>): void => {
  const source = e.data.source;
  let captured = "";
  let errText = "";
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    // The dump is present iff a definition line (` = `) was printed; the trailing
    // "No definition found for: Ex.main" link error is expected and ignored.
    if (captured.includes(" = ")) post({ dump: captured });
    else post({ error: (errText.trim() || captured.trim() || "the compiler produced no combinators").split("\n").slice(-1)[0] });
  };

  (self as unknown as { Module: unknown }).Module = {
    arguments: ["-ddump-combinator", "-i.", "-i/lib", "Ex"], // base source is embedded at /lib
    print: (t: string) => {
      captured += t + "\n";
    },
    printErr: (t: string) => {
      errText += t + "\n";
    },
    preRun: [
      function (this: { FS: { writeFile(p: string, d: string): void } }) {
        this.FS.writeFile("Ex.hs", source); // CWD is /, found by -i.
      },
    ],
    postRun: [finish],
    onExit: finish,
    onAbort: (x: unknown) => {
      if (done) return;
      done = true;
      post({ error: `compiler aborted: ${errText.trim() || String(x)}` });
    },
  };

  try {
    importScripts("/vendor/mhs/mhs-batch.js");
  } catch (err) {
    if (!done) {
      done = true;
      post({ error: `couldn't load the MicroHs blob — build it with nix/build-wasm.sh (${(err as Error).message})` });
    }
  }
};
