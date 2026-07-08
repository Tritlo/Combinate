/**
 * Build-time gallery generator (ADR 0007, post-process approach). For each curated
 * example: compile with the **Rust MicroHs dist**'s `toCombinators` (the `--entry`
 * flag — a pruned, rooted JSON closure), sanity-check it post-processes and reduces
 * to the expected value, and write the closure (`{ root, defs }`) to
 * public/vendor/mhs/examples/<name>.json (git-ignored, vendored). The in-browser
 * gallery fetches these and runs them with no compile — the instant "click an
 * example" path.
 *
 *   scripts/build-mhs-rust.sh && npx tsx scripts/gen-mhs-examples.ts
 *
 * Needs the built dist under public/vendor/mhs/ (compiler.mjs, wasm, comb, base.pkg,
 * lib). No gmhs / GHC — the same Rust runtime the browser uses.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { combinatorsToTree, type CombDef } from "../src/core/mhs";
import { normalize } from "../src/core/reduce";
import { read, render } from "../src/core/types";
import { EXAMPLES } from "../src/view/mhs/examples";

const DIST = "public/vendor/mhs";
const OUT = join(DIST, "examples");
await mkdir(OUT, { recursive: true });

type Manifest = { includeFiles: Record<string, string>; packages?: { dist: string; vfs: string }[] };
type Combinators = { status: string; root: string; defs: CombDef[]; error: string };
type Compiler = { toCombinators(src: string, entry: string, opts?: { module?: string }): Combinators; close(): void };

const manifest = JSON.parse(await readFile(join(DIST, "manifest.json"), "utf8")) as Manifest;
const { createCompiler } = (await import(pathToFileURL(join(DIST, "compiler.mjs")).href)) as {
  createCompiler(input: unknown): Promise<Compiler>;
};

const files: Record<string, Uint8Array> = {};
for (const [rel, vfs] of Object.entries(manifest.includeFiles)) files[vfs] = await readFile(join(DIST, rel));
for (const p of manifest.packages ?? []) files[p.vfs] = await readFile(join(DIST, p.dist));

const compiler = await createCompiler({
  wasm: await readFile(join(DIST, "microhs_runtime.wasm")),
  comb: await readFile(join(DIST, "mhs.comb")),
  files,
  packages: (manifest.packages ?? []).map((p) => p.vfs),
});

let failed = 0;
for (const ex of EXAMPLES) {
  const t0 = Date.now();
  const r = compiler.toCombinators(ex.source, "out", { module: "Ex" });
  if (r.status !== "ok") {
    console.log(`✗ ${ex.name}: toCombinators ${r.status} — ${r.error}`);
    failed++;
    continue;
  }
  const res = combinatorsToTree(r.defs, r.root);
  if ("error" in res) {
    console.log(`✗ ${ex.name}: rejected — ${res.error}`);
    failed++;
    continue;
  }
  const nf = normalize(res.tree, 3_000_000, true, undefined, 400_000);
  const v = read(nf.term, ex.read);
  const value = v ? render(v) : "<no value>";
  const json = JSON.stringify({ root: r.root, defs: r.defs });
  await writeFile(join(OUT, `${ex.name}.json`), json);
  console.log(`✓ ${ex.name}: ${r.defs.length} defs, ${(json.length / 1024).toFixed(1)}KB, value=${value} (${Date.now() - t0}ms)`);
}
compiler.close();
if (failed > 0) {
  console.error(`\n${failed} example(s) failed`);
  process.exit(1);
}
