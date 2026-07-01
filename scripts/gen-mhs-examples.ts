/**
 * Build-time gallery generator (ADR 0007, post-process approach). For each curated
 * example: compile with stock `gmhs -ddump-combinator`, prune the dump to just the
 * defs reachable from the root, post-process + bounded-reduce to sanity-check, and
 * write the pruned `.comb` to public/vendor/mhs/examples/ (git-ignored, vendored).
 *
 *   MHS=../MicroHs npx tsx scripts/gen-mhs-examples.ts
 *
 * Needs the stock MicroHs build (`$MHS/bin/gmhs`). The pruned dumps are the
 * gallery assets the in-browser panel fetches and runs with no wasm.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Node } from "../src/core/term";
import { dumpToTree, parseDump } from "../src/core/mhs";
import { step } from "../src/core/reduce";
import { read, render, type Ty } from "../src/core/types";
import { EXAMPLES } from "../src/view/mhs/examples";

const MHS = process.env.MHS ?? "../MicroHs";
const GMHS = join(MHS, "bin/gmhs");
const OUT = "public/vendor/mhs/examples";
mkdirSync(OUT, { recursive: true });

/** Prune a dump to the defs transitively reachable from `root` (keeps it tiny). */
function prune(dump: string, root: string): string {
  const defs = parseDump(dump);
  const nameRe = /[^\s()]+/g;
  const keep = new Set<string>();
  const visit = (name: string): void => {
    if (keep.has(name) || !defs.has(name)) return;
    keep.add(name);
    if (name.startsWith("Primitives.")) return;
    for (const m of defs.get(name)!.match(nameRe) ?? []) visit(m);
  };
  visit(root);
  return [...keep].filter((n) => defs.has(n)).map((n) => `${n} = ${defs.get(n)}`).join("\n") + "\n";
}

const exceeds = (n: Node, max: number): boolean => {
  let c = 0;
  const go = (m: Node): boolean => (++c > max ? true : m.kind === "app" && (go(m.fn) || go(m.arg)));
  return go(n);
};
const reduceTo = (n: Node, hint: Ty): string => {
  let cur = n;
  for (let i = 0; i < 120000; i++) {
    if (i % 128 === 0 && exceeds(cur, 90000)) return "<blow-up: too big to reduce without sharing>";
    const nx = step(cur, true);
    if (!nx) break;
    cur = nx;
  }
  const v = read(cur, hint);
  return v ? render(v) : "<no value>";
};
for (const ex of EXAMPLES) {
  const dir = mkdtempSync(join(tmpdir(), "mhsex-"));
  writeFileSync(join(dir, "Ex.hs"), ex.source);
  // gmhs prints the combinator dump to stdout, then errors out trying to link a
  // library module with no `main` — so the dump is in the throw's `stdout`.
  let dump: string;
  try {
    dump = execFileSync(GMHS, ["-ilib", `-i${dir}`, "-ddump-combinator", "Ex"], { cwd: MHS, encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    if (!out || !out.includes(" = ")) {
      console.log(`✗ ${ex.name}: gmhs failed — ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    dump = out;
  }
  const pruned = prune(dump, ex.root);
  const res = dumpToTree(pruned, ex.root);
  if (!("tree" in res)) {
    console.log(`✗ ${ex.name}: rejected — ${res.error}`);
    continue;
  }
  const t0 = Date.now();
  const value = reduceTo(res.tree, ex.read);
  writeFileSync(join(OUT, `${ex.name}.comb`), pruned);
  console.log(`✓ ${ex.name}: ${pruned.split("\n").length - 1} defs, ${(pruned.length / 1024).toFixed(1)}KB, value=${value} (${Date.now() - t0}ms)`);
}
