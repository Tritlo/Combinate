/**
 * Cross-check the wasm raw reducer (`crates/reduce`) against the TS reducer's NON-fast
 * ("plain pure-ι") mode — the semantics it mirrors. The wasm NF must be structurally equal
 * to TS `normalize(_, cap, false)` for every terminating term; divergent terms must bail in
 * both. This is the parity oracle for the shipped "Turbo" wasm engine (ADR 16/19) — run
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
import { CATALOG, lamN, named } from "../src/core/catalog";
import { normalize } from "../src/core/reduce";
import { type NativeOpts } from "../src/core/native";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
const WASM = "./crates/reduce/pkg-node/reduce_bg.wasm";
if (!fs.existsSync(WASM)) {
  console.error(`missing ${WASM} — run \`npm run build:reduce-wasm\` first.`);
  process.exit(2);
}
const mod = new WebAssembly.Module(fs.readFileSync(WASM));
// Stub the wasm-bindgen glue imports generically (names are hashed): no-ops, except the
// panic hook which throws. Our exports are plain i32-array in/out, so no real glue runs.
const imports: Record<string, Record<string, (...a: number[]) => unknown>> = {};
for (const im of WebAssembly.Module.imports(mod)) {
  (imports[im.module] ??= {})[im.name] = im.name.includes("throw")
    ? () => {
        throw new Error("wasm panic");
      }
    : () => undefined;
}
const inst = new WebAssembly.Instance(mod, imports);
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

// Drive the resident Session in `batch`-sized step budgets (exercising compaction +
// snapshot between batches), then snapshot the result. The wasm-bindgen struct is reached
// via the raw `session_*` exports + the `__wbg_session_free` finalizer.
const malloc = wasm.__wbindgen_malloc as (n: number, a: number) => number;
const free = wasm.__wbindgen_free as (p: number, n: number, a: number) => void;
const S = wasm as unknown as {
  session_new: (p: number, l: number) => number;
  session_step_budget: (h: number, n: number) => number;
  session_is_done: (h: number) => number;
  session_total_steps: (h: number) => number;
  session_snapshot: (h: number) => number[];
  __wbg_session_free: (h: number, x: number) => void;
  graphsession_new: (p: number, l: number) => number;
  graphsession_step_budget: (h: number, n: number) => number;
  graphsession_is_done: (h: number) => number;
  graphsession_snapshot: (h: number) => number[];
  __wbg_graphsession_free: (h: number, x: number) => void;
};
// The call-by-need GRAPH session (sharing) — driven the same way; its snapshot is a DAG.
function graphNF(t: Node, cap: number): { term: Node; done: boolean } {
  const { data, symName, freeName } = encode(t);
  const ptr = malloc(data.length * 4, 4) >>> 0;
  new Int32Array(wasm.memory.buffer, ptr, data.length).set(data);
  const h = S.graphsession_new(ptr, data.length);
  let total = 0;
  while (total < cap) {
    const did = S.graphsession_step_budget(h, 500);
    total += did;
    if (S.graphsession_is_done(h) || did === 0) break;
  }
  const ret = S.graphsession_snapshot(h);
  const out = new Int32Array(wasm.memory.buffer, ret[0] >>> 0, ret[1] >>> 0).slice();
  free(ret[0] >>> 0, (ret[1] >>> 0) * 4, 4);
  const done = !!S.graphsession_is_done(h);
  S.__wbg_graphsession_free(h, 0);
  return { term: decode(out, symName, freeName).term, done };
}
function sessionNF(t: Node, batch: number, cap: number): { term: Node; done: boolean } {
  const { data, symName, freeName } = encode(t);
  const ptr = malloc(data.length * 4, 4) >>> 0;
  new Int32Array(wasm.memory.buffer, ptr, data.length).set(data);
  const h = S.session_new(ptr, data.length);
  let total = 0;
  while (total < cap) {
    const did = S.session_step_budget(h, batch);
    total += did;
    if (S.session_is_done(h) || did === 0) break;
  }
  const ret = S.session_snapshot(h);
  const out = new Int32Array(wasm.memory.buffer, ret[0] >>> 0, ret[1] >>> 0).slice();
  free(ret[0] >>> 0, (ret[1] >>> 0) * 4, 4);
  const done = !!S.session_is_done(h);
  S.__wbg_session_free(h, 0);
  return { term: decode(out, symName, freeName).term, done };
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
  const expect = struct(ts.term);
  // one-shot reduce_to_nf
  const w = wasmNF(t, cap);
  // resident persistent session (small batch → exercises compaction + snapshot between batches)
  const s = sessionNF(t, 7, cap);
  // resident GRAPH session (call-by-need sharing); its DAG snapshot expands to the same tree
  const g = graphNF(t, cap);
  const okW = w.done && struct(w.term) === expect;
  const okS = s.done && struct(s.term) === expect;
  const okG = g.done && struct(g.term) === expect;
  if (okW && okS && okG) pass++;
  else {
    fail++;
    if (fails.length < 16) fails.push(`${label}: TS=${expect.slice(0, 30)} | one-shot=${okW} | session=${okS} | graph=${okG}`);
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

// ---- session-specific: def must survive snapshot/compaction (Codex's regression), and the
// result must be batch-invariant (same NF whatever the step-budget granularity). ----
let sPass = 0;
let sFail = 0;
function sessionInvariant(label: string, t: Node, cap = 5_000): void {
  const expect = struct(normalize(t, cap, false).term);
  for (const batch of [1, 2, 3, 13, 5000]) {
    // batch=1 forces a snapshot/compaction after a single step — the def prefix must persist
    const s = batch === 1 ? sessionStepThenFinish(t, cap) : sessionNF(t, batch, cap);
    if (!s.done || struct(s.term) !== expect) {
      sFail++;
      if (fails.length < 16) fails.push(`${label} [batch=${batch}]: expected ${expect.slice(0, 30)}, got ${struct(s.term).slice(0, 30)}`);
      return;
    }
  }
  sPass++;
}
// step once, snapshot (compact), then run to NF — the harshest compaction timing
function sessionStepThenFinish(t: Node, cap: number): { term: Node; done: boolean } {
  const { data, symName, freeName } = encode(t);
  const ptr = malloc(data.length * 4, 4) >>> 0;
  new Int32Array(wasm.memory.buffer, ptr, data.length).set(data);
  const h = S.session_new(ptr, data.length);
  S.session_step_budget(h, 1);
  const snap1 = S.session_snapshot(h); // snapshot (compacts the arena) + discard
  free(snap1[0] >>> 0, (snap1[1] >>> 0) * 4, 4);
  let total = 1;
  while (total < cap) {
    const did = S.session_step_budget(h, 5000);
    total += did;
    if (S.session_is_done(h) || did === 0) break;
  }
  const ret = S.session_snapshot(h);
  const out = new Int32Array(wasm.memory.buffer, ret[0] >>> 0, ret[1] >>> 0).slice();
  free(ret[0] >>> 0, (ret[1] >>> 0) * 4, 4);
  const done = !!S.session_is_done(h);
  S.__wbg_session_free(h, 0);
  return { term: decode(out, symName, freeName).term, done };
}
sessionInvariant("(((I B) x) y) z [def-after-compact]", app(app(app(app(named("I"), named("B")), freeVar("x")), freeVar("y")), freeVar("z")));
sessionInvariant("church(60) I x", app(app(church(60), named("I")), freeVar("x")));
sessionInvariant("(*) 3 3", app(app(named("(*)"), nat(3)), nat(3)));

// ---- the GRAPH session's NUMBER KERNELS (encode with opts.numbers) must match TS
// `normalize(_, false, {numbers:true})` — clean canonical Scott arithmetic, no blow-up. ----
let kPass = 0;
let kFail = 0;
function graphKernelNF(t: Node, cap: number, opts: { numbers?: boolean; lists?: boolean; booleans?: boolean } = { numbers: true }, fast = false): { term: Node; done: boolean } {
  const { data, symName, freeName } = encode(t, opts, fast);
  const ptr = malloc(data.length * 4, 4) >>> 0;
  new Int32Array(wasm.memory.buffer, ptr, data.length).set(data);
  const h = S.graphsession_new(ptr, data.length);
  let total = 0;
  while (total < cap) {
    const did = S.graphsession_step_budget(h, 2000);
    total += did;
    if (S.graphsession_is_done(h) || did === 0) break;
  }
  const ret = S.graphsession_snapshot(h);
  const out = new Int32Array(wasm.memory.buffer, ret[0] >>> 0, ret[1] >>> 0).slice();
  free(ret[0] >>> 0, (ret[1] >>> 0) * 4, 4);
  const done = !!S.graphsession_is_done(h);
  S.__wbg_graphsession_free(h, 0);
  return { term: decode(out, symName, freeName).term, done };
}
function kcheck(label: string, t: Node): void {
  const expect = struct(normalize(t, 5_000_000, false, { numbers: true }).term);
  const g = graphKernelNF(t, 2_000_000);
  if (g.done && struct(g.term) === expect) kPass++;
  else {
    kFail++;
    if (fails.length < 16) fails.push(`kernel ${label}: TS=${expect.slice(0, 30)} GRAPH+K(${g.done})=${struct(g.term).slice(0, 30)}`);
  }
}
for (const op of ["(+)", "(-)", "(*)", "(==)", "(/=)", "(<)", "(<=)", "(>)", "(>=)", "compare"])
  for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) kcheck(`${op} ${a} ${b}`, app(app(named(op), nat(a)), nat(b)));
kcheck("(*) ((+) 2 3) 4", app(app(named("(*)"), app(app(named("(+)"), nat(2)), nat(3))), nat(4)));
kcheck("(+) ((*) 2 3) ((-) 9 2)", app(app(named("(+)"), app(app(named("(*)"), nat(2)), nat(3))), app(app(named("(-)"), nat(9)), nat(2))));
kcheck("(+) 2 x [lazy n]", app(app(named("(+)"), nat(2)), freeVar("x")));

// ---- list + bool kernels (encode with opts.lists / opts.booleans) vs TS native ----
const nil = (): Node => named("K");
const cons = (h: Node, t: Node): Node => app(app(named("cons"), h), t);
const list = (xs: Node[]): Node => xs.reduceRight((acc, h) => cons(h, acc), nil());
const TRUE = (): Node => app(named("K"), named("I"));
const FALSE = (): Node => named("K");
const M = (): Node => app(app(named("S"), named("I")), named("I"));
const OMEGA = (): Node => app(M(), M()); // divergent — must NOT be forced by a short-circuit
function kcheckOpts(label: string, t: Node, opts: { lists?: boolean; booleans?: boolean }): void {
  const expect = struct(normalize(t, 5_000_000, false, opts).term);
  const g = graphKernelNF(t, 2_000_000, opts);
  if (g.done && struct(g.term) === expect) kPass++;
  else {
    kFail++;
    if (fails.length < 16) fails.push(`kernel ${label}: TS=${expect.slice(0, 30)} GRAPH+K(${g.done})=${struct(g.term).slice(0, 30)}`);
  }
}
const L = { lists: true } as const;
const B = { booleans: true } as const;
kcheckOpts("[1,2] <> [3,4]", app(app(named("<>"), list([nat(1), nat(2)])), list([nat(3), nat(4)])), L);
kcheckOpts("[] <> [1,2]", app(app(named("<>"), nil()), list([nat(1), nat(2)])), L);
kcheckOpts("[1] <> ys [lazy tail]", app(app(named("<>"), list([nat(1)])), freeVar("ys")), L);
kcheckOpts("map Succ [1,2,3]", app(app(named("map"), named("Succ")), list([nat(1), nat(2), nat(3)])), L);
kcheckOpts("map f [a,b] [lazy heads]", app(app(named("map"), freeVar("f")), list([freeVar("a"), freeVar("b")])), L);
kcheckOpts("concat [[1,2],[3],[4,5]]", app(named("concat"), list([list([nat(1), nat(2)]), list([nat(3)]), list([nat(4), nat(5)])])), L);
for (const p of [TRUE, FALSE]) kcheckOpts(`not ${p === TRUE ? "T" : "F"}`, app(named("not"), p()), B);
for (const p of [TRUE, FALSE])
  for (const q of [TRUE, FALSE]) {
    kcheckOpts(`and ${p === TRUE ? "T" : "F"} ${q === TRUE ? "T" : "F"}`, app(app(named("and"), p()), q()), B);
    kcheckOpts(`or ${p === TRUE ? "T" : "F"} ${q === TRUE ? "T" : "F"}`, app(app(named("or"), p()), q()), B);
  }
kcheckOpts("and False Ω [short-circuit]", app(app(named("and"), FALSE()), OMEGA()), B);
kcheckOpts("or True Ω [short-circuit]", app(app(named("or"), TRUE()), OMEGA()), B);

// ---- FAST (rule-based) parity: the graph engine in fast mode must produce the SAME normal
// forms as the TS `redexAt` fast path, `normalize(_, _, true, opts)` — the safety net for Turbo
// honouring the rules setting (`wasm+rules(+native)` == TS `rules(+native)`). Covers every
// catalog rule, the arithmetic/list/bool grids (rules alone AND rules+native), and the recursion
// combinators that dominate the grind (foldr / filter / quicksort, authored from the catalog). ----
let fPass = 0;
let fFail = 0;
let fSkip = 0;
function fcheck(label: string, t: Node, opts: NativeOpts = {}, cap = 500_000): void {
  const ts = normalize(t, cap, true, opts);
  if (!ts.done) {
    fSkip++; // divergent within cap (e.g. a fixpoint on a free var) — both bail; not a signal
    return;
  }
  const expect = struct(ts.term);
  const g = graphKernelNF(t, cap, opts, true);
  if (g.done && struct(g.term) === expect) fPass++;
  else {
    fFail++;
    if (fails.length < 24) fails.push(`fast ${label}: TS=${expect.slice(0, 34)} | GRAPH+fast(${g.done})=${struct(g.term).slice(0, 34)}`);
  }
}
// every catalog combinator on fresh free vars, fast mode (the rule fires; a free head → WHNF)
for (const law of CATALOG) {
  if (law.args) continue; // skip the non-terminating-probe birds (Y) — diverge on free vars
  let t: Node;
  try {
    t = named(law.sym);
    for (let i = 0; i < law.arity; i++) t = app(t, vars[i]);
  } catch {
    continue;
  }
  fcheck(`comb ${law.sym}`, t);
}
// arithmetic grid: rules alone (Scott recursion via named birds) AND rules+native (kernel ?? rule)
for (const op of ["(+)", "(-)", "(*)", "(==)", "(/=)", "(<)", "(<=)", "(>)", "(>=)", "compare"])
  for (let a = 0; a <= 4; a++)
    for (let b = 0; b <= 4; b++) {
      fcheck(`${op} ${a} ${b}`, app(app(named(op), nat(a)), nat(b)));
      fcheck(`${op} ${a} ${b} +num`, app(app(named(op), nat(a)), nat(b)), { numbers: true });
    }
// nested arithmetic (deep rule recursion, exercises the kernel-miss → rule fallback too)
fcheck("(*) ((+) 2 3) 4", app(app(named("(*)"), app(app(named("(+)"), nat(2)), nat(3))), nat(4)), { numbers: true });
fcheck("(+) 2 x [lazy]", app(app(named("(+)"), nat(2)), freeVar("x")), { numbers: true });
fcheck("(+) x y [stuck]", app(app(named("(+)"), freeVar("x")), freeVar("y")), { numbers: true });
// list + bool ops: rules alone AND rules+native
for (const o of [{}, { lists: true, booleans: true }]) {
  fcheck("map Succ [1,2,3]", app(app(named("map"), named("Succ")), list([nat(1), nat(2), nat(3)])), o);
  fcheck("[1,2] <> [3,4]", app(app(named("<>"), list([nat(1), nat(2)])), list([nat(3), nat(4)])), o);
  fcheck("concat [[1,2],[3]]", app(named("concat"), list([list([nat(1), nat(2)]), list([nat(3)])])), o);
  for (const p of [TRUE, FALSE]) for (const q of [TRUE, FALSE]) fcheck("and/or", app(app(named("and"), p()), app(app(named("or"), q()), TRUE())), o);
}
// ---- recursion combinators that dominate a compiled program's grind, authored from the
// catalog (Y + named birds). The graph-fast NF must equal the TS-fast NF (both drive the same
// term through the same rules) — a strong end-to-end parity signal for the recursion structure. ----
// foldr f z xs = xs z (λh t. f h (foldr f z t))
const foldr = (): Node =>
  app(named("Y"), lamN(["r", "f", "z", "xs"], ([r, f, z, xs]) => app(app(xs, z), lamN(["h", "t"], ([h, t]) => app(app(f, h), app(app(app(r, f), z), t))))));
// filter p xs = xs [] (λh t. (p h) (filter p t) (h : filter p t))  [Scott bool: True=KI picks 2nd]
const filter = (): Node =>
  app(
    named("Y"),
    lamN(["r", "p", "xs"], ([r, p, xs]) =>
      app(app(xs, named("K")), lamN(["h", "t"], ([h, t]) => app(app(app(p, h), app(app(r, p), t)), app(app(named("cons"), h), app(app(r, p), t))))),
    ),
  );
// quicksort xs = xs [] (λh t. qsort (filter (< h) t) <> (h : qsort (filter (>= h) t)))
const qsort = (): Node =>
  app(
    named("Y"),
    lamN(["r", "xs"], ([r, xs]) =>
      app(
        app(xs, named("K")),
        lamN(["h", "t"], ([h, t]) =>
          app(
            app(named("<>"), app(r, app(app(filter(), lamN(["x"], ([x]) => app(app(named("(<)"), x), h))), t))),
            app(app(named("cons"), h), app(r, app(app(filter(), lamN(["x"], ([x]) => app(app(named("(>=)"), x), h))), t))),
          ),
        ),
      ),
    ),
  );
for (const o of [{}, { numbers: true, lists: true, booleans: true }]) {
  fcheck("foldr (+) 0 [1,2,3]", app(app(app(foldr(), named("(+)")), nat(0)), list([nat(1), nat(2), nat(3)])), o);
  fcheck("foldr (*) 1 [1,2,3,4]", app(app(app(foldr(), named("(*)")), nat(1)), list([nat(1), nat(2), nat(3), nat(4)])), o);
  fcheck("filter (< 3) [4,1,3,0,2]", app(app(filter(), lamN(["x"], ([x]) => app(app(named("(<)"), x), nat(3)))), list([nat(4), nat(1), nat(3), nat(0), nat(2)])), o);
  fcheck("quicksort [3,1,2]", app(qsort(), list([nat(3), nat(1), nat(2)])), o);
  fcheck("quicksort [4,2,5,1,3]", app(qsort(), list([nat(4), nat(2), nat(5), nat(1), nat(3)])), o);
}

// ---- end-to-end: the vendored MicroHs example closures (real compiled programs — the recursion
// combinators + basis plumbing that dominate the Turbo grind). Skipped unless the closures are
// vendored locally (public/vendor/mhs/examples/*.json is git-ignored). The graph engine in fast
// mode + native must reduce each to the SAME normal form as the TS fast path. ----
let ePass = 0;
let eFail = 0;
let eSkip = 0;
const EX_DIR = "public/vendor/mhs/examples";
if (fs.existsSync(EX_DIR)) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { combinatorsToTree } = require("../src/core/mhs") as typeof import("../src/core/mhs");
  type Closure = { root: string; defs: import("../src/core/mhs").CombDef[] };
  const ALLN: NativeOpts = { numbers: true, lists: true, booleans: true };
  for (const name of ["fac", "sum", "filter", "quicksort", "arith", "rev", "inc", "lt"]) {
    const path = `${EX_DIR}/${name}.json`;
    if (!fs.existsSync(path)) {
      eSkip++;
      continue;
    }
    const { root, defs } = JSON.parse(fs.readFileSync(path, "utf8")) as Closure;
    const r = combinatorsToTree(defs, root);
    if ("error" in r) {
      eFail++; // a *vendored* example that stops post-processing is a regression, not a skip
      if (fails.length < 24) fails.push(`example ${name}: rejected — ${r.error}`);
      continue;
    }
    const ts = normalize(r.tree, 5_000_000, true, ALLN);
    const g = graphKernelNF(r.tree, 3_000_000, ALLN, true);
    if (ts.done && g.done && struct(g.term) === struct(ts.term)) ePass++;
    else {
      eFail++;
      if (fails.length < 24) fails.push(`example ${name}: TS(${ts.done})=${struct(ts.term).slice(0, 30)} | GRAPH+fast(${g.done})=${struct(g.term).slice(0, 30)}`);
    }
  }
} else {
  eSkip = -1; // not vendored here
}

console.log(`wasm-reduce cross-check: ${pass} pass, ${fail} fail, ${skip} skipped(divergent)`);
console.log(`session invariance: ${sPass} pass, ${sFail} fail`);
console.log(`graph kernels (number+list+bool): ${kPass} pass, ${kFail} fail`);
console.log(`graph FAST rules (rules & rules+native): ${fPass} pass, ${fFail} fail, ${fSkip} skipped(divergent)`);
console.log(`MicroHs example dumps (fast+native, end-to-end): ${ePass} pass, ${eFail} fail${eSkip === -1 ? " (dumps not vendored — skipped)" : `, ${eSkip} skipped`}`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fail === 0 && sFail === 0 && kFail === 0 && fFail === 0 && eFail === 0 ? 0 : 1);
