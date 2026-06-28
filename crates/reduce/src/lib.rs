//! Flat-arena raw combinator reducer — a wasm fast-path that mirrors `reduce.ts` in its
//! NON-fast (default "plain pure-ι") mode EXACTLY: the only rules are ι/I/K/S plus
//! definition-unfold for saturated named combinators. NO catalog rules, NO native kernels
//! — those stay the TS reducer's job (the semantic oracle). The def trees are supplied by
//! TS (`catalog.ts`'s `def()`), so there is zero rule duplication here.
//!
//! Used for skip-to-NF (and value-read of) big raw constructions, where the TS persistent
//! tree reducer is allocation/GC-bound; the arena bump-allocates with no GC. The NF is
//! re-encoded and handed back to TS, which owns display / value-reading / sym names.
//!
//! Wire format (flat `i32` array), input:
//!   [0] root node index
//!   [1] symId of S   [2] symId of K   [3] symId of I   (-1 if absent)
//!   [4] node count N   [5] sym count M   [6] def-prefix length (nodes[0..defLen) are the
//!       immutable def trees, emitted before the term — a resident session never compacts them)
//!   then N nodes × 3:  [tag, a, b]   tag 0=IOTA 1=COMB(a=symId) 2=FREE(a=freeId) 3=APP(a=fn,b=arg)
//!   then M syms × 2:   [arity, defRoot]   defRoot = -1 when the comb has no def (a primitive)
//! Output:
//!   [0] done(0/1)   [1] steps   [2] root index   [3] node count N'
//!   then N' nodes × 3 (same node layout; same symIds / freeIds — TS maps them back)

use wasm_bindgen::prelude::*;

const TAG_IOTA: i32 = 0;
const TAG_COMB: i32 = 1;
const TAG_FREE: i32 = 2;
const TAG_APP: i32 = 3;

#[derive(Clone, Copy)]
struct Node {
    tag: i32,
    a: i32,
    b: i32,
}

struct Sym {
    arity: i32,
    def_root: i32,
}

// Persistent reduction bump-allocates and never frees, so a divergent / explosively growing
// term would exhaust wasm memory. Bail / compact past this. ~16M nodes × 12 B ≈ 200 MB.
const MAX_NODES: usize = 16_000_000;

struct Reducer {
    nodes: Vec<Node>,
    syms: Vec<Sym>,
    sym_s: i32,
    sym_k: i32,
    sym_i: i32,
    /// Length of the immutable def-tree prefix `nodes[0..def_len)` — `compact` preserves it
    /// so every `Sym::def_root` stays valid for the life of the reduction.
    def_len: usize,
}

impl Reducer {
    /// Parse the flat wire format (see the module header) into a reducer + the term root.
    fn from_wire(data: &[i32], extra_capacity: usize) -> (Reducer, i32) {
        let root = data[0];
        let sym_s = data[1];
        let sym_k = data[2];
        let sym_i = data[3];
        let n = data[4] as usize;
        let m = data[5] as usize;
        let def_len = data[6] as usize;
        let mut nodes = Vec::with_capacity(n + extra_capacity);
        let base = 7;
        for j in 0..n {
            let o = base + j * 3;
            nodes.push(Node { tag: data[o], a: data[o + 1], b: data[o + 2] });
        }
        let mut syms = Vec::with_capacity(m);
        let sbase = base + n * 3;
        for j in 0..m {
            let o = sbase + j * 2;
            syms.push(Sym { arity: data[o], def_root: data[o + 1] });
        }
        (Reducer { nodes, syms, sym_s, sym_k, sym_i, def_len }, root)
    }

    /// Reclaim garbage: rebuild the working region `nodes[def_len..)` from the live term,
    /// keeping the immutable def prefix in place (so `def_root` indices stay valid). Working
    /// nodes never reference into the prefix (def-unfold clones the whole def subtree into the
    /// working region; comb nodes reference defs by *symId*, not index), so this is safe.
    fn compact(&mut self, root: i32) -> i32 {
        let dl = self.def_len as i32;
        let mut out: Vec<Node> = Vec::new();
        let mut memo = vec![-1i32; self.nodes.len() - self.def_len];
        let new_root = self.compact_copy(root, &mut out, &mut memo, dl);
        self.nodes.truncate(self.def_len);
        self.nodes.extend(out);
        new_root
    }

    fn compact_copy(&self, i: i32, out: &mut Vec<Node>, memo: &mut [i32], def_len: i32) -> i32 {
        if i < def_len {
            return i; // def node — stays in the immutable prefix, index unchanged
        }
        let k = (i - def_len) as usize;
        if memo[k] >= 0 {
            return memo[k]; // shared (S-duplicated) working node → one output node
        }
        let n = self.get(i);
        let idx = if n.tag == TAG_APP {
            let f = self.compact_copy(n.a, out, memo, def_len);
            let x = self.compact_copy(n.b, out, memo, def_len);
            let id = def_len + out.len() as i32;
            out.push(Node { tag: TAG_APP, a: f, b: x });
            id
        } else {
            let id = def_len + out.len() as i32;
            out.push(n);
            id
        };
        memo[k] = idx;
        idx
    }

    #[inline]
    fn push(&mut self, tag: i32, a: i32, b: i32) -> i32 {
        let i = self.nodes.len() as i32;
        self.nodes.push(Node { tag, a, b });
        i
    }
    #[inline]
    fn app(&mut self, f: i32, x: i32) -> i32 {
        self.push(TAG_APP, f, x)
    }
    #[inline]
    fn get(&self, i: i32) -> Node {
        self.nodes[i as usize]
    }

    /// Deep-copy a subtree (fresh indices), like reduce.ts `clone`.
    fn clone_tree(&mut self, root: i32) -> i32 {
        let n = self.get(root);
        match n.tag {
            TAG_APP => {
                let f = self.clone_tree(n.a);
                let x = self.clone_tree(n.b);
                self.app(f, x)
            }
            _ => self.push(n.tag, n.a, n.b),
        }
    }

    /// One leftmost-outermost contraction (persistent — rebuilds the path), or None at NF.
    /// `args_above` counts applied args above this node, gating def-unfold saturation —
    /// mirrors `redexAt(n, argsAbove, fast=false, native=undefined)`.
    fn step(&mut self, n: i32, args_above: i32) -> Option<i32> {
        let node = self.get(n);
        if node.tag != TAG_APP {
            return None;
        }
        let fnn = node.a;
        let arg = node.b;
        let f = self.get(fnn);

        // ι x → x S K
        if f.tag == TAG_IOTA {
            let s = self.push(TAG_COMB, self.sym_s, 0);
            let k = self.push(TAG_COMB, self.sym_k, 0);
            let xs = self.app(arg, s);
            return Some(self.app(xs, k));
        }
        // I x → x
        if f.tag == TAG_COMB && f.a == self.sym_i {
            return Some(arg);
        }
        if f.tag == TAG_APP {
            let ff = self.get(f.a);
            // K x y → x   (fn = (K x); f.b = x)
            if ff.tag == TAG_COMB && ff.a == self.sym_k {
                return Some(f.b);
            }
            // S x y z → x z (y z)   (fn = ((S x) y); ff = (S x))
            if ff.tag == TAG_APP {
                let fff = self.get(ff.a);
                if fff.tag == TAG_COMB && fff.a == self.sym_s {
                    let x = ff.b;
                    let y = f.b;
                    let z = arg;
                    let zc = self.clone_tree(z); // right copy fresh (matches reduce.ts)
                    let xz = self.app(x, z);
                    let yz = self.app(y, zc);
                    return Some(self.app(xz, yz));
                }
            }
        }
        // A named combinator with a def in head position, saturated → unfold (def applied
        // to arg). arity defaults to 1 when unknown (reduce.ts: `fn.arity ?? 1`).
        if f.tag == TAG_COMB {
            let sym = &self.syms[f.a as usize];
            let arity = if sym.arity == 0 { 1 } else { sym.arity };
            let def_root = sym.def_root;
            if def_root >= 0 && args_above + 1 >= arity {
                let d = self.clone_tree(def_root);
                return Some(self.app(d, arg));
            }
        }

        // No root redex: recurse the function spine (one more arg above), then the arg.
        if let Some(nf) = self.step(fnn, args_above + 1) {
            return Some(self.app(nf, arg));
        }
        if let Some(na) = self.step(arg, 0) {
            return Some(self.app(fnn, na));
        }
        None
    }

    /// Re-encode the NF reachable from `root` into a compact output array, preserving
    /// symIds / freeIds. Uses an explicit stack (terms can be deep).
    fn encode(&self, root: i32, steps: i32, done: bool) -> Vec<i32> {
        // Map old index → new index via a recursive copy into a fresh node list.
        let mut out: Vec<Node> = Vec::new();
        let mut memo: Vec<i32> = vec![-1; self.nodes.len()];
        let new_root = self.copy_into(root, &mut out, &mut memo);
        let mut res = Vec::with_capacity(4 + out.len() * 3);
        res.push(if done { 1 } else { 0 });
        res.push(steps);
        res.push(new_root);
        res.push(out.len() as i32);
        for nd in &out {
            res.push(nd.tag);
            res.push(nd.a);
            res.push(nd.b);
        }
        res
    }

    fn copy_into(&self, i: i32, out: &mut Vec<Node>, memo: &mut [i32]) -> i32 {
        // shared subtrees (from S-duplication via index) collapse to one output node
        if memo[i as usize] >= 0 {
            return memo[i as usize];
        }
        let n = self.get(i);
        if n.tag == TAG_APP {
            let f = self.copy_into(n.a, out, memo);
            let x = self.copy_into(n.b, out, memo);
            let idx = out.len() as i32;
            out.push(Node { tag: TAG_APP, a: f, b: x });
            memo[i as usize] = idx;
            idx
        } else {
            let idx = out.len() as i32;
            out.push(n);
            memo[i as usize] = idx;
            idx
        }
    }
}

/// Reduce a flat-encoded term to normal form (or until `cap` contractions). Returns the
/// re-encoded NF (see the wire format above). One-shot; the cross-check oracle.
#[wasm_bindgen]
pub fn reduce_to_nf(data: &[i32], cap: u32) -> Vec<i32> {
    let (mut r, root) = Reducer::from_wire(data, (cap as usize).min(1 << 22));
    let mut cur = root;
    let mut steps: u32 = 0;
    let done = loop {
        if r.nodes.len() >= MAX_NODES {
            break false; // the caller (TS) falls back to its GC'd reducer
        }
        match r.step(cur, 0) {
            Some(next) => {
                cur = next;
                steps += 1;
                if steps >= cap {
                    break false;
                }
            }
            None => break true,
        }
    };
    r.encode(cur, steps as i32, done)
}

/// A resident reduction: the term + def trees live in wasm linear memory, so a turbo loop
/// can run thousands of contractions without marshalling, and only snapshot the current term
/// out (for display) once per frame. The frame-budget / total cap is the JS caller's job —
/// it calls `step_budget` repeatedly and reads the clock; this only enforces the memory cap.
#[wasm_bindgen]
pub struct Session {
    r: Reducer,
    root: i32,
    steps: u32,
    done: bool,
}

// Compact internally once the working arena grows past this between snapshots, so a single
// large `step_budget` batch on a big intermediate can't hit MAX_NODES and stall.
const COMPACT_AT: usize = 2_000_000;

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[i32]) -> Session {
        let (r, root) = Reducer::from_wire(data, 1 << 16);
        Session { r, root, steps: 0, done: false }
    }

    /// Run up to `max_steps` more contractions (or to NF). Returns the steps done this call
    /// (0 once at normal form). Compacts internally if the arena gets large.
    pub fn step_budget(&mut self, max_steps: u32) -> u32 {
        if self.done {
            return 0;
        }
        let mut did = 0u32;
        while did < max_steps {
            if self.r.nodes.len() >= COMPACT_AT {
                self.root = self.r.compact(self.root);
                if self.r.nodes.len() >= MAX_NODES {
                    break; // pathological: even compacted it's over the ceiling
                }
            }
            match self.r.step(self.root, 0) {
                Some(next) => {
                    self.root = next;
                    self.steps += 1;
                    did += 1;
                }
                None => {
                    self.done = true;
                    break;
                }
            }
        }
        did
    }

    pub fn is_done(&self) -> bool {
        self.done
    }
    pub fn total_steps(&self) -> u32 {
        self.steps
    }
    pub fn node_count(&self) -> u32 {
        self.r.nodes.len() as u32
    }

    /// Compact the arena (reclaim garbage, preserve the def prefix) and return the encoded
    /// current term for display.
    pub fn snapshot(&mut self) -> Vec<i32> {
        self.root = self.r.compact(self.root);
        self.r.encode(self.root, self.steps as i32, self.done)
    }
}
