import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { preProcessFile } from "typescript";
import { writeDemoPage } from "./ccc-page";

const run = promisify(execFile);
const [graphicsArgument, reviewArgument, outputArgument, ...extra] = process.argv.slice(2);
if (!graphicsArgument || !reviewArgument || !outputArgument || extra.length) {
  throw new Error("Usage: node --import tsx scripts/ccc-package.ts GRAPHICS_DIR CCC_REVIEW_DIR OUTPUT_DIR");
}
const graphics = resolve(graphicsArgument);
const review = resolve(reviewArgument);
const output = resolve(outputArgument);
const combinate = fileURLToPath(new URL("..", import.meta.url));
const microhs = join(review, "vendor/microhs");
if (output === graphics || !relative(graphics, output).startsWith("..") || !relative(output, graphics).startsWith("..")) {
  throw new Error("Graphics and output directories must be separate");
}

/** Read one Git value without invoking a shell. */
async function git(root: string, ...arguments_: string[]): Promise<string> {
  return (await run("git", ["-C", root, ...arguments_])).stdout.trimEnd();
}

/** Record the checkout and all current source changes. */
async function revision(root: string): Promise<{ revision: string; branch: string; dirty: boolean; status: string[] }> {
  const status = (await git(root, "status", "--porcelain=v1", "--untracked-files=all")).split("\n").filter(Boolean);
  return { revision: await git(root, "rev-parse", "HEAD"), branch: await git(root, "rev-parse", "--abbrev-ref", "HEAD"), dirty: status.length > 0, status };
}

/** Test for a regular file. Do not follow source symlinks. */
async function regularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Copy a file and create its parent directory. */
async function copy(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

/** Find the local TypeScript imports needed by the graphics scripts. */
async function renderingSources(): Promise<string[]> {
  const pending = (await readdir(join(combinate, "scripts"))).filter((name) => /^ccc-.*\.ts$/.test(name)).map((name) => `scripts/${name}`);
  const found = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (found.has(path)) continue;
    found.add(path);
    const source = await readFile(join(combinate, path), "utf8");
    for (const imported of preProcessFile(source, true).importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const base = resolve(combinate, dirname(path), imported.fileName);
      const candidates = [base, `${base}.ts`, `${base}.mts`, join(base, "index.ts")];
      const dependency = (await Promise.all(candidates.map(regularFile))).findIndex(Boolean);
      if (dependency < 0) throw new Error(`Missing local import ${imported.fileName} in ${path}`);
      const selected = relative(combinate, candidates[dependency]!);
      if (selected.startsWith("..")) throw new Error(`Import leaves the Combinate checkout: ${selected}`);
      pending.push(selected);
    }
  }
  return [...found, "package.json", "package-lock.json", "tsconfig.json", "CONTEXT.md", "LICENSE", "docs/ccc-graphics.md"].sort();
}

for (const name of ["index.html", "data.json", "closure.json", "scalar.wgsl"]) {
  if (!await regularFile(join(graphics, name))) throw new Error(`Missing gallery file: ${name}`);
}
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("Output directory must be empty; choose a new directory");
for (const item of await readdir(graphics, { withFileTypes: true })) {
  if (!item.isFile() || item.name.startsWith(".") || !/\.(html|css|js|mjs|wasm|wgsl|png|svg|json|md|txt)$/i.test(item.name)) continue;
  if (/(^|[-_.])(preview|validation|temp|tmp|check|checks|report|reports)([-_.]|$)/i.test(item.name)) continue;
  if (/^(SOURCE-|README\.txt$|public-(desktop|mobile)\.png$)/.test(item.name)) continue;
  await copy(join(graphics, item.name), join(output, item.name));
}

const runtime = ["bitlinear.wgsl", "layer.wgsl", "head.wgsl", "checks.wgsl", "rotary.bin", "web/bridge.js", "web/demo.html", "web/microhs.mjs", "web/microhs.wasm"];
const available = await Promise.all(runtime.map((path) => regularFile(join(review, "bin/ccc-spike", path))));
const hasModel = available.every(Boolean);
if (available.some(Boolean) && !hasModel) throw new Error(`Incomplete optional model runtime; missing ${runtime.filter((_, index) => !available[index]).join(", ")}`);
if (hasModel) {
  for (const path of runtime) await copy(join(review, "bin/ccc-spike", path), join(output, "model", path));
}
await copy(join(combinate, "LICENSE"), join(output, "LICENSES/Combinate-MIT.txt"));
await copy(join(microhs, "LICENSE"), join(output, "LICENSES/MicroHs-Apache-2.0.txt"));
const projectLicenses = (await readdir(review)).filter((name) => /^(LICEN[CS]E|COPYING)([.-]|$)/i.test(name));
for (const name of projectLicenses) {
  if (await regularFile(join(review, name))) await copy(join(review, name), join(output, "LICENSES", `microhsbitnet-${name}.txt`));
}
const revisions = {
  packagedAt: new Date().toISOString(),
  Combinate: { ...await revision(combinate), source: "https://github.com/Tritlo/Combinate" },
  microhsbitnet: { ...await revision(review), source: "https://github.com/Tritlo/microhsbitnet" },
  MicroHs: { ...await revision(microhs), source: "https://github.com/augustss/MicroHs", recordedSubmoduleRevision: (await git(review, "ls-files", "-s", "vendor/microhs")).split(/\s+/)[1] },
  optionalModelRuntimeIncluded: hasModel,
  modelWeightsIncluded: false,
};
await writeFile(join(output, "SOURCE-REVISIONS.json"), JSON.stringify(revisions, null, 2) + "\n");
const notice = `SOURCE AND LICENSE NOTICE

Combinate rendering code and layouts: Matthias Pall Gissurarson.
License: MIT. See LICENSES/Combinate-MIT.txt.
Source: https://github.com/Tritlo/Combinate

MicroHs compiler, runtime, and compiled library definitions: Lennart Augustsson
and contributors. License: Apache-2.0. See LICENSES/MicroHs-Apache-2.0.txt.
Source: https://github.com/augustss/MicroHs
The compiled closure and model WebAssembly include MicroHs code.

CCC compiler, example programs, and browser driver: microhsbitnet / BitNetComb.
Source: https://github.com/Tritlo/microhsbitnet
${projectLicenses.length ? `Project license files are copied under LICENSES: ${projectLicenses.join(", ")}.` : "No top-level microhsbitnet license file was found in the source checkout.\nThis package does not assert a project-wide license grant for that code or\nfor the generated output."}

The model weights and tokenizer are not included. The optional model page
fetches Microsoft's BitNet b1.58 2B4T deployment files from Hugging Face only
after the user starts it. Those files have their own upstream terms.
https://huggingface.co/microsoft/bitnet-b1.58-2B-4T

SOURCE-REVISIONS.json records the actual revisions and dirty state.
source.zip contains current on-disk files, including uncommitted changes in
selected paths. It is a scoped source snapshot, not a complete repository.
It contains tracked CCC files under spike/ccc, src, and cbits; root build and
context files; all ccc-*.ts scripts and their local rendering dependencies;
package locks; and the license notices. Other untracked files, model weights,
build outputs, and the MicroHs source checkout are excluded.
MicroHs source is available at its exact recorded revision. Its current dirty
state is recorded, but its uncommitted files are not included in source.zip.
This snapshot is not a claim of byte-identical builds across toolchains.
`;
await writeFile(join(output, "SOURCE-NOTICE.txt"), notice);
const readme = `CCC PROGRAM GALLERY

RUN LOCALLY
Extract ccc-demo.zip into an empty directory. Open a terminal in that directory:

  python3 -m http.server 8879 --bind 127.0.0.1

Open http://localhost:8879/ in a browser. No npm install or build is needed.
The gallery is static and remains readable without WebGPU. The small scalar
example needs a WebGPU browser and HTTPS or localhost. It loads no model.
Do not use a file:// URL for the GPU example. To serve a public copy, use HTTPS.
No hosting or publication is configured by this package.

OPTIONAL FULL-MODEL EXPERIMENT
${hasModel ? "Open http://localhost:8879/model/web/demo.html . The runtime is included." : "The optional model runtime was not available and is not included."}
Starting the model page downloads 1.18 GB of weights (1,178,623,988 bytes), plus
the tokenizer, from Hugging Face. Neither file is in this archive. A physical
WebGPU adapter, network access, and several GB of free memory are required.
The page runs five fixed prompts. It is a research demonstration.
The six-prompt reference check matched 52/52 tokens, but its 1% numerical error
target still fails. Token agreement does not establish numerical equivalence.

WHAT THE PAGE SHOWS
Compiler outputs are prepared at build time. The browser runs exported WGSL;
it does not compile edited Haskell. The GPU does not reduce the iota pictures.
The compact view keeps function and dictionary names. The expanded view includes
all reachable Haskell definitions, including unused methods and error paths.
Runtime operations, foreign calls, and typed literals remain named leaves.
Counts measure syntax occurrences, not executed GPU instructions.
Full vector SVG files can exceed browser DOM capacity. Preview the PNG files.
Comparison poster SVGs embed the expanded raster. Separate full SVG sources
and indexed tree grammars describe every expanded occurrence.

REBUILD FROM THE SOURCE SNAPSHOT
source.zip contains sibling Combinate and microhsbitnet-ccc-review directories.
It omits the model, installed dependencies, build outputs, and MicroHs sources.
See SOURCE-REVISIONS.json for exact revisions and dirty-state records.
Prerequisites: Git, make, GHC and the packages in spike/ccc/Makefile, Node/npm,
Clang, Python 3, zip, and an installed Chrome for image generation. The validated
host is macOS on Apple Silicon. See the source README files for tool versions.
From the directory where source.zip was extracted:

  git clone https://github.com/augustss/MicroHs.git microhsbitnet-ccc-review/vendor/microhs
  git -C microhsbitnet-ccc-review/vendor/microhs checkout --detach ${revisions.MicroHs.revision}
  make -C microhsbitnet-ccc-review/vendor/microhs bin/gmhs bin/cpphs mhs.conf
  make -C microhsbitnet-ccc-review model HF_BASE=https://huggingface.co/microsoft/bitnet-b1.58-2B-4T/resolve/04c3b9ad9361b824064a1f25ea60a8be9599b127
  make -C microhsbitnet-ccc-review/spike/ccc graphics-data
  cd Combinate
  npm ci
  node --import tsx scripts/ccc-graphics.ts ../microhsbitnet-ccc-review/bin/ccc-spike/graphics-data.json ../../rebuilt-graphics
  node --import tsx scripts/ccc-package.ts ../../rebuilt-graphics ../microhsbitnet-ccc-review ../../rebuilt-demo

The model download is required to regenerate the checkpoint statistics, but is
not required to serve this package. The source snapshot contains current files,
not just the Git revisions; uncommitted changes are included in selected paths.
The optional model runtime needs a separate Emscripten build. See
microhsbitnet-ccc-review/spike/ccc/README.md and its web-demo Makefile target.
Read SOURCE-NOTICE.txt and LICENSES before reusing source or generated material.
`;
await writeFile(join(output, "README.txt"), readme);

const staging = await mkdtemp(join(tmpdir(), "ccc-source-"));
try {
  const selected = [
    { root: combinate, prefix: "Combinate", paths: await renderingSources() },
    { root: review, prefix: "microhsbitnet-ccc-review", paths: (await git(review, "ls-files", "-z", "--", "spike/ccc", "src", "cbits", "Makefile", "README.md", "CONTEXT.md", ".gitignore", ".gitmodules")).split("\0").filter(Boolean) },
  ];
  const files: { path: string; sha256: string }[] = [];
  for (const group of selected) {
    for (const path of group.paths) {
      const source = join(group.root, path);
      if (!await regularFile(source)) continue;
      const name = `${group.prefix}/${path}`;
      await copy(source, join(staging, name));
      files.push({ path: name, sha256: createHash("sha256").update(await readFile(join(staging, name))).digest("hex") });
    }
  }
  for (const name of ["README.txt", "SOURCE-NOTICE.txt", "SOURCE-REVISIONS.json"]) await copy(join(output, name), join(staging, name));
  for (const name of await readdir(join(output, "LICENSES"))) await copy(join(output, "LICENSES", name), join(staging, "LICENSES", name));
  await writeFile(join(staging, "SOURCE-FILES.json"), JSON.stringify(files.sort((a, b) => a.path.localeCompare(b.path)), null, 2) + "\n");
  await run("zip", ["-q", "-r", join(output, "source.zip"), "."], { cwd: staging });
} finally {
  await rm(staging, { recursive: true, force: true });
}
await writeDemoPage(output, true);
await run("zip", ["-q", "-r", join(output, "ccc-demo.zip"), ".", "-x", "ccc-demo.zip", "./ccc-demo.zip"], { cwd: output });
console.log(`Packaged ${output}; optional model runtime ${hasModel ? "included" : "absent"}; no model weights included.`);
