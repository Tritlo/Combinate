//! minimal-forms — exhaustive search for minimal pure-ι combinator forms (ADR 27).
//!
//! Enumerate every pure-ι term up to `--max-iotas` leaves (valid IOTA_CODEs = binary
//! tree shapes, Catalan-many per size), compute each term's SYMBOLIC SIGNATURE — the
//! full normal form of `t v0 … v4` on fresh free variables (by Church–Rosser, equal
//! open-term NFs *prove* extensional equality at that arity) — and bucket terms into
//! equivalence classes. For each catalog bird (birds.txt, generated from the TS
//! catalog by scripts/gen-minimal-birds.ts), a merged frontier of candidates — its
//! arity-5 class members plus every term whose signature capped (unknown, so possibly
//! equal) — is walked in ascending (ι-count, bitcode) order and re-verified at the
//! bird's DECLARED arity (arity-5 equality does not imply lower-arity equality:
//! K I vs S K differ at arity 1). The first match is the minimal form; the status is
//! `proven` only if every earlier frontier entry RESOLVED and differed — any still-
//! unresolved (capped even under escalated budgets) predecessor downgrades the claim
//! to `conditional`. Birds with no match in bound report `not-found-within-bound`.
//!
//! Caps are deterministic per term: contraction steps, plus a per-signature scratch
//! allocation budget (reduction intermediates live in a scratch arena cleared per
//! signature — also the memory story: the persistent arena holds only enumerated
//! terms). The scratch budget counts DISTINCT subterms materialized, a slightly
//! looser guard than the TS reducer's tree-size cap; the TypeScript certification
//! pass (scripts/certify-minimal.ts) re-proves every published claim under the app's
//! own reducer and caps, and is the final word.
//!
//! Reduction semantics mirror src/core/reduce.ts: leftmost-outermost to full normal
//! form; ι x → x S K (introducing S/K leaves); S/K/I contraction; free variables
//! inert. NF strings use probe.ts structKey's exact format. All walks are iterative.

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc; // 16-thread glibc fragmentation was a ~1.3x multiplier on everything

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::atomic::Ordering;
use std::time::Instant;

/// Zero-dep splitmix64 hasher — keys are already well-mixed integers; SipHash
/// (std's default) costs ~2× on the hot dedup/class maps.
#[derive(Default)]
struct Mix64(u64);
impl Hasher for Mix64 {
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0xff51afd7ed558ccd);
        }
    }
    fn write_u64(&mut self, x: u64) {
        let mut z = self.0 ^ x;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        self.0 = z ^ (z >> 31);
    }
    fn finish(&self) -> u64 {
        self.0
    }
}
type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<Mix64>>;

/// Open-addressed key-only set for 128-bit class keys — class_of's value side was nearly
/// dead weight (~24GB as a map at 42ι; ~10GB as this set). 0 is the empty sentinel (real
/// keys remap 0→1: collision odds are ~2^-128).
struct U128Set {
    slots: Vec<u128>,
    len: usize,
}
impl U128Set {
    fn new() -> Self {
        U128Set { slots: vec![0; 1 << 16], len: 0 }
    }
    /// Presize for `n` keys at 0.8 load — the doubling grow() holds old+new tables
    /// simultaneously (a 48GB transient at 42-iota scale); presizing makes it flat.
    fn with_capacity(n: usize) -> Self {
        let slots = (n * 5 / 4 + 1).next_power_of_two().max(1 << 16);
        U128Set { slots: vec![0; slots], len: 0 }
    }
    #[inline]
    fn canon(k: (u64, u64)) -> u128 {
        let v = ((k.0 as u128) << 64) | k.1 as u128;
        if v == 0 { 1 } else { v }
    }
    #[inline]
    fn insert(&mut self, key: (u64, u64)) -> bool {
        // returns true if NEW
        if self.len * 5 >= self.slots.len() * 4 {
            self.grow();
        }
        let k = Self::canon(key);
        let mask = self.slots.len() - 1;
        let mut i = (k as u64 as usize).wrapping_mul(0x9E3779B97F4A7C15usize.wrapping_add(0)) & mask;
        loop {
            let s = self.slots[i];
            if s == 0 {
                self.slots[i] = k;
                self.len += 1;
                return true;
            }
            if s == k {
                return false;
            }
            i = (i + 1) & mask;
        }
    }
    /// insert an already-canonical key (snapshot load path)
    fn insert_raw(&mut self, k: u128) {
        if self.len * 5 >= self.slots.len() * 4 {
            self.grow();
        }
        let mask = self.slots.len() - 1;
        let mut i = (k as u64 as usize).wrapping_mul(0x9E3779B97F4A7C15usize.wrapping_add(0)) & mask;
        loop {
            let s = self.slots[i];
            if s == 0 {
                self.slots[i] = k;
                self.len += 1;
                return;
            }
            if s == k {
                return;
            }
            i = (i + 1) & mask;
        }
    }
    fn grow(&mut self) {
        let newlen = self.slots.len() * 2;
        let old = std::mem::replace(&mut self.slots, vec![0; newlen]);
        let mask = self.slots.len() - 1;
        for k in old {
            if k == 0 { continue; }
            let mut i = (k as u64 as usize).wrapping_mul(0x9E3779B97F4A7C15usize.wrapping_add(0)) & mask;
            while self.slots[i] != 0 { i = (i + 1) & mask; }
            self.slots[i] = k;
        }
    }
}

// ---------------- term arena: persistent (enumerated terms) + scratch (reduction) ----------------

const TAG_IOTA: u8 = 0;
const TAG_S: u8 = 1;
const TAG_K: u8 = 2;
const TAG_I: u8 = 3;
const TAG_FREE: u8 = 4; // a = var index
const TAG_APP: u8 = 5; // a = fn, b = arg

/// Ids ≥ SCRATCH_BASE live in the scratch arena (cleared per signature); below it,
/// the persistent arena. App nodes pack as flag+31+31 bits, so ids may reach 2^31.
const SCRATCH_BASE: u32 = 3 << 29; // persistent ceiling 1.61B (bound ~44); scratch gets the remaining ~536M of the 31-bit space

#[derive(Clone, Copy)]
struct Node {
    tag: u8,
    a: u32,
    b: u32,
}

/// A node IS its packed dedup key: tag<<60 | a<<30 | b (ids stay under 2^30 —
/// SCRATCH_BASE is 1<<29). 8 bytes/node instead of 12: ~1.5× cache density on the
/// hottest array in the program, and mk() stores the word it already computed.
#[inline(always)]
const fn pack(tag: u8, a: u32, b: u32) -> u64 {
    // apps: bit63 | a<<31 | b (31-bit ids — ceiling 2^31); leaves: tag<<32 | payload
    if tag == TAG_APP {
        (1u64 << 63) | ((a as u64) << 31) | b as u64
    } else {
        ((tag as u64) << 32) | a as u64
    }
}
#[inline(always)]
const fn unpack(w: u64) -> Node {
    if w >> 63 == 1 {
        Node { tag: TAG_APP, a: ((w >> 31) & 0x7FFF_FFFF) as u32, b: (w & 0x7FFF_FFFF) as u32 }
    } else {
        Node { tag: (w >> 32) as u8, a: (w & 0xFFFF_FFFF) as u32, b: 0 }
    }
}

struct Arena {
    /// Max spine length ever applied to a FREE-VAR head across the whole run.
    /// DIAGNOSTIC ONLY (it includes the probe's own arity, so it scales with the
    /// signature arity — it is not a congruence certificate).
    max_var_demand: usize,
    p_nodes: Vec<u64>,
    p_dedup: FastMap<u64, u32>,
    s_nodes: Vec<u64>,
    s_dedup: FastMap<u64, u32>,
    l_cache: [u32; 23],
}

impl Arena {
    fn new() -> Self {
        Arena {
            max_var_demand: 0,
            p_nodes: Vec::new(),
            p_dedup: FastMap::default(),
            s_nodes: Vec::new(),
            s_dedup: FastMap::default(),
            l_cache: [u32::MAX; 23],
        }
    }
    /// Persistent intern — serial phases only (enumeration, DP composition, decode).
    /// APP nodes append WITHOUT dedup (merge-time pairs are unique; the map was ~30B/node
    /// of pure overhead — its one real user was scratch-reduction reuse, now foregone).
    /// decode_bits paths may duplicate small shared subtrees: wasted nodes, not wrong ones.
    fn intern(&mut self, tag: u8, a: u32, b: u32) -> u32 {
        let key = pack(tag, a, b);
        if tag == TAG_APP {
            let id = self.p_nodes.len() as u32;
            assert!(id < SCRATCH_BASE, "persistent arena exceeded the 2^30 id space");
            self.p_nodes.push(key);
            return id;
        }
        if let Some(&id) = self.p_dedup.get(&key) {
            return id;
        }
        debug_assert!(a < SCRATCH_BASE && b < SCRATCH_BASE, "persistent node referencing scratch");
        let id = self.p_nodes.len() as u32;
        assert!(id < SCRATCH_BASE, "persistent arena exceeded the 2^30 id space");
        self.p_nodes.push(key);
        self.p_dedup.insert(key, id);
        id
    }
    fn leaf(&mut self, tag: u8, a: u32) -> u32 {
        self.intern(tag, a, 0)
    }
    fn app(&mut self, f: u32, x: u32) -> u32 {
        self.intern(TAG_APP, f, x)
    }
    fn node(&self, id: u32) -> Node {
        if id >= SCRATCH_BASE {
            unpack(self.s_nodes[(id - SCRATCH_BASE) as usize])
        } else {
            unpack(self.p_nodes[id as usize])
        }
    }
}

/// What reduction needs: read any node, allocate into SCRATCH (persistent stays
/// immutable during reduction — that is what makes signature computation safe to
/// fan out across threads), plus scratch bookkeeping. Implemented by the serial
/// `Arena` façade and by per-thread `Worker` views.
trait Red {
    fn nd(&self, id: u32) -> Node;
    fn mk(&mut self, tag: u8, a: u32, b: u32) -> u32;
    fn s_len(&self) -> usize;
    fn s_clear(&mut self);
    fn demand(&mut self, d: usize);
    fn leaf_cache(&mut self) -> &mut [u32; 23];
    /// Leaves are the hottest allocations (ι x → x S K mints S+K every step; probes mint
    /// free vars) — cache their per-window ids so they never touch a map. Slot 0..=2 =
    /// S/K/I, 3.. = free vars. Ids identical to what the maps would return.
    fn mk_leaf(&mut self, tag: u8, a: u32) -> u32 {
        let slot = match tag {
            TAG_S => 0usize,
            TAG_K => 1,
            TAG_I => 2,
            TAG_FREE => 3 + a as usize,
            _ => return self.mk(tag, a, 0),
        };
        let cached = self.leaf_cache()[slot];
        if cached != u32::MAX {
            return cached;
        }
        let id = self.mk(tag, a, 0);
        self.leaf_cache()[slot] = id;
        id
    }
    fn mk_app(&mut self, f: u32, x: u32) -> u32 {
        self.mk(TAG_APP, f, x)
    }
}

/// Shared scratch-intern logic. The persistent map is only probed when BOTH children are
/// persistent ids — a node referencing scratch provably cannot be in p_dedup (persistent
/// nodes reference only persistent ids), and skipping that probe removes a big-map lookup
/// from most reduction allocations.
#[inline]
fn scratch_intern(p_dedup: &FastMap<u64, u32>, s_nodes: &mut Vec<u64>, s_dedup: &mut FastMap<u64, u32>, tag: u8, a: u32, b: u32) -> u32 {
    let key = pack(tag, a, b);
    if a < SCRATCH_BASE && b < SCRATCH_BASE {
        if let Some(&id) = p_dedup.get(&key) {
            return id;
        }
    }
    if let Some(&id) = s_dedup.get(&key) {
        return id;
    }
    let id = SCRATCH_BASE + s_nodes.len() as u32;
    s_nodes.push(key);
    s_dedup.insert(key, id);
    id
}

impl Red for Arena {
    fn nd(&self, id: u32) -> Node {
        self.node(id)
    }
    fn mk(&mut self, tag: u8, a: u32, b: u32) -> u32 {
        scratch_intern(&self.p_dedup, &mut self.s_nodes, &mut self.s_dedup, tag, a, b)
    }
    fn s_len(&self) -> usize {
        self.s_nodes.len()
    }
    fn s_clear(&mut self) {
        self.s_nodes.clear();
        if self.s_dedup.capacity() > 1 << 21 {
            self.s_dedup = FastMap::default(); // one esc-scale candidate shouldn't tax every later one
        } else {
            self.s_dedup.clear();
        }
        self.l_cache = [u32::MAX; 23];
    }
    fn demand(&mut self, d: usize) {
        if d > self.max_var_demand {
            self.max_var_demand = d;
        }
    }
    fn leaf_cache(&mut self) -> &mut [u32; 23] {
        &mut self.l_cache
    }
}

/// A parallel worker's view: shared immutable persistent arena + private scratch.
struct Worker<'a> {
    p_nodes: &'a [u64],
    p_dedup: &'a FastMap<u64, u32>,
    s_nodes: Vec<u64>,
    s_dedup: FastMap<u64, u32>,
    max_var_demand: usize,
    l_cache: [u32; 23],
}

impl<'a> Red for Worker<'a> {
    fn nd(&self, id: u32) -> Node {
        if id >= SCRATCH_BASE {
            unpack(self.s_nodes[(id - SCRATCH_BASE) as usize])
        } else {
            unpack(self.p_nodes[id as usize])
        }
    }
    fn mk(&mut self, tag: u8, a: u32, b: u32) -> u32 {
        scratch_intern(self.p_dedup, &mut self.s_nodes, &mut self.s_dedup, tag, a, b)
    }
    fn s_len(&self) -> usize {
        self.s_nodes.len()
    }
    fn s_clear(&mut self) {
        self.s_nodes.clear();
        if self.s_dedup.capacity() > 1 << 21 {
            self.s_dedup = FastMap::default(); // one esc-scale candidate shouldn't tax every later one
        } else {
            self.s_dedup.clear();
        }
        self.l_cache = [u32::MAX; 23];
    }
    fn demand(&mut self, d: usize) {
        if d > self.max_var_demand {
            self.max_var_demand = d;
        }
    }
    fn leaf_cache(&mut self) -> &mut [u32; 23] {
        &mut self.l_cache
    }
}

// ---------------- reducer: leftmost-outermost to full NF ----------------

enum Frame {
    Norm(u32),
    Rebuild(u32, usize, u32), // (stuck head, argc, ORIGIN id — cached to its rebuilt NF)
}

/// Reusable per-thread work buffers — normalize/struct_hash previously heap-allocated
/// four fresh Vecs per call (~24M allocs per deep run).
#[derive(Default)]
struct ReduceBufs {
    frames: Vec<Frame>,
    results: Vec<u32>,
    spine: Vec<u32>,
    hstack: Vec<u32>,
    /// Merkle-hash memo for the hash-only NF fingerprint, valid for one scratch window
    /// (cleared alongside s_clear — scratch ids recycle; persistent subtrees are tiny).
    hmemo: FastMap<u32, (u64, u64)>,
    /// Normal-form memo (term id → its NF id), valid for one scratch window. Without it
    /// normalize walks shared DAGs TREE-EXPANDED — an already-normal 2M-node NF under
    /// escalated budgets can expand astronomically (observed: single esc jobs burning
    /// minutes). With it, normalize is O(distinct nodes).
    nf_cache: FastMap<u32, u32>,
}


struct Caps {
    steps: u64,
    nodes: usize, // scratch-allocation budget per signature
}

enum NfResult {
    Done(u32),
    Capped,
}

/// Fixed-capacity signature vector (dp_arity <= 12) — Copy, no heap. The per-layer
/// results buffer used to materialize a Vec per candidate (GBs of churn at 30ι+).
const SIG_MAX: usize = 9; // dp_arity <= 8 — Rep shrinks 209->145B, ~10GB less at 40-iota scale
#[derive(Clone, Copy)]
struct SigVec {
    len: u8,
    v: [(u64, u64); SIG_MAX],
}
impl SigVec {
    fn new() -> Self {
        SigVec { len: 0, v: [(0, 0); SIG_MAX] }
    }
    fn push(&mut self, h: (u64, u64)) {
        self.v[self.len as usize] = h;
        self.len += 1;
    }
    fn slice(&self) -> &[(u64, u64)] {
        &self.v[..self.len as usize]
    }
}

/// Signature-vector outcome: fully resolved, or capped at some arity with the resolved
/// PREFIX retained — capped terms sharing a prefix behave identically on every arity we
/// could observe, so only the first of each prefix-class composes forward (the rest stay
/// as frontier blockers only; a labeled completeness trade on arg-side rescues).
#[derive(Clone, Copy)]
enum SigRes {
    Full(SigVec),
    Capped(SigVec),
}

/// Reduce `root` to full normal form. Iterative: an explicit spine stack for the
/// head-reduction loop, and an explicit frame stack for normalizing the arguments of
/// a stuck head. Caps: total contractions + scratch nodes allocated (the caller runs
/// this inside a fresh scratch window, so both are deterministic per term).
fn normalize<A: Red>(arena: &mut A, root: u32, caps: &Caps, steps_used: &mut u64, bufs: &mut ReduceBufs) -> NfResult {
    let ReduceBufs { frames, results, spine, nf_cache: bufs_nf, .. } = bufs;
    frames.clear();
    results.clear();
    spine.clear();
    frames.push(Frame::Norm(root));

    while let Some(frame) = frames.pop() {
        match frame {
            Frame::Norm(mut t) => {
                if let Some(&nf) = bufs_nf.get(&t) {
                    results.push(nf);
                    continue;
                }
                let orig = t;
                // Head-reduce: unwind the application spine, contract at the head until stuck.
                spine.clear();
                loop {
                    let n = arena.nd(t);
                    if n.tag == TAG_APP {
                        spine.push(n.b);
                        t = n.a;
                        continue;
                    }
                    // Leaf head; spine top = FIRST argument.
                    let argc = spine.len();
                    if n.tag == TAG_FREE {
                        arena.demand(argc);
                    }
                    let contracted = match n.tag {
                        TAG_IOTA if argc >= 1 => {
                            // ι x → x S K
                            let x = spine.pop().unwrap();
                            let s = arena.mk_leaf(TAG_S, 0);
                            let k = arena.mk_leaf(TAG_K, 0);
                            spine.push(k);
                            spine.push(s);
                            t = x;
                            true
                        }
                        TAG_I if argc >= 1 => {
                            t = spine.pop().unwrap();
                            true
                        }
                        TAG_K if argc >= 2 => {
                            let x = spine.pop().unwrap();
                            spine.pop();
                            t = x;
                            true
                        }
                        TAG_S if argc >= 3 => {
                            // S f g x → f x (g x)
                            let f = spine.pop().unwrap();
                            let g = spine.pop().unwrap();
                            let x = spine.pop().unwrap();
                            let gx = arena.mk_app(g, x);
                            spine.push(gx);
                            spine.push(x);
                            t = f;
                            true
                        }
                        _ => false,
                    };
                    if contracted {
                        *steps_used += 1;
                        if *steps_used > caps.steps || arena.s_len() > caps.nodes {
                            return NfResult::Capped;
                        }
                        continue;
                    }
                    break;
                }
                // Stuck head `t`; normalize each arg then rebuild. spine top = first arg.
                // Frames are LIFO: push args bottom-first (last arg first), so the FIRST
                // arg's Norm frame pops first — leftmost-outermost order — and results
                // arrive first-arg-first at results[split..].
                let argc = spine.len();
                frames.push(Frame::Rebuild(t, argc, orig));
                for i in 0..argc {
                    frames.push(Frame::Norm(spine[i]));
                }
                spine.clear();
            }
            Frame::Rebuild(head, argc, orig) => {
                // results[split..] = normalized args, FIRST arg first — apply in order.
                let split = results.len() - argc;
                let mut t = head;
                for i in split..results.len() {
                    let a = results[i];
                    t = arena.mk_app(t, a);
                }
                results.truncate(split);
                results.push(t);
                bufs_nf.insert(orig, t);
            }
        }
    }
    debug_assert_eq!(results.len(), 1);
    NfResult::Done(results[0])
}

// ---------------- canonical key: EXACT structKey port (probe.ts) + 128-bit hash ----------------

/// Stream the canonical structural string of `t` — byte-identical to probe.ts
/// structKey: `ι`, `cS`/`cK`/`cI`, `v<name>`, `(fn arg)` — into two FNV/rot
/// accumulators; optionally materialize the string (reported artifacts only).
fn struct_hash<A: Red>(arena: &A, t: u32, want_string: bool) -> (u64, u64, Option<String>) {
    let mut h1: u64 = 0xcbf29ce484222325;
    let mut h2: u64 = 0x9e3779b97f4a7c15;
    let mut s = if want_string { Some(String::new()) } else { None };
    enum W {
        T(u32),
        Lit(&'static str),
    }
    let mut eat = |txt: &str, s: &mut Option<String>| {
        for &b in txt.as_bytes() {
            h1 = (h1 ^ b as u64).wrapping_mul(0x100000001b3);
            h2 = (h2 ^ b as u64).wrapping_mul(0x100000001b3).rotate_left(17);
        }
        if let Some(st) = s {
            st.push_str(txt);
        }
    };
    const VARS: [&str; 20] = ["va", "vb", "vc", "vd", "ve", "vf", "vg", "vh", "vi", "vj", "vk", "vl", "vm", "vn", "vo", "vp", "vq", "vr", "vs", "vt"];
    let mut stack: Vec<W> = vec![W::T(t)];
    while let Some(w) = stack.pop() {
        match w {
            W::Lit(l) => eat(l, &mut s),
            W::T(id) => {
                let n = arena.nd(id);
                match n.tag {
                    TAG_APP => {
                        eat("(", &mut s);
                        stack.push(W::Lit(")"));
                        stack.push(W::T(n.b));
                        stack.push(W::Lit(" "));
                        stack.push(W::T(n.a));
                    }
                    TAG_IOTA => eat("ι", &mut s),
                    TAG_S => eat("cS", &mut s),
                    TAG_K => eat("cK", &mut s),
                    TAG_I => eat("cI", &mut s),
                    TAG_FREE => eat(VARS[n.a as usize], &mut s),
                    _ => unreachable!(),
                }
            }
        }
    }
    (h1, h2, s)
}

#[inline]
fn hmix(tag: u64, l: (u64, u64), r: (u64, u64)) -> (u64, u64) {
    let mut h1 = 0xcbf29ce484222325u64 ^ tag;
    let mut h2 = 0x9e3779b97f4a7c15u64 ^ tag.rotate_left(32);
    for w in [l.0, l.1, r.0, r.1] {
        h1 = (h1 ^ w).wrapping_mul(0x100000001b3).rotate_left(5);
        h2 = (h2 ^ w.rotate_left(17)).wrapping_mul(0xC2B2AE3D27D4EB4F);
    }
    (h1, h2)
}

/// 128-bit structural fingerprint of an NF, computed over the DAG with per-node
/// memoization (O(distinct nodes)) instead of streaming the tree-EXPANDED canonical
/// string (which blows up exactly on share-heavy NFs). Rust-internal (class bucketing
/// only — exact NF strings still guard every published claim), so its VALUE may differ
/// from the old string hash; the induced partition is the same tree-structure equality.
fn merkle_hash<A: Red>(arena: &A, t: u32, bufs: &mut ReduceBufs) -> (u64, u64) {
    let mut stack = std::mem::take(&mut bufs.hstack);
    stack.clear();
    stack.push(t);
    while let Some(&id) = stack.last() {
        if bufs.hmemo.contains_key(&id) {
            stack.pop();
            continue;
        }
        let n = arena.nd(id);
        if n.tag == TAG_APP {
            let lh = bufs.hmemo.get(&n.a).copied();
            let rh = bufs.hmemo.get(&n.b).copied();
            match (lh, rh) {
                (Some(l), Some(r)) => {
                    let h = hmix(1, l, r);
                    stack.pop();
                    bufs.hmemo.insert(id, h);
                }
                _ => {
                    if lh.is_none() {
                        stack.push(n.a);
                    }
                    if rh.is_none() {
                        stack.push(n.b);
                    }
                }
            }
        } else {
            let h = hmix(2 + n.tag as u64, (n.a as u64, 0), (0, 0));
            stack.pop();
            bufs.hmemo.insert(id, h);
        }
    }
    bufs.hstack = stack;
    bufs.hmemo[&t]
}

// ---------------- signatures ----------------

const SIG_ARITY: usize = 5;

/// NF signature hash of `t v0 … v(arity-1)`, or None if capped. Runs in a fresh
/// scratch window (cleared on entry) so caps are deterministic per term.
fn signature<A: Red>(arena: &mut A, t: u32, arity: usize, caps: &Caps, bufs: &mut ReduceBufs) -> Option<(u64, u64)> {
    signature_vars(arena, t, arity, caps, true, bufs)
}

/// Like `signature`, but `distinct = false` applies the SAME fresh variable `arity`
/// times: t x x … x. Identifying variables is a homomorphic coarsening, so equal
/// terms MUST collide here — a cheap necessary condition (the QuickSpec prefilter);
/// only colliding terms need the distinct-variable proof.
fn signature_vars<A: Red>(arena: &mut A, t: u32, arity: usize, caps: &Caps, distinct: bool, bufs: &mut ReduceBufs) -> Option<(u64, u64)> {
    arena.s_clear();
    bufs.hmemo.clear();
    bufs.nf_cache.clear();
    let mut applied = t;
    for v in 0..arity {
        let fv = arena.mk_leaf(TAG_FREE, if distinct { v as u32 } else { 0 });
        applied = arena.mk_app(applied, fv);
    }
    let mut steps = 0u64;
    match normalize(arena, applied, caps, &mut steps, bufs) {
        NfResult::Done(nf) => Some(merkle_hash(arena, nf, bufs)),
        NfResult::Capped => None,
    }
}

/// NF STRING of `t v0 … v(arity-1)` (reported artifacts), or None if capped.
fn nf_string<A: Red>(arena: &mut A, t: u32, arity: usize, caps: &Caps, bufs: &mut ReduceBufs) -> Option<String> {
    arena.s_clear();
    bufs.nf_cache.clear();
    let mut applied = t;
    for v in 0..arity {
        let fv = arena.mk_leaf(TAG_FREE, v as u32);
        applied = arena.mk_app(applied, fv);
    }
    let mut steps = 0u64;
    match normalize(arena, applied, caps, &mut steps, bufs) {
        NfResult::Done(nf) => struct_hash(arena, nf, true).2,
        NfResult::Capped => None,
    }
}

// ---------------- bitcode <-> term (persistent arena) ----------------

fn decode_bits(arena: &mut Arena, bits: &str) -> Option<u32> {
    let mut stack: Vec<u32> = Vec::new();
    for &b in bits.as_bytes().iter().rev() {
        match b {
            b'1' => {
                let l = arena.leaf(TAG_IOTA, 0);
                stack.push(l);
            }
            b'0' => {
                let f = stack.pop()?;
                let x = stack.pop()?;
                let a = arena.app(f, x);
                stack.push(a);
            }
            _ => return None,
        }
    }
    if stack.len() == 1 {
        Some(stack[0])
    } else {
        None
    }
}

fn encode_bits(arena: &Arena, t: u32) -> String {
    let mut out = String::new();
    let mut stack = vec![t];
    while let Some(id) = stack.pop() {
        let n = arena.node(id);
        if n.tag == TAG_APP {
            out.push('0');
            stack.push(n.b);
            stack.push(n.a);
        } else {
            out.push('1');
        }
    }
    out
}

/// encode app(f,x) WITHOUT interning a node — the fastest/FPC tracking paths were
/// minting rep-unreachable persistent apps just to stringify them.
fn encode_bits_pair(arena: &Arena, f: u32, x: u32) -> String {
    format!("0{}{}", encode_bits(arena, f), encode_bits(arena, x))
}

fn iota_count(arena: &Arena, t: u32) -> u32 {
    let mut c = 0;
    let mut stack = vec![t];
    while let Some(id) = stack.pop() {
        let n = arena.node(id);
        if n.tag == TAG_APP {
            stack.push(n.a);
            stack.push(n.b);
        } else {
            c += 1;
        }
    }
    c
}

// ---------------- main ----------------

struct Bird {
    sym: String,
    arity: usize,
    bits: String,
    seed_steps: Option<u64>, // known fastest steps from prior hunts — the bail-out bound starts here
}

/// Steps to full NF of `head(·arg) v0..v(arity-1)` — the TS-comparable cost of USING a
/// term at its declared arity (both reducers are leftmost-outermost to full NF, so the
/// contraction counts agree). None if capped.
fn direct_steps<A: Red>(arena: &mut A, head: u32, arg: Option<u32>, arity: usize, caps: &Caps, bufs: &mut ReduceBufs) -> Option<u64> {
    arena.s_clear();
    bufs.hmemo.clear();
    bufs.nf_cache.clear();
    let mut applied = match arg {
        Some(x) => arena.mk_app(head, x),
        None => head,
    };
    for v in 0..arity {
        let fv = arena.mk_leaf(TAG_FREE, v as u32);
        applied = arena.mk_app(applied, fv);
    }
    let mut steps = 0u64;
    match normalize(arena, applied, caps, &mut steps, bufs) {
        NfResult::Done(_) => Some(steps),
        NfResult::Capped => None,
    }
}

/// Fixpoint-property test (the Y hunt): HEAD-reduce t·f recording every whole-term
/// reduct id; success iff some reduct is literally app(f, R) with R an earlier reduct —
/// then t·f =β f·(t·f) by congruence, a sound machine-checkable certificate (Codex-
/// verified; covers Curry-style and Turing-style FPCs; misses equation shapes needing
/// non-head steps — finds are labeled "head-cycle certificate").
/// Contract every `I x` -> `x` (administrative wrappers) so the cycle detector compares
/// terms modulo bookkeeping — Y-style loops accrete I-wrappers each go-round.
fn i_norm<A: Red>(arena: &mut A, t: u32, memo: &mut FastMap<u32, u32>) -> u32 {
    if let Some(&r) = memo.get(&t) {
        return r;
    }
    let n = arena.nd(t);
    let out = if n.tag == TAG_APP {
        let f2 = i_norm(arena, n.a, memo);
        let x2 = i_norm(arena, n.b, memo);
        if arena.nd(f2).tag == TAG_I {
            x2
        } else {
            arena.mk(TAG_APP, f2, x2)
        }
    } else {
        t
    };
    memo.insert(t, out);
    out
}

fn term_str<A: Red>(arena: &A, t: u32, cap: usize) -> String {
    fn go<A: Red>(arena: &A, t: u32, out: &mut String, cap: usize) {
        if out.len() > cap { return; }
        let n = arena.nd(t);
        match n.tag {
            TAG_APP => { out.push('('); go(arena, n.a, out, cap); out.push(' '); go(arena, n.b, out, cap); out.push(')'); }
            TAG_IOTA => out.push('i'),
            TAG_S => out.push('S'),
            TAG_K => out.push('K'),
            TAG_I => out.push('I'),
            TAG_FREE => out.push('f'),
            _ => out.push('?'),
        }
    }
    let mut o = String::new();
    go(arena, t, &mut o, cap);
    o
}

fn head_trace_fpc<A: Red>(arena: &mut A, t: u32, budget: u64, bufs: &mut ReduceBufs) -> Option<u64> {
    // Fixpoint detector v3: the BÖHM-DESCENT test. A fixpoint combinator's Böhm tree is
    // f(f(f(...))) — every level, forever — so head-reduce to f·X, descend into X, and
    // KEEP descending until the budget dies. Any non-f floor within budget is a
    // definitive rejection: v2 stopped at five levels and accepted finite towers f^k·u —
    // the retracted "26ι FPC" bottoms out at level 17 (t·f =β f^16 (O f), found by hand
    // probing; its NF lands 138 steps past the 2000 budget, which is why v2 never saw
    // it). Budget death after >= DEPTH f-levels is the certificate, honestly labeled
    // "Böhm descent, still f-headed at budget" (the strongest finite evidence a
    // semi-decidable property allows); the value returned is the f^DEPTH timestamp.
    // (v1 — literal-trace recurrence — never fires at all: Curry-style SK cycles are
    // quasi-periodic, terms grow each round; measured on Y-54.)
    const DEPTH: u32 = 5;
    let dbg = std::env::var("FPC_TRACE").is_ok();
    arena.s_clear();
    bufs.hmemo.clear();
    bufs.nf_cache.clear();
    let f = arena.mk_leaf(TAG_FREE, 0);
    let mut cur = arena.mk_app(t, f);
    let mut steps_left = budget;
    let mut total = 0u64;
    let mut depth = 0u32;
    let mut close5 = 0u64;
    let spine = &mut bufs.spine;
    loop {
        // head-reduce `cur` until it is literally f · X (or a floor/budget out)
        loop {
            if steps_left == 0 {
                return if depth >= DEPTH { Some(close5) } else { None };
            }
            let cn = arena.nd(cur);
            if cn.tag == TAG_APP && cn.a == f {
                depth += 1;
                if depth == DEPTH {
                    close5 = total;
                }
                if dbg {
                    eprintln!("  Böhm level {depth} reached after {total} steps");
                }
                cur = cn.b; // descend into the argument
                break;
            }
            // one leftmost head contraction
            spine.clear();
            let mut h = cur;
            loop {
                let n = arena.nd(h);
                if n.tag == TAG_APP {
                    spine.push(n.b);
                    h = n.a;
                } else {
                    break;
                }
            }
            let n = arena.nd(h);
            let argc = spine.len();
            let ok = match n.tag {
                TAG_IOTA if argc >= 1 => {
                    let x = spine.pop().unwrap();
                    let sk = arena.mk_leaf(TAG_S, 0);
                    let kk = arena.mk_leaf(TAG_K, 0);
                    spine.push(kk);
                    spine.push(sk);
                    h = x;
                    true
                }
                TAG_I if argc >= 1 => {
                    h = spine.pop().unwrap();
                    true
                }
                TAG_K if argc >= 2 => {
                    let x = spine.pop().unwrap();
                    spine.pop();
                    h = x;
                    true
                }
                TAG_S if argc >= 3 => {
                    let a1 = spine.pop().unwrap();
                    let a2 = spine.pop().unwrap();
                    let a3 = spine.pop().unwrap();
                    let gx = arena.mk(TAG_APP, a2, a3);
                    spine.push(gx);
                    spine.push(a3);
                    h = a1;
                    true
                }
                _ => false, // stuck head that isn't f: not an fpc shape
            };
            if !ok {
                return None;
            }
            let mut c = h;
            while let Some(a1) = spine.pop() {
                c = arena.mk(TAG_APP, c, a1);
            }
            cur = c;
            steps_left -= 1;
            total += 1;
            if arena.s_len() > 500_000 {
                // resource death, not a floor — same evidence rule as budget death
                return if depth >= DEPTH { Some(close5) } else { None };
            }
        }
    }
}

fn dp_sigvec<A: Red>(arena: &mut A, t: u32, caps: &Caps, dp_a: usize, bufs: &mut ReduceBufs) -> SigRes {
    dp_sigvec_headarg(arena, t, None, caps, dp_a, bufs)
}

/// Like dp_sigvec for the term `head·arg` (or just `head`) WITHOUT requiring the app node
/// to exist: the composition is built in scratch, so candidate pairs never touch the
/// persistent arena — only merge-time winners get interned (kills the serial build phase
/// and pair-proportional memory growth).
fn dp_sigvec_headarg<A: Red>(arena: &mut A, head: u32, arg: Option<u32>, caps: &Caps, dp_a: usize, bufs: &mut ReduceBufs) -> SigRes {
    debug_assert!(dp_a < SIG_MAX);
    arena.s_clear();
    bufs.hmemo.clear();
    bufs.nf_cache.clear();
    let mut v = SigVec::new();
    let mut cur = match arg {
        Some(x) => arena.mk_app(head, x),
        None => head,
    };
    for k in 0..=dp_a {
        let applied = if k == 0 {
            cur
        } else {
            let fv = arena.mk_leaf(TAG_FREE, (k - 1) as u32);
            arena.mk_app(cur, fv)
        };
        let marginal = Caps { steps: caps.steps, nodes: arena.s_len() + caps.nodes };
        let mut steps = 0u64;
        match normalize(arena, applied, &marginal, &mut steps, bufs) {
            NfResult::Done(nf) => {
                v.push(merkle_hash(arena, nf, bufs));
                cur = nf;
            }
            NfResult::Capped => return SigRes::Capped(v),
        }
    }
    SigRes::Full(v)
}

// ---- state snapshot I/O (marathon resume): everything is flat POD arrays after the
// diet, so a snapshot is a handful of length-prefixed slice writes. Little-endian only.
fn w_u64<W: std::io::Write>(f: &mut W, v: u64) {
    f.write_all(&v.to_le_bytes()).unwrap();
}
fn w_slice<T: Copy, W: std::io::Write>(f: &mut W, v: &[T]) {
    w_u64(f, v.len() as u64);
    let bytes = unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) };
    f.write_all(bytes).unwrap();
}
fn r_u64<R: std::io::Read>(f: &mut R) -> u64 {
    let mut b = [0u8; 8];
    f.read_exact(&mut b).unwrap();
    u64::from_le_bytes(b)
}
fn r_vec<T: Copy + Default, R: std::io::Read>(f: &mut R) -> Vec<T> {
    let n = r_u64(f) as usize;
    let mut v = vec![T::default(); n];
    let bytes = unsafe { std::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, n * std::mem::size_of::<T>()) };
    f.read_exact(bytes).unwrap();
    v
}
/// Snapshots stream through `zstd -T0` (compute-for-disk by decision): writer = child stdin.
fn zstd_writer(path: &str) -> (std::process::Child, std::io::BufWriter<std::process::ChildStdin>) {
    let mut ch = std::process::Command::new("zstd")
        .args(["-T0", "-3", "-q", "-f", "-o", path])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("zstd not found — snapshots require it (or pass --no-snapshot)");
    let w = std::io::BufWriter::with_capacity(1 << 22, ch.stdin.take().unwrap());
    (ch, w)
}
fn zstd_reader(path: &str) -> (std::process::Child, std::io::BufReader<std::process::ChildStdout>) {
    let mut ch = std::process::Command::new("zstd")
        .args(["-d", "-q", "-c", path])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("zstd not found — cannot read snapshot");
    let r = std::io::BufReader::with_capacity(1 << 22, ch.stdout.take().unwrap());
    (ch, r)
}
fn birds_hash() -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in include_str!("birds.txt").bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    h
}

fn jstr(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}


// ---------------- exhaustive FPC brute force (--fpc-brute) ----------------

/// Catalan C(k), exact (fits u64 through k = 32).
fn catalan(k: usize) -> u64 {
    let mut c: u128 = 1;
    for j in 0..k {
        c = c * 2 * (2 * j as u128 + 1) / (j as u128 + 2);
    }
    c as u64
}

fn flushout() {
    use std::io::Write;
    let _ = std::io::stdout().flush();
}

/// ways[l][p] = number of preorder-bitcode completions from an enumerator state with
/// p pending subtree slots and exactly l leaves left (the Catalan-triangle ballot
/// numbers) — used only to schedule work items largest-first.
fn ways_table(m: usize) -> Vec<Vec<u64>> {
    let mut w = vec![vec![0u64; m + 2]; m + 1];
    w[0][0] = 1;
    for l in 1..=m {
        for p in (1..=l).rev() {
            let leaf = w[l - 1][p - 1];
            let split = if l > p { w[l][p + 1] } else { 0 };
            w[l][p] = leaf + split;
        }
    }
    w
}

/// Stream every completion of the current enumerator state as full preorder bitcodes
/// (0 = app, 1 = ι); `buf` is restored on return. DFS, so successive codes share
/// prefixes and the enumeration is amortized O(1) per code.
fn gen_codes(buf: &mut Vec<u8>, pending: usize, leaves: usize, cb: &mut dyn FnMut(&[u8])) {
    if pending == 0 {
        if leaves == 0 {
            cb(buf);
        }
        return;
    }
    if leaves > pending {
        buf.push(b'0');
        gen_codes(buf, pending + 1, leaves, cb);
        buf.pop();
    }
    buf.push(b'1');
    gen_codes(buf, pending - 1, leaves - 1, cb);
    buf.pop();
}

/// Valid k-bit enumerator prefixes for a size-m tree, each with its continuation state
/// (pending, leaves-left) — the work-item partition of one side of a split. Codes that
/// complete before k bits are returned whole (pending 0).
fn gen_prefixes(m: usize, k: usize) -> Vec<(Vec<u8>, usize, usize)> {
    fn rec(buf: &mut Vec<u8>, pending: usize, leaves: usize, k: usize, out: &mut Vec<(Vec<u8>, usize, usize)>) {
        if pending == 0 {
            if leaves == 0 {
                out.push((buf.clone(), 0, 0));
            }
            return;
        }
        if buf.len() == k {
            out.push((buf.clone(), pending, leaves));
            return;
        }
        if leaves > pending {
            buf.push(b'0');
            rec(buf, pending + 1, leaves, k, out);
            buf.pop();
        }
        buf.push(b'1');
        rec(buf, pending - 1, leaves - 1, k, out);
        buf.pop();
    }
    let mut out = Vec::new();
    rec(&mut Vec::new(), 1, m, k, &mut out);
    out
}

/// decode_bits over a raw byte code (persistent arena build).
fn decode_code(arena: &mut Arena, code: &[u8]) -> u32 {
    let mut stack: Vec<u32> = Vec::new();
    for &b in code.iter().rev() {
        if b == b'1' {
            let l = arena.leaf(TAG_IOTA, 0);
            stack.push(l);
        } else {
            let f = stack.pop().unwrap();
            let x = stack.pop().unwrap();
            stack.push(arena.app(f, x));
        }
    }
    debug_assert_eq!(stack.len(), 1);
    stack[0]
}

/// One brute work item: (striped-side completions under `prefix`) × (every other-side
/// shape). `striped_f` says whether the striped side is the function of the top app.
struct BruteItem {
    n: usize,
    striped_f: bool,
    m_s: usize,
    m_o: usize,
    prefix: Vec<u8>,
    pending: usize,
    leaves: usize,
    est: u64,
}

/// Run one item: pre-decode the (smaller) other side once, stream the striped side,
/// test every top pair. PERSISTENT-arena builds only — head_trace_fpc s_clears scratch
/// internally, so a scratch-built term aliases the detector's own leaves and tests
/// garbage (the vacuous-first-brute lesson). The arena is rebuilt whenever it crosses
/// ~6M nodes (growth is one app node per pair plus the striped decodes).
fn brute_run_item(it: &BruteItem, budget: u64, bufs: &mut ReduceBufs, finds: &mut Vec<(u32, String, u64)>) -> u64 {
    let mut arena = Arena::new();
    let ol = 2 * it.m_o - 1;
    let mut ocodes: Vec<u8> = Vec::new();
    gen_codes(&mut Vec::new(), 1, it.m_o, &mut |c| ocodes.extend_from_slice(c));
    let ocount = ocodes.len() / ol;
    let mut oids: Vec<u32> = Vec::with_capacity(ocount);
    for c in ocodes.chunks_exact(ol) {
        oids.push(decode_code(&mut arena, c));
    }
    let mut tested = 0u64;
    let mut obuf = it.prefix.clone();
    let mut sbits: Vec<u8> = Vec::new();
    gen_codes(&mut obuf, it.pending, it.leaves, &mut |sb| {
        sbits.clear();
        sbits.extend_from_slice(sb);
        let mut sid = decode_code(&mut arena, &sbits);
        for oi in 0..ocount {
            if arena.p_nodes.len() > 6_000_000 {
                arena = Arena::new();
                oids.clear();
                for c in ocodes.chunks_exact(ol) {
                    oids.push(decode_code(&mut arena, c));
                }
                sid = decode_code(&mut arena, &sbits);
            }
            let (f, x) = if it.striped_f { (sid, oids[oi]) } else { (oids[oi], sid) };
            let t = arena.app(f, x);
            tested += 1;
            if let Some(cs) = head_trace_fpc(&mut arena, t, budget, bufs) {
                let oc = &ocodes[oi * ol..(oi + 1) * ol];
                let (fb, xb) = if it.striped_f { (&sbits[..], oc) } else { (oc, &sbits[..]) };
                let bits = format!("0{}{}", std::str::from_utf8(fb).unwrap(), std::str::from_utf8(xb).unwrap());
                finds.push((it.n as u32, bits, cs));
            }
        }
    });
    tested
}

fn main() {
    let t_start = Instant::now();
    let mut max_iotas: usize = 13;
    let mut steps_cap: u64 = 2_000;
    let mut nodes_cap: usize = 20_000;
    let mut out_path = String::from("spec/minimal-forms.json");
    let mut prefilter = false; // 1-var necessary-condition pass; skips full sigs for bird-irrelevant terms (partial census!)
    let mut dp = false; // semantic-class DP: compose behavior-class representatives instead of raw Catalan shapes
    let mut dp_arity: usize = 8; // signature-vector arity for --dp (validated identical to 12 at brute-17 AND 25/32; must stay < SIG_MAX)
    let mut dp_probe: Option<String> = None; // diagnostic: trace why this bitcode's class was(n't) reached
    let mut dp_gate: usize = 10_000; // rep-count stop gate for --dp (guards runaway class growth)
    let mut worker_override: Option<usize> = None; // --workers N (default 16: leave cores for the system)
    let mut dp_fastest = true; // fewest-steps hunt per bird — always on in DP (branch-and-bound makes it ~free); --no-fastest to skip
    let mut dp_fixpoint = false; // --fixpoint: hunt fixpoint combinators among divergent candidates (head-cycle certificates)
    let mut dp_slim = false;
    let mut dp_checkpoint = false;
    let mut dp_snapshot = true; // layer-boundary state snapshots at depth (>=36): a marathon survives kills/reboots
    let mut resume_path: Option<String> = None;
    let mut fpc_sweep = false; // post-hoc Böhm sweep over a hunt-state's opaque reps
    let mut fpc_max: u16 = u16::MAX; // --fpc-max N: sweep only opaque reps of size <= N
    let mut fpc_brute: usize = 0;
    let mut fpc_from: usize = 1; // --fpc-from M: skip sizes < M (covered by a prior run) // --fpc-brute N: EXHAUSTIVE Böhm test of every shape <= N iotas (no DP, no pruning) // per-layer findings snapshots (marathon hunts keep every completed layer) // --dp-slim: skip class census + samples in the JSON (deep runs; the dump gets fat past ~50k classes)
    let mut dp_opaque_fn = false; // --dp-opaque-fn re-enables capped singletons as HEADS; default skips them (leftmost-outermost does the head's work first, so a capped head stays capped; the arg-side rescue is kept). Validated 0-mismatch vs brute at 17ι.
    let mut esc_mult: u64 = 100; // escalated-cap multiplier for frontier cap-outs (raise to chase down `conditional` statuses)
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--max-iotas" => max_iotas = args.next().unwrap().parse().unwrap(),
            "--steps" => steps_cap = args.next().unwrap().parse().unwrap(),
            "--nodes" => nodes_cap = args.next().unwrap().parse().unwrap(),
            "--out" => out_path = args.next().unwrap(),
            "--prefilter" => prefilter = true,
            "--esc-mult" => esc_mult = args.next().unwrap().parse().unwrap(),
            "--dp" => dp = true,
            "--dp-arity" => dp_arity = args.next().unwrap().parse().unwrap(),
            "--dp-probe" => dp_probe = Some(args.next().unwrap()),
            "--dp-gate" => dp_gate = args.next().unwrap().parse().unwrap(),
            "--workers" => worker_override = Some(args.next().unwrap().parse().unwrap()),
            "--dp-no-opaque-fn" => dp_opaque_fn = false, // legacy alias (now the default)
            "--dp-opaque-fn" => dp_opaque_fn = true,
            "--dp-slim" => dp_slim = true,
            "--fixpoint" => dp_fixpoint = true,
            "--fpc-probe" => { let bits = args.next().unwrap(); let budget: u64 = std::env::var("FPC_BUDGET").ok().and_then(|v| v.parse().ok()).unwrap_or(2000); let mut arena = Arena::new(); let mut bufs = ReduceBufs::default(); let t = decode_bits(&mut arena, &bits).expect("bad bits"); match head_trace_fpc(&mut arena, t, budget, &mut bufs) { Some(n) => println!("candidate: f^5 at {n} head steps, still f-headed at budget {budget}"), None => println!("rejected within budget {budget} (floor or too slow)") } return; }
            "--fastest" => dp_fastest = true, // default; kept for compat
            "--no-fastest" => dp_fastest = false,
            "--checkpoint" => dp_checkpoint = true,
            "--no-checkpoint" => dp_checkpoint = false,
            "--resume" => resume_path = Some(args.next().unwrap()),
            "--fpc-sweep" => { resume_path = Some(args.next().unwrap()); fpc_sweep = true; dp = true; max_iotas = 1; }
            "--fpc-max" => fpc_max = args.next().unwrap().parse().unwrap(),
            "--fpc-brute" => { fpc_brute = args.next().unwrap().parse().unwrap(); }
            "--fpc-from" => { fpc_from = args.next().unwrap().parse().unwrap(); }
            "--no-snapshot" => dp_snapshot = false,
            "--hunt" | "--smallest" => {
                // THE hunt: smallest + fastest + fixpoint + per-layer checkpoints
                max_iotas = args.next().unwrap().parse().unwrap();
                dp = true;
                dp_arity = 8;
                dp_slim = true;
                dp_gate = 50_000_000;
                dp_fixpoint = true; // (the arm rewrite had dropped this — the 44-marathon ran without the Y hunt)
                dp_checkpoint = true;
            }
            other => panic!("unknown arg {other}"),
        }
    }
    if fpc_brute > 0 {
        // EXHAUSTIVE fixpoint census: stream every pure-ι shape of <= N leaves as a
        // preorder bitcode (no materialized shape table — sizes past ~19 cannot fit),
        // decode into a small persistent arena, Böhm-test each. This is the
        // completeness pass the DP sweep cannot give (delegate substitution has the
        // congruence hole for FPC parents). The certificate is BOUNDED and labeled so:
        // "no FPC <= N within FPC_BUDGET total head-steps / 500k scratch nodes".
        const FPC_BUDGET: u64 = 2000;
        const CHUNK: u128 = 4_000_000;
        // planted controls through the exact decode -> build -> detector path, both ways:
        // Curry's Y (54ι) must fire; the retracted "26ι FPC" — a 16-story impostor whose
        // t·f =β f^16 (O f) — must NOT (its floor is what v2's fixed depth never reached).
        const Y54: &str = "00010101011001010110001010101101101100010101011000101010110010101101010101101010110010101100010101011011011";
        const TOWER26: &str = "000101010101100101010101100101010101100101010110111";
        {
            let mut arena = Arena::new();
            let mut bufs = ReduceBufs::default();
            let y = decode_bits(&mut arena, Y54).expect("bad planted bits");
            let cs = head_trace_fpc(&mut arena, y, FPC_BUDGET, &mut bufs)
                .expect("planted Curry Y did not fire — detector integration broken");
            let tw = decode_bits(&mut arena, TOWER26).expect("bad planted bits");
            // vetting-scale budget: the tower floor (level 17) sits just past the census
            // budget — the census reports such terms as CANDIDATES; vetting rejects them
            assert!(
                head_trace_fpc(&mut arena, tw, 10_000, &mut bufs).is_none(),
                "planted 16-story tower fired at vetting budget — floor rejection broken"
            );
            println!("fpc-brute: controls pass (Y-54 fires, f^5 at {cs} head steps; the 26ι tower is rejected)");
        }
        let workers = worker_override.unwrap_or_else(|| std::thread::available_parallelism().map(|v| v.get()).unwrap_or(8).min(16));
        let n_max = fpc_brute;
        println!("fpc-brute: EXHAUSTIVE census <= {n_max}ι — Böhm f^5, budget {FPC_BUDGET} head-steps, {workers} workers, sizes {fpc_from}..={n_max}");
        flushout();
        let wt = ways_table(n_max);
        let found = std::sync::Mutex::new(Vec::<(u32, String, u64)>::new());
        let mut cum = 0u64;
        for n in fpc_from.max(1)..=n_max {
            let expected = catalan(n - 1);
            let t0 = std::time::Instant::now();
            if n == 1 {
                let mut arena = Arena::new();
                let mut bufs = ReduceBufs::default();
                let t = arena.leaf(TAG_IOTA, 0);
                assert!(head_trace_fpc(&mut arena, t, FPC_BUDGET, &mut bufs).is_none());
                cum += 1;
                println!("fpc-brute: size 1 EXHAUSTED — 1 shape — cumulative 1, FPCs <= 1ι: 0");
                continue;
            }
            let mut items: Vec<BruteItem> = Vec::new();
            for i in 1..n {
                let fc = catalan(i - 1);
                let xc = catalan(n - i - 1);
                let pairs = fc as u128 * xc as u128;
                let striped_f = fc >= xc;
                let (m_s, m_o) = if striped_f { (i, n - i) } else { (n - i, i) };
                if pairs <= CHUNK {
                    items.push(BruteItem { n, striped_f, m_s, m_o, prefix: Vec::new(), pending: 1, leaves: m_s, est: pairs as u64 });
                } else {
                    let mut k = 1usize;
                    while (pairs / CHUNK) >> k > 0 {
                        k += 1;
                    }
                    let k = k.min(2 * m_s - 1).min(24);
                    let oc = if striped_f { xc } else { fc };
                    for (prefix, pending, leaves) in gen_prefixes(m_s, k) {
                        let est = wt[leaves][pending].saturating_mul(oc);
                        items.push(BruteItem { n, striped_f, m_s, m_o, prefix, pending, leaves, est });
                    }
                }
            }
            items.sort_by(|a, b| b.est.cmp(&a.est));
            let items = &items;
            let cursor = std::sync::atomic::AtomicUsize::new(0);
            let done_items = std::sync::atomic::AtomicUsize::new(0);
            let size_tested = std::sync::atomic::AtomicU64::new(0);
            std::thread::scope(|sc| {
                for _ in 0..workers {
                    sc.spawn(|| {
                        let mut bufs = ReduceBufs::default();
                        let mut lf: Vec<(u32, String, u64)> = Vec::new();
                        loop {
                            let w = cursor.fetch_add(1, Ordering::Relaxed);
                            if w >= items.len() {
                                break;
                            }
                            let t = brute_run_item(&items[w], FPC_BUDGET, &mut bufs, &mut lf);
                            size_tested.fetch_add(t, Ordering::Relaxed);
                            done_items.fetch_add(1, Ordering::Relaxed);
                        }
                        if !lf.is_empty() {
                            found.lock().unwrap().append(&mut lf);
                        }
                    });
                }
                if expected >= 200_000_000 {
                    let mut next_print = 60u64;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        if done_items.load(Ordering::Relaxed) >= items.len() {
                            break;
                        }
                        let el = t0.elapsed().as_secs();
                        if el >= next_print {
                            next_print = el + 60;
                            let ts = size_tested.load(Ordering::Relaxed);
                            let rate = ts as f64 / t0.elapsed().as_secs_f64();
                            let eta_h = if rate > 0.0 { expected.saturating_sub(ts) as f64 / rate / 3600.0 } else { f64::NAN };
                            println!(
                                "  … size {n}: {:.1}% ({:.3e}/{:.3e}) {:.2}M shapes/s, ETA {:.2}h, FPCs so far {}",
                                100.0 * ts as f64 / expected as f64, ts as f64, expected as f64, rate / 1e6, eta_h,
                                found.lock().unwrap().len()
                            );
                            flushout();
                        }
                    }
                }
            });
            let st = size_tested.load(Ordering::Relaxed);
            assert_eq!(st, expected, "size {n}: enumerated count != Catalan — completeness bug");
            cum += st;
            let mut all = found.lock().unwrap().clone();
            all.sort();
            let mut outb = String::new();
            for (sz, bits, cs) in &all {
                outb.push_str(&format!("{sz}|{cs}|{bits}\n"));
            }
            std::fs::write(&out_path, &outb).expect("write");
            let el = t0.elapsed().as_secs_f64();
            println!(
                "fpc-brute: size {n} EXHAUSTED — {st} shapes in {:.1}s ({:.2}M/s) — cumulative {cum}, FPCs <= {n}ι: {}",
                el, st as f64 / el / 1e6, all.len()
            );
            flushout();
        }
        let all = found.lock().unwrap();
        println!("fpc-brute: DONE <= {n_max}ι — {cum} shapes, {} FPCs (budget {FPC_BUDGET} head-steps)", all.len());
        for (sz, bits, cs) in all.iter().take(10) {
            println!("  FPC {sz}ι (closes {cs}): {bits}");
        }
        return;
    }
    let caps = Caps { steps: steps_cap, nodes: nodes_cap };
    let esc_caps = Caps { steps: steps_cap * esc_mult, nodes: nodes_cap.saturating_mul(esc_mult as usize) };

    let mut arena = Arena::new();
    let mut bufs = ReduceBufs::default();

    // -- birds (persistent) --
    let birds: Vec<Bird> = include_str!("birds.txt")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut it = l.split('|');
            Bird {
                sym: it.next().unwrap().to_string(),
                arity: it.next().unwrap().parse().unwrap(),
                bits: it.next().unwrap().to_string(),
                seed_steps: it.next().and_then(|v| v.parse().ok()),
            }
        })
        .collect();
    let bird_terms: Vec<u32> = birds
        .iter()
        .map(|b| decode_bits(&mut arena, &b.bits).expect("bad bird bitcode"))
        .collect();
    // ================= semantic-class DP mode (--dp, validated accelerator) =================
    // Compose behavior-class REPRESENTATIVES instead of raw Catalan shapes: class id = the
    // signature vector at arities 0..=dp_arity; size-n candidates are app(f, x) over reps
    // with minsize(f)+minsize(x) = n. Exchange argument: the min witness of any class
    // decomposes into components replaceable by their class-min reps (staying in-class BY
    // CONGRUENCE), so the DP reaches every class at its true min size — IF bounded-arity
    // equivalence acts as a congruence, which finite vectors cannot GUARANTEE (an argument
    // may be interrogated deeper than the vector sees). Soundness posture: bird matching
    // compares the vector SUFFIX from the bird's DECLARED arity up (equality at n implies
    // equality above, nothing below — full-key matching silently lost true minima); every
    // published equality is exactly TS-certified; and the whole mode is validated 0-mismatch
    // against brute ground truth at <=17 iota. Beyond that bound minimality claims are
    // "modulo bounded-arity congruence". meta.max_var_demand is a DIAGNOSTIC (it counts the
    // probe's own arity too, so it scales with dp_arity — not a certificate). Terms whose
    // own signatures cap compose as opaque SINGLETON reps (they may normalize inside larger
    // contexts) and remain frontier blockers for 'proven'.
    if dp {
        let dp_a: usize = dp_arity;
        assert!(dp_a < SIG_MAX, "--dp-arity must be < {SIG_MAX}");

        let fold_key = |v: &[(u64, u64)]| -> (u64, u64) {
            let (mut h1, mut h2) = (0xcbf29ce484222325u64, 0x9e3779b97f4a7c15u64);
            for &(a, b) in v {
                h1 = (h1 ^ a).wrapping_mul(0x100000001b3);
                h1 = (h1 ^ b).wrapping_mul(0x100000001b3);
                h2 = (h2 ^ b).rotate_left(13).wrapping_mul(0x100000001b3);
                h2 = (h2 ^ a).rotate_left(29).wrapping_mul(0x100000001b3);
            }
            (h1, h2)
        };
        // 8 bytes/rep (was ~24): term + u16 size + flag bits; the rare bird-relevant
        // vectors live in a side map keyed by rep index.
        #[derive(Clone, Copy, Default)]
        struct Rep {
            term: u32,
            size: u16,
            flags: u8, // bit0 = classed (resolved signature), bit1 = composable
        }
        impl Rep {
            #[inline]
            fn classed(&self) -> bool {
                self.flags & 1 != 0
            }
            #[inline]
            fn composable(&self) -> bool {
                self.flags & 2 != 0
            }
        }
        let mut classes_set = U128Set::with_capacity(dp_gate * 7 / 10); // key-only EXACT quotient (presized: ~58-70% of reps are classed; growth doubling would spike old+new)
        let mut reps: Vec<Rep> = Vec::new();
        let mut reps_by_size: Vec<Vec<u32>> = vec![Vec::new(); max_iotas + 1];
        // --fastest: bird sig vectors up front; classes whose vector SUFFIX (from the
        // bird's declared arity) matches a bird are "relevant" — every candidate landing
        // in one gets step-counted at that arity, tracking the running minimum.
        let bird_vecs: Vec<Option<SigVec>> = bird_terms
            .iter()
            .map(|&t| match dp_sigvec(&mut arena, t, &esc_caps, dp_a, &mut bufs) {
                SigRes::Full(v) => Some(v),
                SigRes::Capped(_) => None,
            })
            .collect();
        let mut relevant: FastMap<(u64, u64), u64> = FastMap::default(); // class key -> bird bitmask (<=52 birds)
        let mut best_fast: Vec<Option<(u64, u32, String)>> = vec![None; birds.len()];
        // per-bird smallest suffix-matching class, recorded AT INSERT (sizes ascend, so the
        // first hit IS the winner) — this deletes the multi-GB rep-vector side map entirely.
        let mut bird_min: Vec<Option<(u32, u32)>> = vec![None; birds.len()]; // (size, term)
        let mut mark_relevant = |v: &SigVec, key: (u64, u64), size: u32, term: u32, relevant: &mut FastMap<(u64, u64), u64>, bird_min: &mut Vec<Option<(u32, u32)>>| -> bool {
            let mut mask = 0u64;
            for (bi, bv) in bird_vecs.iter().enumerate() {
                if let Some(bv) = bv {
                    let a = birds[bi].arity;
                    if v.slice()[a..] == bv.slice()[a..] {
                        mask |= 1 << bi;
                        if bird_min[bi].is_none() {
                            bird_min[bi] = Some((size, term));
                        }
                    }
                }
            }
            if mask != 0 {
                relevant.insert(key, mask);
            }
            mask != 0
        };
        let iota_id = arena.leaf(TAG_IOTA, 0);
        let iv = match dp_sigvec(&mut arena, iota_id, &caps, dp_a, &mut bufs) {
            SigRes::Full(v) => v,
            SigRes::Capped(_) => panic!("iota signature capped"),
        };
        let ikey = fold_key(iv.slice());
        mark_relevant(&iv, ikey, 1, iota_id, &mut relevant, &mut bird_min);
        classes_set.insert(ikey);
        reps.push(Rep { term: iota_id, size: 1, flags: 3 });
        reps_by_size[1].push(0u32);
        let mut pair_count: u64 = 0;
        let mut fpc_finds: Vec<(u32, String, u64)> = Vec::new(); // (iotas, bits, close-steps)
        let mut capped_count: usize = 0;
        let mut opaque_seen = U128Set::new();

        let mut gate_tripped = false;
        let workers = worker_override.unwrap_or_else(|| std::thread::available_parallelism().map(|v| v.get()).unwrap_or(8).min(16));
        let mut esc_memo: FastMap<(u32, u8), Option<(u64, u64)>> = FastMap::default();
        let tier1 = Caps { steps: steps_cap.saturating_mul(10), nodes: nodes_cap.saturating_mul(10) };
        // findings emitter — reusable for per-layer CHECKPOINTS (the lazy endgame makes
        // this cost seconds, so a marathon hunt can die at any wall and keep every
        // completed layer's certified-shape results). esc_memo persists across calls.
        macro_rules! emit_findings {
            ($completed:expr, $path:expr) => {{
                let completed_iotas: usize = $completed;
                let out_file: &str = $path;
                let mut opaque_by_size: Vec<Vec<u32>> = vec![Vec::new(); max_iotas + 1];
                for (ri, r) in reps.iter().enumerate() {
                    if !r.classed() {
                        opaque_by_size[r.size as usize].push(ri as u32);
                    }
                }
                let _ = &opaque_by_size;
        let mut findings: Vec<String> = Vec::new();
        let esc_caps_steps = esc_caps.steps;
        let _ = esc_caps_steps;
        let mut coin_groups: FastMap<(u64, u64), Vec<usize>> = FastMap::default();
        let mut proven = 0usize;
        let mut conditional = 0usize;
        let mut improved = 0usize;
        for (bi, b) in birds.iter().enumerate() {
            let term = bird_terms[bi];
            let current_iotas = iota_count(&arena, term);
            let mut minimal_bits: Option<String> = None;
            let mut minimal_iotas: Option<u32> = None;
            let mut minimal_nf: Option<String> = None;
            let mut status = "bird-capped".to_string();
            let mut unresolved = 0u64;
            if let SigRes::Full(bv) = dp_sigvec(&mut arena, term, &esc_caps, dp_a, &mut bufs) {
                let bkey = fold_key(bv.slice());
                coin_groups.entry(bkey).or_default().push(bi);
                status = "not-found-within-bound".into();
                let _ = &bkey;
                let bslice = bv.slice();
                // Equality for a bird lives at arities >= its DECLARED arity (equal at n
                // implies equal above, says NOTHING below) — so match the sig-vector
                // SUFFIX. Multiple classes can match (they differ only below declared
                // arity); the winner is the smallest (size, bits) rep among them.
                let best: Option<(u32, String, u32)> = bird_min[bi].map(|(sz, t)| (sz, encode_bits(&arena, t), t));
                if let Some((bsize, bbits, bterm)) = best {
                    // exact string verification at arities declared..=dp_a (collision guard)
                    let mut exact = true;
                    for k in b.arity..=dp_a {
                        let a = nf_string(&mut arena, bterm, k, &esc_caps, &mut bufs);
                        let c = nf_string(&mut arena, term, k, &esc_caps, &mut bufs);
                        if a.is_none() || a != c {
                            exact = false;
                            break;
                        }
                    }
                    if exact {
                        // LAZY frontier walk, ascending size: stop at the first unresolved
                        // diverger (status is decided) or adopt a smaller capped-equal winner.
                        let target = signature_vars(&mut arena, term, b.arity, &esc_caps, true, &mut bufs);
                        let mut winner: (u32, String, u32) = (bsize, bbits, bterm);
                        'walk: for sz in 1..=winner.0 as usize {
                            for &ci in &opaque_by_size[sz] {
                                let cterm = reps[ci as usize].term;
                                let csize = sz as u32;
                                if csize == winner.0 {
                                    let cbits = encode_bits(&arena, cterm);
                                    if cbits >= winner.1 {
                                        continue;
                                    }
                                }
                                let key = (cterm, b.arity as u8);
                                let r = if let Some(v) = esc_memo.get(&key) {
                                    *v
                                } else {
                                    let v = signature_vars(&mut arena, cterm, b.arity, &tier1, true, &mut bufs)
                                        .or_else(|| signature_vars(&mut arena, cterm, b.arity, &esc_caps, true, &mut bufs));
                                    esc_memo.insert(key, v);
                                    v
                                };
                                match (r, target) {
                                    (Some(sg), Some(t2)) if sg == t2 => {
                                        winner = (csize, encode_bits(&arena, cterm), cterm);
                                        break 'walk; // ascending: this is the smallest possible
                                    }
                                    (Some(_), _) => {}
                                    (None, _) => {
                                        unresolved += 1;
                                        break 'walk; // conditional is decided; the count is cosmetic
                                    }
                                }
                            }
                        }
                        minimal_bits = Some(winner.1.clone());
                        minimal_iotas = Some(winner.0);
                        minimal_nf = nf_string(&mut arena, winner.2, b.arity, &esc_caps, &mut bufs);
                        status = if unresolved == 0 { "proven".into() } else { "conditional".into() };
                        if unresolved == 0 {
                            proven += 1;
                        } else {
                            conditional += 1;
                        }
                        if winner.0 < current_iotas {
                            improved += 1;
                        }
                    } else {
                        status = "collision-rejected".into();
                    }
                }
            }
            // --fastest extras: steps of current/minimal encodings + the fewest-steps member
            let fast_json = if dp_fastest {
                let cur_steps = direct_steps(&mut arena, term, None, b.arity, &esc_caps, &mut bufs);
                let min_steps = minimal_bits
                    .as_ref()
                    .and_then(|bits| decode_bits(&mut arena, bits))
                    .and_then(|t2| direct_steps(&mut arena, t2, None, b.arity, &esc_caps, &mut bufs));
                let (fb, fs) = match &best_fast[bi] {
                    Some((st, _, bits)) => (jstr(bits), st.to_string()),
                    None => ("null".to_string(), "null".to_string()),
                };
                format!(
                    ", \"current_steps\": {}, \"minimal_steps\": {}, \"fastest_bits\": {}, \"fastest_steps\": {}",
                    cur_steps.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
                    min_steps.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
                    fb,
                    fs
                )
            } else {
                String::new()
            };
            findings.push(format!(
                "    {{ \"sym\": {}, \"arity\": {}, \"current_bits\": {}, \"current_iotas\": {}, \"minimal_bits\": {}, \"minimal_iotas\": {}, \"minimal_nf\": {}, \"status\": {}, \"class_size\": 0, \"unresolved_before_winner\": {}{fast_json} }}",
                jstr(&b.sym),
                b.arity,
                jstr(&b.bits),
                current_iotas,
                minimal_bits.as_ref().map(|v| jstr(v)).unwrap_or_else(|| "null".into()),
                minimal_iotas.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
                minimal_nf.as_ref().map(|v| jstr(v)).unwrap_or_else(|| "null".into()),
                jstr(&status),
                unresolved,
            ));
        }
        // coincidences: birds sharing a full sig-vector key
        let mut coincidences: Vec<(Vec<String>, String)> = Vec::new();
        for (_k, idxs) in &coin_groups {
            if idxs.len() >= 2 {
                let syms: Vec<String> = idxs.iter().map(|&i| birds[i].sym.clone()).collect();
                let nf = nf_string(&mut arena, bird_terms[idxs[0]], 5, &esc_caps, &mut bufs).unwrap_or_else(|| "<capped>".into());
                coincidences.push((syms, nf));
            }
        }
        coincidences.sort();
        // classes census (per-size new-class counts) + parity samples from classed reps
        let mut census: Vec<(usize, usize)> = Vec::new();
        // deep runs (--dp-slim): census/samples add little and the dump gets huge
        for n in 1..=(if dp_slim { 0 } else { completed_iotas }) {
            let newc = reps_by_size[n].iter().filter(|&&ri| reps[ri as usize].classed()).count();
            if newc > 0 {
                census.push((n, newc));
            }
        }
        let mut samples: Vec<(String, String)> = Vec::new();
        let sample_idx: Vec<usize> = if dp_slim { Vec::new() } else { (0..reps.len()).step_by(1 + reps.len() / 300).collect() };
        for ri in sample_idx {
            if !reps[ri].classed() {
                continue;
            }
            if let Some(nf) = nf_string(&mut arena, reps[ri].term, 5, &caps, &mut bufs) {
                samples.push((encode_bits(&arena, reps[ri].term), nf));
            }
        }
        let classed_total = classes_set.len;
        let mut j = String::from("{\n");
        j.push_str(&format!(
            "  \"meta\": {{ \"mode\": \"dp\", \"dp_arity\": {dp_a}, \"max_iotas\": {completed_iotas}, \"steps_cap\": {steps_cap}, \"nodes_cap\": {nodes_cap}, \"esc_mult\": {esc_mult}, \"total_terms\": {pair_count}, \"capped_terms\": {capped_count}, \"dp_classes\": {classed_total}, \"max_var_demand\": {}, \"gate_tripped\": {}, \"persistent_nodes\": {} }},\n",
            arena.max_var_demand,
            gate_tripped,
            arena.p_nodes.len(),
        ));
        j.push_str("  \"birds\": [\n");
        j.push_str(&findings.join(",\n"));
        j.push_str("\n  ],\n  \"coincidences\": [\n");
        for (i, (syms, nf)) in coincidences.iter().enumerate() {
            let syms_j: Vec<String> = syms.iter().map(|s| jstr(s)).collect();
            j.push_str(&format!(
                "    {{ \"syms\": [{}], \"nf\": {} }}{}\n",
                syms_j.join(", "),
                jstr(nf),
                if i + 1 < coincidences.len() { "," } else { "" }
            ));
        }
        j.push_str("  ],\n  \"classes\": [\n");
        let class_rows: Vec<String> = census
            .iter()
            .map(|(n, c)| format!("    {{ \"min_iotas\": {n}, \"count\": {c}, \"min_bits\": \"\", \"nf\": \"(new classes first reached at this size)\", \"birds\": [] }}"))
            .collect();
        j.push_str(&class_rows.join(",\n"));
        j.push_str("\n  ],\n  \"samples\": [\n");
        for (i, (bits, nf)) in samples.iter().enumerate() {
            j.push_str(&format!(
                "    {{ \"bits\": {}, \"nf\": {} }}{}\n",
                jstr(bits),
                jstr(nf),
                if i + 1 < samples.len() { "," } else { "" }
            ));
        }
        j.push_str("  ]\n}\n");
                std::fs::write(out_file, &j).expect("write output");
            }};
        }
        macro_rules! snap_state {
            ($completed:expr, $path:expr) => {{
                // write-temp-then-rename: a kill during the ~40s stream must never
                // leave a truncated snapshot at the real path
                let tmp_path = format!("{}.tmp", $path);
                let (mut zc, mut f) = zstd_writer(&tmp_path);
                w_u64(&mut f, 0x1074_5747_0002); // magic + FORMAT version (v2: zstd + keys-only sets)
                w_slice(&mut f, env!("CARGO_PKG_VERSION").as_bytes()); // creating binary's version
                w_u64(&mut f, birds_hash());
                w_u64(&mut f, $completed as u64);
                w_u64(&mut f, pair_count);
                w_u64(&mut f, capped_count as u64);
                w_u64(&mut f, arena.max_var_demand as u64);
                w_slice(&mut f, &arena.p_nodes);
                let leaf_pairs: Vec<(u64, u32)> = arena.p_dedup.iter().map(|(k, v)| (*k, *v)).collect();
                w_slice(&mut f, &leaf_pairs);
                w_slice(&mut f, &reps);
                w_u64(&mut f, reps_by_size.len() as u64);
                for v in &reps_by_size {
                    w_slice(&mut f, v);
                }
                // sets: keys only (slots are ~30% zeros and the table rebuilds on load —
                // 4x smaller before compression on the biggest component)
                for set in [&classes_set, &opaque_seen] {
                    w_u64(&mut f, set.len as u64);
                    for &k in &set.slots {
                        if k != 0 {
                            w_slice(&mut f, &[k]);
                        }
                    }
                }
                let rel_triples: Vec<(u64, u64, u64)> = relevant.iter().map(|(k, v)| (k.0, k.1, *v)).collect();
                w_slice(&mut f, &rel_triples);
                let bm: Vec<(u32, u32, u32)> = bird_min.iter().map(|o| match o { Some((s2, t)) => (1, *s2, *t), None => (0, 0, 0) }).collect();
                w_slice(&mut f, &bm);
                // best_fast + fpc carry strings — encode via bits length + bytes
                w_u64(&mut f, best_fast.len() as u64);
                for e in &best_fast {
                    match e {
                        Some((st, sz, bits)) => {
                            w_u64(&mut f, 1);
                            w_u64(&mut f, *st);
                            w_u64(&mut f, *sz as u64);
                            w_slice(&mut f, bits.as_bytes());
                        }
                        None => w_u64(&mut f, 0),
                    }
                }
                w_u64(&mut f, fpc_finds.len() as u64);
                for (sz, bits, cs) in &fpc_finds {
                    w_u64(&mut f, *sz as u64);
                    w_u64(&mut f, *cs);
                    w_slice(&mut f, bits.as_bytes());
                }
                drop(f);
                let st = zc.wait().expect("zstd write failed");
                assert!(st.success(), "zstd exited nonzero writing the snapshot");
                std::fs::rename(&tmp_path, $path).expect("snapshot rename");
            }};
        }
        let mut start_n = 2usize;
        if let Some(rp) = &resume_path {
            let (mut zc, mut f) = zstd_reader(rp);
            assert_eq!(r_u64(&mut f), 0x1074_5747_0002, "hunt-state FORMAT version mismatch (this binary reads v2: zstd + keys-only sets)");
            let creator: Vec<u8> = r_vec(&mut f);
            eprintln!("hunt-state created by minimal-forms v{}", String::from_utf8_lossy(&creator));
            assert_eq!(r_u64(&mut f), birds_hash(), "snapshot was made against a different birds.txt");
            let completed = r_u64(&mut f) as usize;
            pair_count = r_u64(&mut f);
            capped_count = r_u64(&mut f) as usize;
            arena.max_var_demand = r_u64(&mut f) as usize;
            arena.p_nodes = r_vec(&mut f);
            let leaf_pairs: Vec<(u64, u32)> = r_vec(&mut f);
            arena.p_dedup = leaf_pairs.into_iter().collect();
            reps = r_vec(&mut f);
            let nrbs = r_u64(&mut f) as usize;
            reps_by_size = (0..nrbs).map(|_| r_vec::<u32, _>(&mut f)).collect();
            if reps_by_size.len() < max_iotas + 1 {
                reps_by_size.resize(max_iotas + 1, Vec::new());
            }
            for set in [&mut classes_set, &mut opaque_seen] {
                let n = r_u64(&mut f) as usize;
                let mut fresh = U128Set::with_capacity(n.max(1));
                for _ in 0..n {
                    let k: Vec<u128> = r_vec(&mut f);
                    fresh.insert_raw(k[0]);
                }
                *set = fresh;
            }
            let rel: Vec<(u64, u64, u64)> = r_vec(&mut f);
            relevant = rel.into_iter().map(|(a, b, m)| ((a, b), m)).collect();
            let bm: Vec<(u32, u32, u32)> = r_vec(&mut f);
            bird_min = bm.into_iter().map(|(t, s2, tm)| if t == 1 { Some((s2, tm)) } else { None }).collect();
            let nbf = r_u64(&mut f) as usize;
            best_fast = (0..nbf).map(|_| {
                if r_u64(&mut f) == 1 {
                    let st = r_u64(&mut f);
                    let sz = r_u64(&mut f) as u32;
                    let bytes: Vec<u8> = r_vec(&mut f);
                    Some((st, sz, String::from_utf8(bytes).unwrap()))
                } else {
                    None
                }
            }).collect();
            let nfp = r_u64(&mut f) as usize;
            fpc_finds = (0..nfp).map(|_| {
                let sz = r_u64(&mut f) as u32;
                let cs = r_u64(&mut f);
                let bytes: Vec<u8> = r_vec(&mut f);
                (sz, String::from_utf8(bytes).unwrap(), cs)
            }).collect();
            start_n = completed + 1;
            zc.wait().ok();
            eprintln!("resumed from {rp}: {} reps, {} classes, continuing at size {start_n}", reps.len(), classes_set.len);
            if fpc_sweep {
                let opaque: Vec<u32> = reps.iter().filter(|r| !r.classed() && r.size <= fpc_max).map(|r| r.term).collect();
                eprintln!("fpc-sweep: Böhm-testing {} opaque reps on {workers} workers", opaque.len());
                let p_nodes: &[u64] = &arena.p_nodes;
                let p_dedup = &arena.p_dedup;
                let oref = &opaque;
                let nx = std::sync::atomic::AtomicUsize::new(0);
                let nx = &nx;
                let finds: Vec<Vec<(u32, u64)>> = std::thread::scope(|sc| {
                    (0..workers)
                        .map(|_| {
                            sc.spawn(move || {
                                let mut wk = Worker { p_nodes, p_dedup, s_nodes: Vec::new(), s_dedup: FastMap::default(), max_var_demand: 0, l_cache: [u32::MAX; 23] };
                                let mut wbufs = ReduceBufs::default();
                                let mut out = Vec::new();
                                loop {
                                    let i = nx.fetch_add(1, Ordering::Relaxed);
                                    if i >= oref.len() {
                                        break;
                                    }
                                    if let Some(cs) = head_trace_fpc(&mut wk, oref[i], 2000, &mut wbufs) {
                                        out.push((oref[i], cs));
                                    }
                                }
                                out
                            })
                        })
                        .collect::<Vec<_>>()
                        .into_iter()
                        .map(|h| h.join().unwrap())
                        .collect()
                });
                let mut all: Vec<(u32, String, u64)> = finds.into_iter().flatten().map(|(t, cs)| (iota_count(&arena, t), encode_bits(&arena, t), cs)).collect();
                all.sort();
                println!("fpc-sweep: {} fixpoint combinators found (Böhm prefix f^5)", all.len());
                let mut out = String::new();
                for (sz, bits, cs) in &all {
                    out.push_str(&format!("{sz}|{cs}|{bits}\n"));
                }
                std::fs::write(&out_path, out).expect("write fpc finds");
                for (sz, bits, cs) in all.iter().take(20) {
                    println!("  FPC {sz}ι (closes {cs} head steps): {bits}");
                }
                println!("full list → {out_path}");
                return;
            }
        }
        'sizes: for n in start_n..=max_iotas {
            // STREAMED windows (memory diet): candidates are generated by a resumable
            // cursor in exactly the old nested-loop order — the full layer is never
            // materialized (it alone was ~6GB at the size-42 layer).
            const WINDOW: usize = 8_000_000;
            let mut par_ms = 0u128;
            let mut merge_ms = 0u128;
            let mut layer_cands = 0u64;
            let mut win_buf: Vec<(u32, u32)> = Vec::with_capacity(WINDOW);
            let (mut st_i, mut st_fi, mut st_xi) = (1usize, 0usize, 0usize);
            'windows: loop {
                win_buf.clear();
                while st_i < n {
                    let j = n - st_i;
                    while st_fi < reps_by_size[st_i].len() {
                        let fr_idx = reps_by_size[st_i][st_fi] as usize;
                        let head_ok = { let fr = &reps[fr_idx]; fr.classed() || (dp_opaque_fn && fr.composable()) };
                        if !head_ok {
                            st_fi += 1;
                            st_xi = 0;
                            continue;
                        }
                        let f = reps[fr_idx].term;
                        while st_xi < reps_by_size[j].len() {
                            let xr_idx = reps_by_size[j][st_xi] as usize;
                            st_xi += 1;
                            if !reps[xr_idx].composable() {
                                continue;
                            }
                            win_buf.push((f, reps[xr_idx].term));
                            if win_buf.len() >= WINDOW {
                                break;
                            }
                        }
                        if win_buf.len() >= WINDOW {
                            break;
                        }
                        st_fi += 1;
                        st_xi = 0;
                    }
                    if win_buf.len() >= WINDOW {
                        break;
                    }
                    st_i += 1;
                    st_fi = 0;
                    st_xi = 0;
                }
                if win_buf.is_empty() {
                    break 'windows;
                }
                pair_count += win_buf.len() as u64;
                layer_cands += win_buf.len() as u64;
                let t_build = Instant::now();
                let win: &[(u32, u32)] = &win_buf;
            let mut results: Vec<Option<(SigRes, (u64, u64))>> = vec![None; win.len()];
            if win.len() < 128 {
                for (ci, &(f, x)) in win.iter().enumerate() {
                    let r = dp_sigvec_headarg(&mut arena, f, Some(x), &caps, dp_a, &mut bufs);
                    let k = match &r {
                        SigRes::Full(v) => fold_key(v.slice()),
                        SigRes::Capped(pfx) => fold_key(pfx.slice()),
                    };
                    results[ci] = Some((r, k));
                }
            } else {
                let p_nodes: &[u64] = &arena.p_nodes;
                let p_dedup = &arena.p_dedup;
                let cands_ref = win;
                let caps_ref = &caps;
                let next = std::sync::atomic::AtomicUsize::new(0);
                let next = &next;
                let done: Vec<(usize, Vec<(usize, SigRes, (u64, u64))>)> = std::thread::scope(|sc| {
                    (0..workers)
                        .map(|w| {
                            sc.spawn(move || {
                                let mut wk = Worker {
                                    p_nodes,
                                    p_dedup,
                                    s_nodes: Vec::new(),
                                    s_dedup: FastMap::default(),
                                    max_var_demand: 0,
                                    l_cache: [u32::MAX; 23],
                                };
                                let mut wbufs = ReduceBufs::default();
                                let mut out = Vec::new();
                                let t0 = Instant::now();
                                loop {
                                    let ci = next.fetch_add(1, Ordering::Relaxed);
                                    if ci >= cands_ref.len() {
                                        break;
                                    }
                                    let (f, x) = cands_ref[ci];
                                    let r = dp_sigvec_headarg(&mut wk, f, Some(x), caps_ref, dp_a, &mut wbufs);
                                    let k = match &r {
                                        SigRes::Full(v) => fold_key(v.slice()),
                                        SigRes::Capped(pfx) => fold_key(pfx.slice()),
                                    };
                                    out.push((ci, r, k));
                                }
                                eprintln!("    worker {w}: {} cands in {}ms", out.len(), t0.elapsed().as_millis());
                                (wk.max_var_demand, out)
                            })
                        })
                        .collect::<Vec<_>>()
                        .into_iter()
                        .enumerate()
                        .map(|(i, h)| {
                            let (d, out) = h.join().expect("worker panicked");
                            let _ = i;
                            (d, out)
                        })
                        .collect()
                });
                for (d, out) in done {
                    if d > arena.max_var_demand {
                        arena.max_var_demand = d;
                    }
                    for (ci, r, k) in out {
                        results[ci] = Some((r, k));
                    }
                }
            }
            par_ms += t_build.elapsed().as_millis();
            let t_merge0 = Instant::now();
            // Phase 3 (serial, in candidate order): class/rep insertion + gate.
            for (ci, res) in results.into_iter().enumerate() {
                let (cf, cx) = win[ci];
                let (res, key) = res.expect("missing worker result");
                match res {
                    SigRes::Full(v) => {
                        if classes_set.insert(key) {
                            let t = arena.app(cf, cx); // interned ONLY for winners
                            mark_relevant(&v, key, n as u32, t, &mut relevant, &mut bird_min);
                            reps_by_size[n].push(reps.len() as u32);
                            reps.push(Rep { term: t, size: n as u16, flags: 3 });
                        }
                        if let Some(&mask) = relevant.get(&key) {
                            for bi in (0..birds.len() as u32).filter(|b| mask >> b & 1 == 1) {
                                let a = birds[bi as usize].arity;
                                // branch-and-bound: a reduction that hits the best-so-far step
                                // count is >= best — the cap doubles as the bail-out
                                let bound = Caps {
                                    steps: best_fast[bi as usize]
                                        .as_ref()
                                        .map(|(bs, _, _)| *bs)
                                        .or(birds[bi as usize].seed_steps) // seed from prior hunts: bail at the KNOWN minimum immediately
                                        .unwrap_or(esc_caps.steps)
                                        .min(esc_caps.steps),
                                    nodes: esc_caps.nodes,
                                };
                                if let Some(st) = direct_steps(&mut arena, cf, Some(cx), a, &bound, &mut bufs) {
                                    let better = match &best_fast[bi as usize] {
                                        None => true,
                                        Some((bs, bsz, _)) => st < *bs || (st == *bs && (n as u32) < *bsz),
                                    };
                                    if better {
                                        best_fast[bi as usize] = Some((st, n as u32, encode_bits_pair(&arena, cf, cx)));
                                    }
                                }
                            }
                        }
                    }
                    SigRes::Capped(_prefix) => {
                        let pkey = key;
                        if dp_fixpoint {
                            arena.s_clear();
                            let tt = { let f2 = cf; let x2 = cx; scratch_intern(&arena.p_dedup, &mut arena.s_nodes, &mut arena.s_dedup, TAG_APP, f2, x2) };
                            if let Some(cs) = head_trace_fpc(&mut arena, tt, 500, &mut bufs) {
                                fpc_finds.push((n as u32, encode_bits_pair(&arena, cf, cx), cs));
                            }
                        }
                        // opaque rep: always a frontier blocker; composes (arg side) only if
                        // its capped-prefix class is new — same-prefix divergers behave
                        // identically on every observable arity, so one delegate suffices
                        let fresh = opaque_seen.insert(pkey);
                        let t = arena.app(cf, cx); // blockers/delegates still need real terms
                        reps_by_size[n].push(reps.len() as u32);
                        reps.push(Rep { term: t, size: n as u16, flags: if fresh { 2 } else { 0 } });
                        capped_count += 1;
                    }
                }
                if reps.len() > dp_gate {
                    eprintln!("dp stop-gate: >{dp_gate} reps at size {n} — deeper sizes unexplored");
                    gate_tripped = true;
                    break 'sizes;
                }
            }
                merge_ms += t_merge0.elapsed().as_millis();
            }
            let newc = reps_by_size[n].iter().filter(|&&ri| reps[ri as usize].classed()).count();
            eprintln!(
                "  size {n}: {} cands → +{} classes, +{} opaque ({} total reps) · par {}ms merge {}ms",
                layer_cands,
                newc,
                reps_by_size[n].len() - newc,
                reps.len(),
                par_ms,
                merge_ms
            );
            if dp_checkpoint && n >= 13 && n < max_iotas {
                let cp = match out_path.rfind('.') {
                    Some(i) => format!("{}.le{n:02}{}", &out_path[..i], &out_path[i..]),
                    None => format!("{out_path}.le{n:02}"),
                };
                let t_cp = Instant::now();
                emit_findings!(n, &cp);
                eprintln!("  checkpoint ≤{n}ι → {cp} ({}ms)", t_cp.elapsed().as_millis());
                if dp_snapshot && n >= 36 {
                    let sp = format!("{out_path}.hunt-state");
                    let t_sn = Instant::now();
                    snap_state!(n, &sp);
                    eprintln!("  snapshot ≤{n}ι → {sp} ({}ms)", t_sn.elapsed().as_millis());
                }
            }
        }
        // diagnostic probe: decompose a known witness, check each subterm's class membership
        if let Some(bits) = &dp_probe {
            let t = decode_bits(&mut arena, bits).expect("bad probe bits");
            let tkey = match dp_sigvec(&mut arena, t, &caps, dp_a, &mut bufs) { SigRes::Full(v) => Some(fold_key(v.slice())), SigRes::Capped(_) => None };
            let _ = &tkey;
            eprintln!("probe {bits}: key={tkey:?}");
            let n = arena.node(t);
            if n.tag == TAG_APP {
                for (side, sub) in [("fn", n.a), ("arg", n.b)] {
                    let sbits = encode_bits(&arena, sub);
                    match dp_sigvec(&mut arena, sub, &caps, dp_a, &mut bufs) {
                        SigRes::Full(_) => eprintln!("  {side} {sbits}: resolves"),
                        SigRes::Capped(_) => eprintln!("  {side} {sbits}: sigvec CAPPED"),
                    }
                }
            }
        }
        // birds: match class by key, verify EXACTLY by NF strings at every arity (guards
        // against 128-bit key collisions for every published claim)
        // LAZY frontier (the massive win): statuses only need unresolved==0 vs >0, so each
        // bird walks its cheaper opaque frontier in ascending size and STOPS at the first
        // unresolved diverger (or adopts the first capped-that-escalates-equal as a smaller
        // winner). Total escalations collapse from ~all-opaque×arities to ~thousands.
        // On-demand escalated sigs memoized per (term, arity) — tiny now.

        emit_findings!(max_iotas, &out_path);

        if dp_fixpoint {
            fpc_finds.sort();
            eprintln!("fixpoint finds: {}", fpc_finds.len());
            for (sz, bits, cs) in fpc_finds.iter().take(10) {
                eprintln!("  FPC {sz}ι closes in {cs} head steps: {bits}");
            }
        }
        println!(
            "minimal-forms[dp]: {pair_count} pairs -> {} classes + {capped_count} capped reps <={max_iotas}iota · {} birds · {}ms -> {out_path}",
            classes_set.len,
            birds.len(),
            t_start.elapsed().as_millis()
        );
        return;
    }

    let bird_sig5: Vec<Option<(u64, u64)>> = bird_terms
        .iter()
        .map(|&t| signature(&mut arena, t, SIG_ARITY, &esc_caps, &mut bufs))
        .collect();
    let interesting: FastMap<(u64, u64), Vec<usize>> = {
        let mut m: FastMap<(u64, u64), Vec<usize>> = FastMap::default();
        for (i, s) in bird_sig5.iter().enumerate() {
            if let Some(sig) = s {
                m.entry(*sig).or_default().push(i);
            }
        }
        m
    };
    // 1-var prefilter targets: birds' repeated-variable signatures (a NECESSARY condition
    // for equality — identifying variables is a homomorphic coarsening). Sound only if every
    // bird's 1-var signature resolved; otherwise a bird's matches could be skipped.
    let bird_sig1: Option<FastMap<(u64, u64), ()>> = if prefilter {
        let mut m: FastMap<(u64, u64), ()> = FastMap::default();
        let mut all_ok = true;
        for &t in &bird_terms {
            match signature_vars(&mut arena, t, SIG_ARITY, &esc_caps, false, &mut bufs) {
                Some(s) => {
                    m.insert(s, ());
                }
                None => all_ok = false,
            }
        }
        if all_ok {
            Some(m)
        } else {
            eprintln!("prefilter disabled: a bird's 1-var signature capped");
            None
        }
    } else {
        None
    };
    let t_birds = t_start.elapsed();

    // -- enumeration (persistent) --
    let mut terms_by_size: Vec<Vec<u32>> = vec![Vec::new(); max_iotas + 1];
    terms_by_size[1].push(arena.leaf(TAG_IOTA, 0));
    for n in 2..=max_iotas {
        let mut v = Vec::new();
        for i in 1..n {
            let j = n - i;
            for fi in 0..terms_by_size[i].len() {
                let f = terms_by_size[i][fi];
                for xi in 0..terms_by_size[j].len() {
                    let x = terms_by_size[j][xi];
                    v.push(arena.app(f, x));
                }
            }
        }
        terms_by_size[n] = v;
    }
    let total_terms: usize = terms_by_size.iter().map(|v| v.len()).sum();
    let t_enum = t_start.elapsed();

    // -- signatures + classes --
    struct Class {
        min_term: u32,
        min_size: u32,
        count: u64,
        members: Vec<u32>, // only for classes containing birds
    }
    let mut classes: FastMap<(u64, u64), Class> = FastMap::default();
    let mut capped_terms: Vec<u32> = Vec::new(); // arity-5 signature capped — unknowns
    let mut prefiltered_out: u64 = 0;
    for n in 1..=max_iotas {
        for idx in 0..terms_by_size[n].len() {
            let t = terms_by_size[n][idx];
            if let Some(targets) = &bird_sig1 {
                match signature_vars(&mut arena, t, SIG_ARITY, &caps, false, &mut bufs) {
                    None => {
                        capped_terms.push(t); // unknown — stays a frontier candidate
                        continue;
                    }
                    Some(s1) if !targets.contains_key(&s1) => {
                        prefiltered_out += 1; // provably ≠ every bird; census skipped (partial classes)
                        continue;
                    }
                    Some(_) => {}
                }
            }
            match signature(&mut arena, t, SIG_ARITY, &caps, &mut bufs) {
                None => capped_terms.push(t),
                Some(sig) => {
                    let track = interesting.contains_key(&sig);
                    let e = classes.entry(sig).or_insert(Class {
                        min_term: t,
                        min_size: n as u32,
                        count: 0,
                        members: Vec::new(),
                    });
                    e.count += 1;
                    if (n as u32) < e.min_size
                        || ((n as u32) == e.min_size
                            && encode_bits(&arena, t) < encode_bits(&arena, e.min_term))
                    {
                        e.min_size = n as u32;
                        e.min_term = t;
                    }
                    if track {
                        e.members.push(t);
                    }
                }
            }
        }
    }
    let capped_count = capped_terms.len();
    if prefilter { eprintln!("prefilter: {prefiltered_out} terms excluded by 1-var signature"); }
    let _ = prefiltered_out;
    let t_sigs = t_start.elapsed();

    // -- per-bird certification at declared arity over a merged, ordered frontier --
    #[derive(Clone)]
    struct Finding {
        sym: String,
        arity: usize,
        current_bits: String,
        current_iotas: u32,
        minimal_bits: Option<String>,
        minimal_iotas: Option<u32>,
        minimal_nf: Option<String>,
        status: String, // proven | conditional | not-found-within-bound | bird-capped
        class_size: u64,
        unresolved_before_winner: u64,
    }
    let mut findings: Vec<Finding> = Vec::new();
    // Escalated signatures are expensive (divergers burn the whole budget) and the frontier
    // consults the same capped terms for EVERY bird — memoize per (term, arity).
    let mut esc_sig: FastMap<(u32, u8), Option<(u64, u64)>> = FastMap::default();
    macro_rules! esc_sig_of {
        ($arena:expr, $t:expr, $arity:expr) => {{
            let key = ($t, $arity as u8);
            match esc_sig.get(&key) {
                Some(v) => *v,
                None => {
                    let v = signature($arena, $t, $arity, &esc_caps, &mut bufs);
                    esc_sig.insert(key, v);
                    v
                }
            }
        }};
    }
    for (bi, b) in birds.iter().enumerate() {
        let term = bird_terms[bi];
        let current_iotas = iota_count(&arena, term);
        let mut f = Finding {
            sym: b.sym.clone(),
            arity: b.arity,
            current_bits: b.bits.clone(),
            current_iotas,
            minimal_bits: None,
            minimal_iotas: None,
            minimal_nf: None,
            status: "bird-capped".into(),
            class_size: 0,
            unresolved_before_winner: 0,
        };
        // The certification target: the bird's signature at its DECLARED arity.
        let target = esc_sig_of!(&mut arena, term, b.arity);
        if let (Some(sig5), Some(target)) = (bird_sig5[bi], target) {
            f.status = "not-found-within-bound".into();
            // Merged frontier: arity-5 class members (candidates that provably match at 5)
            // + every capped term (unknown at 5, so possibly equal). Ascending (size, bits).
            let mut frontier: Vec<(u32, String, u32)> = Vec::new();
            if let Some(class) = classes.get(&sig5) {
                f.class_size = class.count;
                for &t in &class.members {
                    frontier.push((iota_count(&arena, t), encode_bits(&arena, t), t));
                }
            }
            for &t in &capped_terms {
                frontier.push((iota_count(&arena, t), encode_bits(&arena, t), t));
            }
            frontier.sort();
            let mut unresolved = 0u64;
            for (sz, bits, t) in frontier {
                match esc_sig_of!(&mut arena, t, b.arity) {
                    Some(s) if s == target => {
                        f.minimal_bits = Some(bits);
                        f.minimal_iotas = Some(sz);
                        f.minimal_nf = nf_string(&mut arena, t, b.arity, &esc_caps, &mut bufs);
                        f.status = if unresolved == 0 { "proven".into() } else { "conditional".into() };
                        f.unresolved_before_winner = unresolved;
                        break;
                    }
                    Some(_) => {}
                    None => unresolved += 1, // unknown even escalated — blocks 'proven'
                }
            }
            if f.minimal_bits.is_none() {
                f.unresolved_before_winner = unresolved;
            }
        }
        findings.push(f);
    }
    let t_cert = t_start.elapsed();

    // -- coincidences: classes with >= 2 birds (exemplar NF retained, not just a hash) --
    let mut coincidences: Vec<(Vec<String>, String)> = Vec::new();
    for (_sig, bird_idxs) in &interesting {
        if bird_idxs.len() >= 2 {
            let syms: Vec<String> = bird_idxs.iter().map(|&i| birds[i].sym.clone()).collect();
            let nf = nf_string(&mut arena, bird_terms[bird_idxs[0]], SIG_ARITY, &esc_caps, &mut bufs)
                .unwrap_or_else(|| "<capped>".into());
            coincidences.push((syms, nf));
        }
    }
    coincidences.sort();

    // -- class table: the equivalence classes themselves (smallest-first), for exploration.
    // Emits the top classes by (min size, descending population) with their canonical NF and
    // any catalog birds they contain — the hunting ground for new combinators.
    const CLASS_DUMP_LIMIT: usize = 600;
    let mut class_rows: Vec<(u32, u64, String, String, Vec<String>)> = Vec::new(); // (size, count, bits, nf, birds)
    {
        let mut order: Vec<(&(u64, u64), &Class)> = classes.iter().collect();
        order.sort_by(|a, b| (a.1.min_size, std::cmp::Reverse(a.1.count)).cmp(&(b.1.min_size, std::cmp::Reverse(b.1.count))));
        for (sig, c) in order.into_iter().take(CLASS_DUMP_LIMIT) {
            let bits = encode_bits(&arena, c.min_term);
            let nf = nf_string(&mut arena, c.min_term, SIG_ARITY, &esc_caps, &mut bufs).unwrap_or_else(|| "<capped>".into());
            let syms: Vec<String> = interesting
                .get(sig)
                .map(|idxs| idxs.iter().map(|&i| birds[i].sym.clone()).collect())
                .unwrap_or_default();
            class_rows.push((c.min_size, c.count, bits, nf, syms));
        }
    }

    // -- parity samples: deterministic pseudo-random (bitcode, arity-5 NF) pairs --
    let mut samples: Vec<(String, String)> = Vec::new();
    let mut rng: u64 = 0x243F6A8885A308D3;
    while samples.len() < 300 {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let n = 1 + (rng >> 33) as usize % max_iotas;
        if terms_by_size[n].is_empty() {
            continue;
        }
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let t = terms_by_size[n][(rng >> 33) as usize % terms_by_size[n].len()];
        if let Some(nf) = nf_string(&mut arena, t, SIG_ARITY, &caps, &mut bufs) {
            samples.push((encode_bits(&arena, t), nf));
        }
    }

    // -- JSON out (hand-rolled; jstr is top-level, shared with the DP path) --
    let mut j = String::from("{\n");
    // No timings in the committed artifact — they churn the diff on every regeneration.
    println!(
        "timings: birds {}ms · enumerate {}ms · signatures {}ms · certify {}ms",
        t_birds.as_millis(),
        (t_enum - t_birds).as_millis(),
        (t_sigs - t_enum).as_millis(),
        (t_cert - t_sigs).as_millis(),
    );
    j.push_str(&format!(
        "  \"meta\": {{ \"max_iotas\": {max_iotas}, \"steps_cap\": {steps_cap}, \"nodes_cap\": {nodes_cap}, \"esc_mult\": {esc_mult}, \"total_terms\": {total_terms}, \"capped_terms\": {capped_count}, \"persistent_nodes\": {} }},\n",
        arena.p_nodes.len(),
    ));
    j.push_str("  \"birds\": [\n");
    for (i, f) in findings.iter().enumerate() {
        j.push_str(&format!(
            "    {{ \"sym\": {}, \"arity\": {}, \"current_bits\": {}, \"current_iotas\": {}, \"minimal_bits\": {}, \"minimal_iotas\": {}, \"minimal_nf\": {}, \"status\": {}, \"class_size\": {}, \"unresolved_before_winner\": {} }}{}\n",
            jstr(&f.sym),
            f.arity,
            jstr(&f.current_bits),
            f.current_iotas,
            f.minimal_bits.as_ref().map(|b| jstr(b)).unwrap_or_else(|| "null".into()),
            f.minimal_iotas.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
            f.minimal_nf.as_ref().map(|b| jstr(b)).unwrap_or_else(|| "null".into()),
            jstr(&f.status),
            f.class_size,
            f.unresolved_before_winner,
            if i + 1 < findings.len() { "," } else { "" },
        ));
    }
    j.push_str("  ],\n  \"coincidences\": [\n");
    for (i, (syms, nf)) in coincidences.iter().enumerate() {
        let syms_j: Vec<String> = syms.iter().map(|s| jstr(s)).collect();
        j.push_str(&format!(
            "    {{ \"syms\": [{}], \"nf\": {} }}{}\n",
            syms_j.join(", "),
            jstr(nf),
            if i + 1 < coincidences.len() { "," } else { "" }
        ));
    }
    j.push_str("  ],\n  \"classes\": [\n");
    for (i, (size, count, bits, nf, syms)) in class_rows.iter().enumerate() {
        let syms_j: Vec<String> = syms.iter().map(|s| jstr(s)).collect();
        j.push_str(&format!(
            "    {{ \"min_iotas\": {}, \"count\": {}, \"min_bits\": {}, \"nf\": {}, \"birds\": [{}] }}{}\n",
            size,
            count,
            jstr(bits),
            jstr(nf),
            syms_j.join(", "),
            if i + 1 < class_rows.len() { "," } else { "" }
        ));
    }
    j.push_str("  ],\n  \"samples\": [\n");
    for (i, (bits, nf)) in samples.iter().enumerate() {
        j.push_str(&format!(
            "    {{ \"bits\": {}, \"nf\": {} }}{}\n",
            jstr(bits),
            jstr(nf),
            if i + 1 < samples.len() { "," } else { "" }
        ));
    }
    j.push_str("  ]\n}\n");
    std::fs::write(&out_path, &j).expect("write output");

    let proven = findings.iter().filter(|f| f.status == "proven").count();
    let conditional = findings.iter().filter(|f| f.status == "conditional").count();
    let improved = findings
        .iter()
        .filter(|f| f.minimal_iotas.map(|m| m < f.current_iotas).unwrap_or(false))
        .count();
    println!(
        "minimal-forms: {total_terms} terms ≤{max_iotas}ι ({capped_count} capped) · {} birds: {proven} proven, {conditional} conditional, {improved} improved · persistent {} nodes · {}ms total → {out_path}",
        birds.len(),
        arena.p_nodes.len(),
        t_start.elapsed().as_millis()
    );
}
