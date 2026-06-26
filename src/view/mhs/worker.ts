/**
 * Web Worker entry for the MicroHs→combinator compiler (ADR 0007, §B3).
 *
 * Runs off the main thread so the (large) MicroHs WASM blob never touches first
 * paint. On a `{ id, source }` message it should dynamic-import the hosted blob
 * and call its `compileToComb(source)`, then post back `{ id, dump }` (a
 * `-ddump-combinator` string) or `{ id, error }`.
 *
 * Scaffold: there is no hosted blob yet, so it reports that. The real wiring is
 * the commented dynamic import below — a one-time, lazy `import()` of the hosted
 * URL, cached across calls.
 */

/** The slice of the worker global we use (DOM lib types `self` as a Window). */
type WorkerCtx = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};
const ctx = self as unknown as WorkerCtx;

// Lazily-loaded compiler handle (filled in when the blob lands).
// let mhs: { compileToComb(source: string): string } | undefined;
// async function ensureMhs() {
//   mhs ??= await import(/* @vite-ignore */ "<hosted-microhs-wasm-url>");
//   return mhs;
// }

ctx.addEventListener("message", async (event: MessageEvent) => {
  const { id, source } = event.data as { id: number; source: string };
  try {
    // const mhs = await ensureMhs();
    // const dump = mhs.compileToComb(source);
    // ctx.postMessage({ id, dump });
    void source;
    ctx.postMessage({ id, error: "MicroHs WASM blob not hosted yet (ADR 0007, Phase 0)." });
  } catch (e) {
    ctx.postMessage({ id, error: `mhs worker: ${(e as Error).message}` });
  }
});
