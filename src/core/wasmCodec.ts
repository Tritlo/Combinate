/**
 * Pure codec between the `Node` term model and the flat `Int32Array` wire format the
 * wasm reducer (`crates/reduce`) speaks. No wasm/DOM here — just data (ADR 0001): the
 * driven adapter that loads + calls the module lives in the view.
 *
 * The encoder closes over every named combinator reachable from the term (and, recursively,
 * from each combinator's `def`), so wasm can unfold them with no catalog knowledge of its
 * own — the rules come entirely from `catalog.ts`'s `def()`. S/K/I (and the ι rule's fresh
 * S/K) are primitives wasm handles directly; their symIds are passed in the header.
 */
import { type Node, type Sym, comb, freeVar, app } from "./term";
import { CATALOG, named } from "./catalog";
import { type NativeOpts } from "./native";

const TAG_IOTA = 0;
const TAG_COMB = 1;
const TAG_FREE = 2;
const TAG_APP = 3;

const LAW = new Map(CATALOG.map((l) => [l.sym, l] as const));
const isCatalog = (sym: Sym): boolean => LAW.has(sym);

// Number-kernel kinds (1-based; mirrors native.ts's NUM_OPS order). 0 = not a kernel op.
// The wasm GraphSession dispatches the arithmetic + canonical Scott emit from this tag, so
// the kernel *logic* is ported once in Rust and cross-checked against native.ts.
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
};

/** The flat encoding plus the maps needed to decode the wasm result back to `Node`. */
export interface Encoded {
  data: Int32Array;
  symName: string[]; // symId → combinator symbol
  freeName: string[]; // freeId → free-var name
}

/** Encode a term into the wasm wire format (see `crates/reduce/src/lib.rs`). `opts` enables
 *  the wasm number kernels (clean Scott arithmetic) when the native-numbers toggle is on. */
export function encode(term: Node, opts?: NativeOpts): Encoded {
  // ---- close over every combinator reachable from the term and (transitively) from
  // each combinator's def, resolving each sym's def tree once. ----
  const collectCombs = (n: Node, into: Set<Sym>): void => {
    if (n.kind === "comb") into.add(n.sym);
    else if (n.kind === "app") {
      collectCombs(n.fn, into);
      collectCombs(n.arg, into);
    }
  };
  const defTree = new Map<Sym, Node | null>();
  const queue: Sym[] = ["S", "K", "I"]; // primitives + the ι rule's fresh S/K
  // The number kernels emit canonical Scott values built from these constructors, so they
  // must be in the closure (get symIds) even if the term doesn't mention them.
  if (opts?.numbers) queue.push("Succ", "LT", "EQ", "GT");
  const seed = new Set<Sym>();
  collectCombs(term, seed);
  for (const s of seed) queue.push(s);
  while (queue.length) {
    const sym = queue.shift()!;
    if (defTree.has(sym)) continue;
    const def = LAW.get(sym)?.def?.() ?? null; // S/K/I (+ unknown) → no def (primitive)
    defTree.set(sym, def);
    if (def) {
      const more = new Set<Sym>();
      collectCombs(def, more);
      for (const s of more) if (!defTree.has(s)) queue.push(s);
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
  // emit def trees FIRST (in symId order, so the sym table can reference their roots) —
  // they form an immutable prefix [0, defLen) that a resident session never compacts, so
  // def_root indices stay valid for the life of the reduction. The term follows.
  for (let id = 0; id < symName.length; id++) {
    const def = defTree.get(symName[id]) ?? null;
    if (def) defRoot[id] = emit(def);
  }
  const defLen = nodes.length / 3; // boundary: nodes [0, defLen) are the def prefix
  const root = emit(term);

  // ---- assemble: header + nodes + sym table ----
  // header: [root,symS,symK,symI,nodeCount,symCount,defLen, symSucc,symLT,symEQ,symGT, nativeFlags]
  const HEADER = 12;
  const nodeCount = nodes.length / 3;
  const symCount = symName.length;
  const out = new Int32Array(HEADER + nodes.length + symCount * 3);
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
  out[11] = opts?.numbers ? 1 : 0; // bit0: number kernels (lists/bools = future bits)
  out.set(nodes, HEADER);
  const sbase = HEADER + nodes.length;
  for (let id = 0; id < symCount; id++) {
    const law = LAW.get(symName[id]);
    out[sbase + id * 3] = law?.arity ?? 1;
    out[sbase + id * 3 + 1] = defRoot[id];
    out[sbase + id * 3 + 2] = KERNEL_KIND[symName[id]] ?? 0; // number-kernel kind, or 0
  }
  return { data: out, symName, freeName };
}

/** The decoded normal form plus the reducer's bookkeeping. */
export interface Decoded {
  term: Node;
  steps: number;
  done: boolean;
}

/** Decode the wasm result array back into a `Node` term. */
export function decode(result: Int32Array, symName: string[], freeName: string[]): Decoded {
  const done = result[0] === 1;
  const steps = result[1];
  const root = result[2];
  const n = result[3];
  const base = 4;
  const memo = new Array<Node | undefined>(n);
  const build = (i: number): Node => {
    const cached = memo[i];
    if (cached) return cached;
    const o = base + i * 3;
    const tag = result[o];
    let node: Node;
    if (tag === TAG_APP) node = app(build(result[o + 1]), build(result[o + 2]));
    else if (tag === TAG_IOTA) node = { id: 0, kind: "iota" } as Node;
    else if (tag === TAG_COMB) {
      const sym = symName[result[o + 1]];
      node = isCatalog(sym) ? named(sym) : comb(sym);
    } else node = freeVar(freeName[result[o + 1]]);
    memo[i] = node;
    return node;
  };
  return { term: build(root), steps, done };
}
