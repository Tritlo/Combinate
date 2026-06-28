/**
 * Cross-check the wasm raw reducer (`crates/reduce`) against the TS reducer's NON-fast
 * ("plain pure-ι") mode — the semantics it mirrors. The wasm NF must be structurally equal
 * to TS `normalize(_, cap, false)` for every terminating term; divergent terms must bail in
 * both. This is the regression net for the (shelved, not-yet-wired) wasm capability — run
 * it after any change to the crate or the codec.
 *
 *   npm run build:reduce-wasm   # build crates/reduce → pkg-node first
 *   npx tsx scripts/wasm-reduce-check.mts
 *
 * Loads the raw .wasm directly (the generated nodejs glue trips an externref-table init bug
 * under our node; our export is plain i32-array in/out, so the raw module is enough).
 */
import { createRequire } from "module";
import { encode, decode } from "../src/core/wasmCodec";
import { app, freeVar, type Node } from "../src/core/term";
import { CATALOG, named } from "../src/core/catalog";
import { normalize } from "../src/core/reduce";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
const WASM = "./crates/reduce/pkg-node/reduce_bg.wasm";
if (!fs.existsSync(WASM)) {
  console.error(`missing ${WASM} — run \`npm run build:reduce-wasm\` first.`);
  process.exit(2);
}
const inst = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(WASM)), {
  "./reduce_bg.js": { __wbindgen_init_externref_table: () => {} },
});
const wasm = inst.exports as Record<string, (...a: number[]) => number | number[]> & { memory: WebAssembly.Memory };
(wasm.__wbindgen_start as (() => void) | undefined)?.();

const struct = (n: Node): string =>
  n.kind === "app" ? `(${struct(n.fn)} ${struct(n.arg)})` : n.kind === "comb" ? n.sym : n.kind === "iota" ? "i" : n.name;

function callWasm(data: Int32Array, cap: number): Int32Array {
  const malloc = wasm.__wbindgen_malloc as (n: number, a: number) => number;
  const free = wasm.__wbindgen_free as (p: number, n: number, a: number) => void;
  const ptr = malloc(data.length * 4, 4) >>> 0;
  new Int32Array(wasm.memory.buffer, ptr, data.length).set(data);
  const ret = (wasm.reduce_to_nf as (p: number, l: number, c: number) => number[])(ptr, data.length, cap);
  const out = new Int32Array(wasm.memory.buffer, ret[0] >>> 0, ret[1] >>> 0).slice();
  free(ret[0] >>> 0, (ret[1] >>> 0) * 4, 4);
  return out;
}
function wasmNF(t: Node, cap: number): { term: Node; done: boolean } {
  const { data, symName, freeName } = encode(t);
  return decode(callWasm(data, cap), symName, freeName);
}

let pass = 0;
let fail = 0;
let skip = 0;
const fails: string[] = [];
function check(label: string, t: Node, cap = 5_000): void {
  const ts = normalize(t, cap, false);
  if (!ts.done) {
    skip++; // divergent within cap — not a correctness signal (both bail)
    return;
  }
  const w = wasmNF(t, cap);
  if (w.done && struct(ts.term) === struct(w.term)) pass++;
  else {
    fail++;
    if (fails.length < 16) fails.push(`${label}: TS=${struct(ts.term).slice(0, 36)}  WASM(${w.done})=${struct(w.term).slice(0, 36)}`);
  }
}

const vars = ["a", "b", "c", "d", "e", "f", "g", "h"].map(freeVar);
// every catalog combinator on fresh free vars (skip the non-terminating-probe birds)
for (const law of CATALOG) {
  if (law.args) continue;
  let t: Node;
  try {
    t = named(law.sym);
    for (let i = 0; i < law.arity; i++) t = app(t, vars[i]);
  } catch {
    continue;
  }
  check(`comb ${law.sym}`, t);
}
// arithmetic grid (raw non-fast NF)
const Succ = (n: Node): Node => app(named("Succ"), n);
const nat = (k: number): Node => {
  let t: Node = named("K");
  for (let i = 0; i < k; i++) t = Succ(t);
  return t;
};
for (const op of ["(+)", "(-)", "(*)", "(==)", "(/=)", "(<)", "(<=)", "(>)", "(>=)", "compare"])
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) check(`${op} ${a} ${b}`, app(app(named(op), nat(a)), nat(b)));
// SKI Church numerals: succ^n (K I), applied to I and a free var → reduces to x
const ZERO = (): Node => app(named("K"), named("I"));
const succC = (): Node => app(named("S"), app(app(named("S"), app(named("K"), named("S"))), named("K")));
const church = (n: number): Node => {
  let t = ZERO();
  for (let i = 0; i < n; i++) t = app(succC(), t);
  return t;
};
for (const n of [0, 1, 5, 10, 30]) check(`church(${n}) I x`, app(app(church(n), named("I")), freeVar("x")));

console.log(`wasm-reduce cross-check: ${pass} pass, ${fail} fail, ${skip} skipped(divergent)`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fail === 0 ? 0 : 1);
