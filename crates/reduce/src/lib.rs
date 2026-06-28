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
    kernel: i32, // number-kernel kind (1=(+) … 10=compare), or 0 if not a kernel op
}

// Constructor symIds + the native-kernel gate, parsed from the wire header. Lets the graph
// reducer fire native.ts's number kernels (clean Scott arithmetic) directly in wasm.
#[derive(Clone, Copy)]
struct Kernels {
    succ: i32,
    lt: i32,
    eq: i32,
    gt: i32,
    numbers: bool,
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
    kern: Kernels,
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
        let kern = Kernels { succ: data[7], lt: data[8], eq: data[9], gt: data[10], numbers: data[11] != 0 };
        let mut nodes = Vec::with_capacity(n + extra_capacity);
        let base = 12;
        for j in 0..n {
            let o = base + j * 3;
            nodes.push(Node { tag: data[o], a: data[o + 1], b: data[o + 2] });
        }
        let mut syms = Vec::with_capacity(m);
        let sbase = base + n * 3;
        for j in 0..m {
            let o = sbase + j * 3;
            syms.push(Sym { arity: data[o], def_root: data[o + 1], kernel: data[o + 2] });
        }
        (Reducer { nodes, syms, sym_s, sym_k, sym_i, kern, def_len }, root)
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

// ============================================================================================
// Graph reduction (ADR 16 follow-up) — call-by-need with SHARING, a faithful port of the TS
// `graph.ts` model: cells `iota | comb | free | app | ind`, `force` chases indirections, a
// contracted redex overwrites itself with `ind → result` so every sharer sees it, and the
// S-rule SHARES its duplicated arg by index (no clone). The def prefix [0,def_len) stays
// immutable (def-unfold clones a fresh copy into the working region). This kills both the
// persistent reducer's O(size)/step path-rebuild AND the materialisation blow-up.
// ============================================================================================

const TAG_IND: i32 = 4; // indirection: a forced cell becomes IND→result (chased by `force`)

struct Graph {
    nodes: Vec<Node>,
    syms: Vec<Sym>,
    sym_s: i32,
    sym_k: i32,
    sym_i: i32,
    kern: Kernels,
    def_len: usize,
}

impl Graph {
    fn from_wire(data: &[i32]) -> (Graph, i32) {
        let (r, root) = Reducer::from_wire(data, 1 << 16);
        (Graph { nodes: r.nodes, syms: r.syms, sym_s: r.sym_s, sym_k: r.sym_k, sym_i: r.sym_i, kern: r.kern, def_len: r.def_len }, root)
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
    /// Chase indirections to the representative cell.
    #[inline]
    fn force(&self, mut i: i32) -> i32 {
        while self.nodes[i as usize].tag == TAG_IND {
            i = self.nodes[i as usize].a;
        }
        i
    }
    #[inline]
    fn set_ind(&mut self, cell: i32, to: i32) {
        self.nodes[cell as usize] = Node { tag: TAG_IND, a: to, b: 0 };
    }
    #[inline]
    fn arg_of(&self, app_cell: i32) -> i32 {
        self.nodes[app_cell as usize].b
    }

    /// A FRESH graph copy of a def subtree (from the immutable prefix), like graph.ts `toGraph`.
    fn clone_def(&mut self, root: i32) -> i32 {
        let n = self.nodes[root as usize];
        if n.tag == TAG_APP {
            let f = self.clone_def(n.a);
            let x = self.clone_def(n.b);
            self.app(f, x)
        } else {
            self.push(n.tag, n.a, n.b)
        }
    }

    // ---- number kernels (port of native.ts's numberOp, with its exact forcing) ----

    /// Reduce a cell to normal form in place (bounded) — forces a kernel operand to a value.
    fn force_nf(&mut self, idx: i32, budget: &mut u32) -> bool {
        loop {
            if *budget == 0 {
                return false;
            }
            if !self.step(idx) {
                return true;
            }
            *budget -= 1;
        }
    }

    /// Read a (forced) cell as a Scott numeral `Succ^k K`; None if it isn't one.
    fn match_numeral(&self, idx: i32) -> Option<i64> {
        let mut cur = self.force(idx);
        let mut k: i64 = 0;
        loop {
            let n = self.nodes[cur as usize];
            if n.tag == TAG_COMB && n.a == self.sym_k {
                return Some(k); // Z = K — end of the count
            }
            if n.tag == TAG_APP {
                let h = self.force(n.a);
                if self.nodes[h as usize].tag == TAG_COMB && self.nodes[h as usize].a == self.kern.succ {
                    k += 1;
                    if k > 9_999 {
                        return None; // cap = native.ts MAX_NUM (matchNumeral); only (*) caps the product at MAX_NAT
                    }
                    cur = self.force(n.b);
                    continue;
                }
            }
            return None;
        }
    }

    fn k_cell(&mut self) -> i32 {
        self.push(TAG_COMB, self.sym_k, 0)
    }
    /// `Succ^k` applied to `tail` (shared) — `(+)` keeps its right operand a thunk.
    fn nat_chain(&mut self, k: i64, tail: i32) -> i32 {
        let mut r = tail;
        for _ in 0..k {
            let s = self.push(TAG_COMB, self.kern.succ, 0);
            r = self.app(s, r);
        }
        r
    }
    fn bool_cell(&mut self, b: bool) -> i32 {
        if b {
            let k = self.push(TAG_COMB, self.sym_k, 0); // True = K I
            let i = self.push(TAG_COMB, self.sym_i, 0);
            self.app(k, i)
        } else {
            self.push(TAG_COMB, self.sym_k, 0) // False = K
        }
    }
    fn ord_cell(&mut self, c: i32) -> i32 {
        let sym = if c < 0 {
            self.kern.lt
        } else if c > 0 {
            self.kern.gt
        } else {
            self.kern.eq
        };
        self.push(TAG_COMB, sym, 0)
    }

    /// Fire a number kernel on operands `a` (left), `b` (right). Forces only what native.ts
    /// forces; None → not a value yet (caller falls back to def-unfold / keeps reducing).
    fn fire_number_kernel(&mut self, kind: i32, a: i32, b: i32) -> Option<i32> {
        let mut bud: u32 = 500_000; // force budget — bounds the worst per-frame kernel force
        match kind {
            1 => {
                // (+) a n = Succ^a n — force only a; n stays a shared thunk
                if !self.force_nf(a, &mut bud) {
                    return None;
                }
                let av = self.match_numeral(a)?;
                Some(self.nat_chain(av, b))
            }
            3 => {
                // (*) a n: a=0 → Z (n unforced); else a·n
                if !self.force_nf(a, &mut bud) {
                    return None;
                }
                let av = self.match_numeral(a)?;
                if av == 0 {
                    return Some(self.k_cell());
                }
                if !self.force_nf(b, &mut bud) {
                    return None;
                }
                let bv = self.match_numeral(b)?;
                if av * bv > 4_096 {
                    return None; // cap → fall back to raw graph reduction
                }
                let k = self.k_cell();
                Some(self.nat_chain(av * bv, k))
            }
            2 => {
                // (-) m n: n=0 → m (unforced); else max(0, m−n)
                if !self.force_nf(b, &mut bud) {
                    return None;
                }
                let bv = self.match_numeral(b)?;
                if bv == 0 {
                    return Some(a);
                }
                if !self.force_nf(a, &mut bud) {
                    return None;
                }
                let av = self.match_numeral(a)?;
                let k = self.k_cell();
                Some(self.nat_chain((av - bv).max(0), k))
            }
            4..=10 => {
                // comparisons: force both
                if !self.force_nf(a, &mut bud) {
                    return None;
                }
                let av = self.match_numeral(a)?;
                if !self.force_nf(b, &mut bud) {
                    return None;
                }
                let bv = self.match_numeral(b)?;
                Some(match kind {
                    4 => self.bool_cell(av == bv),
                    5 => self.bool_cell(av != bv),
                    6 => self.bool_cell(av < bv),
                    7 => self.bool_cell(av <= bv),
                    8 => self.bool_cell(av > bv),
                    9 => self.bool_cell(av >= bv),
                    _ => self.ord_cell(if av == bv { 0 } else if av < bv { -1 } else { 1 }),
                })
            }
            _ => None,
        }
    }

    /// Contract the leftmost-outermost redex at `head` + its unwound `spine` (app-cell indices,
    /// outermost first). Mutates in place; false if `head` is WHNF for these args. Dispatch
    /// order mirrors `reduce.ts`/`graph.ts` so the normal form matches.
    fn contract(&mut self, head: i32, spine: &[i32]) -> bool {
        let m = spine.len();
        // arg(k): the k-th argument from the head (k=0 is the leftmost / innermost app's arg).
        let arg = |g: &Graph, k: usize| g.arg_of(spine[m - 1 - k]);
        let hc = self.nodes[head as usize];
        if hc.tag == TAG_IOTA {
            if m < 1 {
                return false;
            } // ι x → x S K
            let x = arg(self, 0);
            let s = self.push(TAG_COMB, self.sym_s, 0);
            let k = self.push(TAG_COMB, self.sym_k, 0);
            let xs = self.app(x, s);
            let r = self.app(xs, k);
            self.set_ind(spine[m - 1], r);
            return true;
        }
        if hc.tag == TAG_COMB {
            let sym = hc.a;
            if sym == self.sym_i {
                if m < 1 {
                    return false;
                } // I x → x
                let x = arg(self, 0);
                self.set_ind(spine[m - 1], x);
                return true;
            }
            if sym == self.sym_k {
                if m < 2 {
                    return false;
                } // K x y → x  (y never forced — laziness)
                let x = arg(self, 0);
                self.set_ind(spine[m - 2], x);
                return true;
            }
            if sym == self.sym_s {
                if m < 3 {
                    return false;
                } // S x y z → x z (y z), z SHARED by index
                let x = arg(self, 0);
                let y = arg(self, 1);
                let z = arg(self, 2);
                let xz = self.app(x, z);
                let yz = self.app(y, z);
                let r = self.app(xz, yz);
                self.set_ind(spine[m - 3], r);
                return true;
            }
            let arity = {
                let a = self.syms[sym as usize].arity;
                if a == 0 {
                    1
                } else {
                    a as usize
                }
            };
            if m < arity {
                return false;
            } // partial named combinator → WHNF
            // Number kernel: a saturated native op, when its operands are values, computes
            // the canonical Scott result directly (clean Succ^k K — no raw blow-up). On a
            // miss (operand not yet a value) fall through to def-unfold / keep reducing.
            let kind = self.syms[sym as usize].kernel;
            if kind > 0 && self.kern.numbers && m >= 2 {
                let a = self.arg_of(spine[m - 1]); // left operand
                let b = self.arg_of(spine[m - 2]); // right operand
                if let Some(r) = self.fire_number_kernel(kind, a, b) {
                    self.set_ind(spine[m - 2], r); // the saturated (op a b) redex
                    return true;
                }
            }
            let def_root = self.syms[sym as usize].def_root;
            if def_root >= 0 {
                let g = self.clone_def(def_root); // unfold its SKI def (fresh copy)
                self.set_ind(head, g);
                return true;
            }
            return false; // inert combinator → WHNF
        }
        false // free variable → WHNF
    }

    /// One leftmost-outermost contraction anywhere from `root`; false → normal form.
    /// ITERATIVE (an explicit work stack) — a recursive arg descent overflows the wasm stack
    /// on a deep `Succ^k K` normal form. Leftmost-outermost order: try the spine head, then the
    /// args left-to-right (push reversed so the leftmost is popped first).
    fn step(&mut self, root: i32) -> bool {
        let mut work: Vec<i32> = Vec::with_capacity(64);
        work.push(root);
        let mut spine: Vec<i32> = Vec::with_capacity(64);
        while let Some(r) = work.pop() {
            spine.clear();
            let mut cur = self.force(r);
            while self.nodes[cur as usize].tag == TAG_APP {
                spine.push(cur);
                cur = self.force(self.nodes[cur as usize].a);
            }
            if self.contract(cur, &spine) {
                return true;
            }
            // push args so the leftmost (spine.last().arg) is popped first
            for &s in spine.iter() {
                work.push(self.arg_of(s));
            }
        }
        false
    }

    /// Read the live graph into a fresh 0-based node list, FORCING indirections + sharing
    /// cells (a DAG — a shared cell is emitted once). ITERATIVE (a recursive readback overflows
    /// the wasm stack on a deep `Succ^k K`): an explicit stack, memo `-1` unvisited / `-2`
    /// in-progress / `>=0` done. Leaves (comb/iota/free) carry no prefix references, so the
    /// list is self-contained. Returns (nodes, root).
    fn readback_live(&self, root: i32) -> (Vec<Node>, i32) {
        let mut out: Vec<Node> = Vec::new();
        let mut memo = vec![-1i32; self.nodes.len()];
        let mut stack: Vec<(i32, bool)> = vec![(self.force(root), false)];
        while let Some((f, done)) = stack.pop() {
            let fi = f as usize;
            if !done {
                if memo[fi] != -1 {
                    continue; // already visited / in progress / done
                }
                let n = self.nodes[fi];
                if n.tag == TAG_APP {
                    memo[fi] = -2; // in progress
                    stack.push((f, true));
                    stack.push((self.force(n.b), false));
                    stack.push((self.force(n.a), false));
                } else {
                    out.push(n);
                    memo[fi] = out.len() as i32 - 1;
                }
            } else {
                let n = self.nodes[fi];
                let fr = memo[self.force(n.a) as usize];
                let ar = memo[self.force(n.b) as usize];
                out.push(Node { tag: TAG_APP, a: fr, b: ar });
                memo[fi] = out.len() as i32 - 1;
            }
        }
        let r = memo[self.force(root) as usize];
        (out, if r < 0 { 0 } else { r })
    }

    /// Compact the arena AND return the display snapshot: read back the live DAG (forced,
    /// shared, no INDs), rebuild the working region from it (preserving the immutable def
    /// prefix, so def_root stays valid), and emit the same DAG for display. This reclaims IND
    /// chains + dead cells so a long resident reduction's arena stays bounded. Returns
    /// (display array, the new root index into the compacted arena).
    fn snapshot(&mut self, root: i32, steps: i32, done: bool) -> (Vec<i32>, i32) {
        let (live, lr) = self.readback_live(root);
        // display array: [done, steps, root(0-based), count] + nodes×3 (leaves self-contained)
        let mut res = Vec::with_capacity(4 + live.len() * 3);
        res.push(if done { 1 } else { 0 });
        res.push(steps);
        res.push(lr);
        res.push(live.len() as i32);
        for nd in &live {
            res.push(nd.tag);
            res.push(nd.a);
            res.push(nd.b);
        }
        // compact the arena: working region := the live DAG, offset past the def prefix.
        let dl = self.def_len as i32;
        self.nodes.truncate(self.def_len);
        for nd in &live {
            if nd.tag == TAG_APP {
                self.nodes.push(Node { tag: TAG_APP, a: nd.a + dl, b: nd.b + dl });
            } else {
                self.nodes.push(*nd);
            }
        }
        (res, dl + lr)
    }
}

/// A resident call-by-need (sharing) reduction — the Turbo graph engine.
#[wasm_bindgen]
pub struct GraphSession {
    g: Graph,
    root: i32,
    steps: u32,
    done: bool,
}

#[wasm_bindgen]
impl GraphSession {
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[i32]) -> GraphSession {
        let (g, root) = Graph::from_wire(data);
        GraphSession { g, root, steps: 0, done: false }
    }
    pub fn step_budget(&mut self, max_steps: u32) -> u32 {
        if self.done {
            return 0;
        }
        let mut did = 0u32;
        while did < max_steps {
            if self.g.nodes.len() >= MAX_NODES {
                break;
            }
            if self.g.step(self.root) {
                self.steps += 1;
                did += 1;
            } else {
                self.done = true;
                break;
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
        self.g.nodes.len() as u32
    }
    /// The current graph as a shared DAG (forced, sharing preserved) for display; also
    /// compacts the arena (reclaims IND chains + dead cells) and updates the root.
    pub fn snapshot(&mut self) -> Vec<i32> {
        let (res, new_root) = self.g.snapshot(self.root, self.steps as i32, self.done);
        self.root = new_root;
        res
    }
}
