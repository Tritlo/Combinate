/**
 * Pure codec between the `Node` term model and the flat `Int32Array` wire format the
 * wasm reducer (`crates/reduce`) speaks. No wasm/DOM here — just data (ADR 0001): the
 * driven adapter that loads + calls the module lives in the view.
 *
 * The encoder closes over every named combinator reachable from the term (and, recursively,
 * from each combinator's `def`), so wasm can unfold them with no catalog knowledge of its
 * own — the rules come entirely from `catalog.ts`'s `def()`. S/K/I (and the ι rule's fresh
 * S/K) are primitives wasm handles directly; their symIds are passed in the header.
 *
 * FAST (rules) mode (ADR: Turbo honours the rules setting): when `fast` is set, each catalog
 * combinator that carries a `rule` also ships a **rule template** — its `rule` applied to
 * placeholder args `$warg0…` — as an immutable-prefix subtree (`ruleRoot`). The wasm graph
 * engine then reduces a saturated combinator by instantiating that template (cloning it with
 * each placeholder replaced by the shared actual arg) in ONE step, mirroring `reduce.ts`'s
 * `redexAt` fast path, instead of def-unfolding the Y/SKI recursion and grinding.
 */
import { type Node, type Sym, comb, freeVar, app } from "./term";
import { CATALOG, named } from "./catalog";
import { type NativeOpts } from "./native";

const TAG_IOTA = 0;
const TAG_COMB = 1;
const TAG_FREE = 2;
const TAG_APP = 3;
// tag 4 (IND) is wasm-internal only. Rule-template placeholder: substitute the i-th actual
// argument during instantiation (a = the arg index). Only appears inside a `ruleRoot` subtree.
const TAG_ARG = 5;

const LAW = new Map(CATALOG.map((l) => [l.sym, l] as const));
const isCatalog = (sym: Sym): boolean => LAW.has(sym);

// Rule-template placeholder free-var names ($warg0, $warg1, …). The rule closures never mint
// free vars of their own (their inner λ-binders are bracket-abstracted away), so the only
// $warg-named leaves in a template are the args we substitute — detected + re-tagged on emit.
const ARG_PREFIX = "$warg";
const argVar = (i: number): Node => freeVar(`${ARG_PREFIX}${i}`);
const ARG_RE = /^\$warg(\d+)$/;

// Kernel kinds (1-based) the wasm GraphSession dispatches — number ops 1-10 (native.ts
// NUM_OPS order), list ops 11-13, bool ops 14-16. The kernel *logic* is ported once in Rust
// and cross-checked against native.ts; this just tags which sym is which op.
const KERNEL_KIND: Record<string, number> = {
  "(+)": 1,
  "(-)": 2,
  "(*)": 3,
  "(==)": 4,
  "(/=)": 5,
  "(<)": 6,
  "(<=)": 7,
  "(>)": 8,
  "(>=)": 9,
  compare: 10,
  "<>": 11,
  map: 12,
  concat: 13,
  not: 14,
  and: 15,
  or: 16,
};
// Native-kernel gate bits (mirror the optimize toggles) packed into the wire header.
const NATIVE_NUMBERS = 1;
const NATIVE_LISTS = 2;
const NATIVE_BOOLS = 4;
const FAST_RULES = 8; // fast (rule-based) reduction — instantiate ruleRoot templates, not def-unfold

/** The flat encoding plus the maps needed to decode the wasm result back to `Node`. */
export interface Encoded {
  data: Int32Array;
  symName: string[]; // symId → combinator symbol
  freeName: string[]; // freeId → free-var name
}

/** Encode a term into the wasm wire format (see `crates/reduce/src/lib.rs`). `opts` enables
 *  the wasm number kernels (clean Scott arithmetic) when the native-numbers toggle is on;
 *  `fast` ships the catalog rule templates so the graph engine reduces named combinators by
 *  their law in one step (rule-based reduction) instead of def-unfolding. */
export function encode(term: Node, opts?: NativeOpts, fast = false): Encoded {
  // ---- close over every combinator reachable from the term and (transitively) from each
  // combinator's def AND (in fast mode) its rule template, resolving each sym's trees once. ----
  // A non-catalog combinator (a MicroHs-compiled program's basis combinators — C'/K2/K3/K4/C'B)
  // isn't in the catalog, but carries its own SKI `def` + `arity` on the node (mhs.ts `basisNode`).
  // Capture those so wasm can def-unfold them too, exactly as the TS reducer does via `fn.def` —
  // otherwise they'd be inert primitives and no compiled program could reduce.
  const nodeInfo = new Map<Sym, { def: Node | null; arity: number }>();
  const collectCombs = (n: Node, into: Set<Sym>): void => {
    if (n.kind === "comb") {
      into.add(n.sym);
      if (!LAW.has(n.sym) && !nodeInfo.has(n.sym)) nodeInfo.set(n.sym, { def: n.def ?? null, arity: n.arity ?? 1 });
    } else if (n.kind === "app") {
      collectCombs(n.fn, into);
      collectCombs(n.arg, into);
    }
  };
  // A sym's rule template: its `rule` applied to placeholder args (`$warg0…`), or null if it
  // has no rule (I/K/S/ι — built-in — or an undiscovered comb). Only used in fast mode.
  const ruleTemplate = (sym: Sym): Node | null => {
    const law = LAW.get(sym);
    if (!law?.rule) return null;
    return law.rule(Array.from({ length: law.arity }, (_, i) => argVar(i)));
  };
  const defTree = new Map<Sym, Node | null>();
  const ruleTree = new Map<Sym, Node | null>();
  const queue: Sym[] = ["S", "K", "I"]; // primitives + the ι rule's fresh S/K
  // The kernels emit canonical Scott values built from these constructors, so they must be in
  // the closure (get symIds) even if the term doesn't mention them. (I = True's K I; cons for
  // list results; nil/False are K, already interned.)
  if (opts?.numbers) queue.push("Succ", "LT", "EQ", "GT");
  if (opts?.lists) queue.push("cons");
  // bool results are K / K I — K and I are already interned as primitives.
  const seed = new Set<Sym>();
  collectCombs(term, seed);
  for (const s of seed) queue.push(s);
  while (queue.length) {
    const sym = queue.shift()!;
    if (defTree.has(sym)) continue;
    const def = LAW.get(sym)?.def?.() ?? nodeInfo.get(sym)?.def ?? null; // catalog def, else a basis comb's inline SKI def, else primitive
    defTree.set(sym, def); // mark visited before collecting, so a self-referential rule is fine
    if (def) {
      const more = new Set<Sym>();
      collectCombs(def, more);
      for (const s of more) if (!defTree.has(s)) queue.push(s);
    }
    // In fast mode a rule template pulls its own combinators into the closure (e.g. `plusRule`
    // references Succ + (+)), recursively — so every sym the graph engine can instantiate to is
    // interned and emitted with a def-unfold fallback of its own.
    if (fast) {
      const rt = ruleTemplate(sym);
      ruleTree.set(sym, rt);
      if (rt) {
        const more = new Set<Sym>();
        collectCombs(rt, more);
        for (const s of more) if (!defTree.has(s)) queue.push(s);
      }
    }
  }

  // ---- assign symIds (S/K/I first) over the resolved closure ----
  const symId = new Map<Sym, number>();
  const symName: string[] = [];
  const intern = (sym: Sym): number => {
    let id = symId.get(sym);
    if (id === undefined) {
      id = symName.length;
      symId.set(sym, id);
      symName.push(sym);
    }
    return id;
  };
  for (const s of ["S", "K", "I"]) intern(s);
  for (const sym of defTree.keys()) intern(sym);

  // ---- emit nodes: each sym's def tree first (recording defRoot), then the term ----
  const nodes: number[] = []; // flat triples
  const freeId = new Map<string, number>();
  const freeName: string[] = [];
  const emit = (n: Node): number => {
    switch (n.kind) {
      case "iota": {
        const i = nodes.length / 3;
        nodes.push(TAG_IOTA, 0, 0);
        return i;
      }
      case "comb": {
        const i = nodes.length / 3;
        nodes.push(TAG_COMB, intern(n.sym), 0);
        return i;
      }
      case "free": {
        const arg = ARG_RE.exec(n.name); // a rule-template placeholder → substitute the arg on the wasm side
        if (arg) {
          const i = nodes.length / 3;
          nodes.push(TAG_ARG, Number(arg[1]), 0);
          return i;
        }
        let fid = freeId.get(n.name);
        if (fid === undefined) {
          fid = freeName.length;
          freeId.set(n.name, fid);
          freeName.push(n.name);
        }
        const i = nodes.length / 3;
        nodes.push(TAG_FREE, fid, 0);
        return i;
      }
      case "app": {
        const f = emit(n.fn);
        const a = emit(n.arg);
        const i = nodes.length / 3;
        nodes.push(TAG_APP, f, a);
        return i;
      }
    }
  };

  const defRoot = new Array<number>(symName.length).fill(-1);
  const ruleRoot = new Array<number>(symName.length).fill(-1);
  // emit def trees FIRST (in symId order, so the sym table can reference their roots), then the
  // rule templates (fast mode) — together they form an immutable prefix [0, defLen) that a
  // resident session never compacts, so def_root / rule_root indices stay valid for the life of
  // the reduction. The term follows.
  for (let id = 0; id < symName.length; id++) {
    const def = defTree.get(symName[id]) ?? null;
    if (def) defRoot[id] = emit(def);
  }
  if (fast) {
    for (let id = 0; id < symName.length; id++) {
      const rt = ruleTree.get(symName[id]) ?? null;
      if (rt) ruleRoot[id] = emit(rt);
    }
  }
  const defLen = nodes.length / 3; // boundary: nodes [0, defLen) are the def + rule-template prefix
  const root = emit(term);

  // ---- assemble: header + nodes + sym table ----
  // header: [root,symS,symK,symI,nodeCount,symCount,defLen, symSucc,symLT,symEQ,symGT, flags, symCons]
  const HEADER = 13;
  const nodeCount = nodes.length / 3;
  const symCount = symName.length;
  const out = new Int32Array(HEADER + nodes.length + symCount * 4);
  out[0] = root;
  out[1] = symId.get("S")!;
  out[2] = symId.get("K")!;
  out[3] = symId.get("I")!;
  out[4] = nodeCount;
  out[5] = symCount;
  out[6] = defLen;
  out[7] = symId.get("Succ") ?? -1;
  out[8] = symId.get("LT") ?? -1;
  out[9] = symId.get("EQ") ?? -1;
  out[10] = symId.get("GT") ?? -1;
  out[11] =
    (opts?.numbers ? NATIVE_NUMBERS : 0) | (opts?.lists ? NATIVE_LISTS : 0) | (opts?.booleans ? NATIVE_BOOLS : 0) | (fast ? FAST_RULES : 0);
  out[12] = symId.get("cons") ?? -1;
  out.set(nodes, HEADER);
  const sbase = HEADER + nodes.length;
  for (let id = 0; id < symCount; id++) {
    const law = LAW.get(symName[id]);
    out[sbase + id * 4] = law?.arity ?? nodeInfo.get(symName[id])?.arity ?? 1; // catalog arity, else the basis comb's arity
    out[sbase + id * 4 + 1] = defRoot[id];
    out[sbase + id * 4 + 2] = KERNEL_KIND[symName[id]] ?? 0; // number-kernel kind, or 0
    out[sbase + id * 4 + 3] = ruleRoot[id]; // fast-mode rule template root, or -1
  }
  return { data: out, symName, freeName };
}

/** The decoded normal form plus the reducer's bookkeeping. */
export interface Decoded {
  term: Node;
  steps: number;
  done: boolean;
}

/** Decode the wasm result array back into a `Node` term. ITERATIVE (an explicit stack +
 *  post-order build) — a recursive decode overflows the JS call stack on a deep result (a big
 *  Scott numeral is thousands of nodes deep). Sharing in the wasm DAG is preserved via the memo
 *  (a shared index → one `Node`). */
export function decode(result: Int32Array, symName: string[], freeName: string[]): Decoded {
  const done = result[0] === 1;
  const steps = result[1];
  const root = result[2];
  const n = result[3];
  const base = 4;
  const memo = new Array<Node | undefined>(n);
  const leaf = (i: number): Node => {
    const o = base + i * 3;
    const tag = result[o];
    if (tag === TAG_IOTA) return { id: 0, kind: "iota" } as Node;
    if (tag === TAG_COMB) {
      const sym = symName[result[o + 1]];
      return isCatalog(sym) ? named(sym) : comb(sym);
    }
    return freeVar(freeName[result[o + 1]]);
  };
  // stack of (index, childrenReady): first visit pushes children, second builds the app.
  const stack: Array<[number, boolean]> = [[root, false]];
  while (stack.length) {
    const [i, ready] = stack.pop()!;
    if (memo[i]) continue;
    const o = base + i * 3;
    if (result[o] !== TAG_APP) {
      memo[i] = leaf(i);
    } else if (!ready) {
      stack.push([i, true], [result[o + 1], false], [result[o + 2], false]);
    } else {
      memo[i] = app(memo[result[o + 1]]!, memo[result[o + 2]]!);
    }
  }
  return { term: memo[root]!, steps, done };
}
