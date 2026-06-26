/**
 * Live MicroHs compile worker (ADR 0007): host the stock, vendored MicroHs blob
 * (`/vendor/mhs/mhs-embed.js`, built from `MicroHs.Main`) and batch-compile one
 * program to a `-ddump-combinator` dump.
 *
 * A *classic* worker — the Emscripten blob loads via `importScripts` and detects
 * `ENVIRONMENT_IS_WORKER`, so its node/`require` paths stay dormant. The blob does
 * not export `callMain`, so we run `main` the Emscripten way: set `Module.arguments`,
 * write the source into the MEMFS in `preRun`, override `print` to capture stdout,
 * and let the runtime auto-run; the dump is reported from `postRun`/`onExit`.
 *
 * NB: the vendored blob is the *interactive playground* build (`mhsi`), whose base
 * package is linked for the REPL, not for a headless batch compile — so this path
 * is best-effort and currently degrades to an honest error (the package/Prelude
 * setup the REPL does isn't reproduced here). The gallery (pre-compiled dumps) is
 * the reliable path; a clean live path needs a batch blob or a `compileToComb`
 * export (PLAN.md / ADR 0007 follow-up). One compile per worker — the caller
 * (`compiler.ts`) terminates us after.
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
    if (captured.includes(" = ")) post({ dump: captured });
    else
      post({
        error:
          (errText.trim() || captured.trim() || "the live compiler produced no combinators").split("\n")[0] +
          " — live compile is experimental; pick a gallery example to compile offline",
      });
  };

  (self as unknown as { Module: unknown }).Module = {
    arguments: ["-i.", "-i/home/web_user", "-ddump-combinator", "Ex"],
    print: (t: string) => {
      captured += t + "\n";
    },
    printErr: (t: string) => {
      errText += t + "\n";
    },
    preRun: [
      function (this: { FS: { writeFile(p: string, d: string): void; chdir(p: string): void } }) {
        try {
          this.FS.chdir("/home/web_user");
        } catch {
          /* dir may not exist in this build */
        }
        this.FS.writeFile("Ex.hs", source);
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
    importScripts("/vendor/mhs/mhs-embed.js");
  } catch (err) {
    if (!done) {
      done = true;
      post({ error: `couldn't load the MicroHs blob — run scripts/vendor-wasm.sh (${(err as Error).message})` });
    }
  }
};
