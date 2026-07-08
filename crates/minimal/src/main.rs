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

// ---------------- term arena: persistent (enumerated terms) + scratch (reduction) ----------------

const TAG_IOTA: u8 = 0;
const TAG_S: u8 = 1;
const TAG_K: u8 = 2;
const TAG_I: u8 = 3;
const TAG_FREE: u8 = 4; // a = var index
const TAG_APP: u8 = 5; // a = fn, b = arg

/// Ids ≥ SCRATCH_BASE live in the scratch arena (cleared per signature); below it,
/// the persistent arena. Both spaces stay under 2^29 so packed dedup keys fit 30 bits.
const SCRATCH_BASE: u32 = 1 << 29;

#[derive(Clone, Copy)]
struct Node {
    tag: u8,
    a: u32,
    b: u32,
}

struct Arena {
    /// Max spine length ever applied to a FREE-VAR head across the whole run.
    /// DIAGNOSTIC ONLY (it includes the probe's own arity, so it scales with the
    /// signature arity — it is not a congruence certificate).
    max_var_demand: usize,
    p_nodes: Vec<Node>,
    p_dedup: FastMap<u64, u32>,
    s_nodes: Vec<Node>,
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
    fn intern(&mut self, tag: u8, a: u32, b: u32) -> u32 {
        let key = ((tag as u64) << 60) | ((a as u64) << 30) | b as u64;
        if let Some(&id) = self.p_dedup.get(&key) {
            return id;
        }
        debug_assert!(a < SCRATCH_BASE && b < SCRATCH_BASE, "persistent node referencing scratch");
        let id = self.p_nodes.len() as u32;
        self.p_nodes.push(Node { tag, a, b });
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
            self.s_nodes[(id - SCRATCH_BASE) as usize]
        } else {
            self.p_nodes[id as usize]
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
fn scratch_intern(p_dedup: &FastMap<u64, u32>, s_nodes: &mut Vec<Node>, s_dedup: &mut FastMap<u64, u32>, tag: u8, a: u32, b: u32) -> u32 {
    let key = ((tag as u64) << 60) | ((a as u64) << 30) | b as u64;
    if a < SCRATCH_BASE && b < SCRATCH_BASE {
        if let Some(&id) = p_dedup.get(&key) {
            return id;
        }
    }
    if let Some(&id) = s_dedup.get(&key) {
        return id;
    }
    let id = SCRATCH_BASE + s_nodes.len() as u32;
    s_nodes.push(Node { tag, a, b });
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
        self.s_dedup.clear();
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
    p_nodes: &'a [Node],
    p_dedup: &'a FastMap<u64, u32>,
    s_nodes: Vec<Node>,
    s_dedup: FastMap<u64, u32>,
    max_var_demand: usize,
    l_cache: [u32; 23],
}

impl<'a> Red for Worker<'a> {
    fn nd(&self, id: u32) -> Node {
        if id >= SCRATCH_BASE {
            self.s_nodes[(id - SCRATCH_BASE) as usize]
        } else {
            self.p_nodes[id as usize]
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
        self.s_dedup.clear();
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
    Rebuild(u32, usize),
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
const SIG_MAX: usize = 13;
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
    let frames = &mut bufs.frames;
    let results = &mut bufs.results;
    let spine = &mut bufs.spine;
    frames.clear();
    results.clear();
    spine.clear();
    frames.push(Frame::Norm(root));

    while let Some(frame) = frames.pop() {
        match frame {
            Frame::Norm(mut t) => {
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
                frames.push(Frame::Rebuild(t, argc));
                for i in 0..argc {
                    frames.push(Frame::Norm(spine[i]));
                }
                spine.clear();
            }
            Frame::Rebuild(head, argc) => {
                // results[split..] = normalized args, FIRST arg first — apply in order.
                let split = results.len() - argc;
                let mut t = head;
                for i in split..results.len() {
                    let a = results[i];
                    t = arena.mk_app(t, a);
                }
                results.truncate(split);
                results.push(t);
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
}

/// Signature vector at arities 0..=dp_a — the DP's class identity. None if any arity caps.
/// INCREMENTAL by Church–Rosser: NF(t·v0..vk) = NF(NF(t·v0..v(k-1)) · vk), so each arity
/// pays only its marginal reduction instead of re-reducing the whole applied term (the
/// naive loop re-did ~13× the work). Scratch is cleared once per vector, not per arity —
/// the running NF lives there; each arity gets a fresh marginal step/node budget.
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

fn main() {
    let t_start = Instant::now();
    let mut max_iotas: usize = 13;
    let mut steps_cap: u64 = 2_000;
    let mut nodes_cap: usize = 20_000;
    let mut out_path = String::from("spec/minimal-forms.json");
    let mut prefilter = false; // 1-var necessary-condition pass; skips full sigs for bird-irrelevant terms (partial census!)
    let mut dp = false; // semantic-class DP: compose behavior-class representatives instead of raw Catalan shapes
    let mut dp_arity: usize = 12; // signature-vector arity for --dp (empirically tuned; validated against brute)
    let mut dp_probe: Option<String> = None; // diagnostic: trace why this bitcode's class was(n't) reached
    let mut dp_gate: usize = 10_000; // rep-count stop gate for --dp (guards runaway class growth)
    let mut dp_slim = false; // --dp-slim: skip class census + samples in the JSON (deep runs; the dump gets fat past ~50k classes)
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
            "--dp-no-opaque-fn" => dp_opaque_fn = false, // legacy alias (now the default)
            "--dp-opaque-fn" => dp_opaque_fn = true,
            "--dp-slim" => dp_slim = true,
            other => panic!("unknown arg {other}"),
        }
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
        struct Rep {
            term: u32,
            size: u32,
            vector: Option<SigVec>, // Some = classed; the sig vector at arities 0..=dp_a
            composable: bool,       // opaque reps: only the first of each capped-prefix class composes
        }
        let mut class_of: FastMap<(u64, u64), usize> = FastMap::default();
        let mut reps: Vec<Rep> = Vec::new();
        let mut reps_by_size: Vec<Vec<usize>> = vec![Vec::new(); max_iotas + 1];
        let iota_id = arena.leaf(TAG_IOTA, 0);
        let iv = match dp_sigvec(&mut arena, iota_id, &caps, dp_a, &mut bufs) {
            SigRes::Full(v) => v,
            SigRes::Capped(_) => panic!("iota signature capped"),
        };
        class_of.insert(fold_key(iv.slice()), 0);
        reps.push(Rep { term: iota_id, size: 1, vector: Some(iv), composable: true });
        reps_by_size[1].push(0);
        let mut pair_count: u64 = 0;
        let mut capped_count: usize = 0;
        let mut opaque_seen: FastMap<(u64, u64), ()> = FastMap::default();
        let mut gate_tripped = false;
        let workers = std::thread::available_parallelism().map(|v| v.get()).unwrap_or(8);
        'sizes: for n in 2..=max_iotas {
            // Phase 1 (serial, cheap): collect candidate (head, arg) PAIRS — no interning;
            // workers compose in scratch, and only merge-time winners touch the arena.
            let mut cands: Vec<(u32, u32)> = Vec::new();
            for i in 1..n {
                let j = n - i;
                for fi in 0..reps_by_size[i].len() {
                    let fr = &reps[reps_by_size[i][fi]];
                    if fr.vector.is_none() && (!dp_opaque_fn || !fr.composable) {
                        continue; // capped head: composition caps too (arg-side rescue still explored)
                    }
                    for xi in 0..reps_by_size[j].len() {
                        let xr = &reps[reps_by_size[j][xi]];
                        if !xr.composable {
                            continue; // duplicate capped-prefix opaque: blocker only
                        }
                        cands.push((reps[reps_by_size[i][fi]].term, xr.term));
                    }
                }
            }
            pair_count += cands.len() as u64;
            let t_build = Instant::now();
            // Phase 2 (parallel): signature vectors — persistent arena is immutable here, each
            // worker owns its scratch. Stride assignment balances the cost gradient across
            // candidates; results land at their candidate index, so the merge is deterministic.
            let mut results: Vec<Option<SigRes>> = vec![None; cands.len()];
            if cands.len() < 128 {
                for (ci, &(f, x)) in cands.iter().enumerate() {
                    results[ci] = Some(dp_sigvec_headarg(&mut arena, f, Some(x), &caps, dp_a, &mut bufs));
                }
            } else {
                let p_nodes: &[Node] = &arena.p_nodes;
                let p_dedup = &arena.p_dedup;
                let cands_ref = &cands;
                let caps_ref = &caps;
                let next = std::sync::atomic::AtomicUsize::new(0);
                let next = &next;
                let done: Vec<(usize, Vec<(usize, SigRes)>)> = std::thread::scope(|sc| {
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
                                    out.push((ci, dp_sigvec_headarg(&mut wk, f, Some(x), caps_ref, dp_a, &mut wbufs)));
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
                    for (ci, r) in out {
                        results[ci] = Some(r);
                    }
                }
            }
            let t_par = t_build.elapsed();
            let t_merge0 = Instant::now();
            // Phase 3 (serial, in candidate order): class/rep insertion + gate.
            for (ci, res) in results.into_iter().enumerate() {
                let (cf, cx) = cands[ci];
                match res.expect("missing worker result") {
                    SigRes::Full(v) => {
                        let key = fold_key(v.slice());
                        if !class_of.contains_key(&key) {
                            let t = arena.app(cf, cx); // interned ONLY for winners
                            class_of.insert(key, reps.len());
                            reps_by_size[n].push(reps.len());
                            reps.push(Rep { term: t, size: n as u32, vector: Some(v), composable: true });
                        }
                    }
                    SigRes::Capped(prefix) => {
                        // opaque rep: always a frontier blocker; composes (arg side) only if
                        // its capped-prefix class is new — same-prefix divergers behave
                        // identically on every observable arity, so one delegate suffices
                        let pkey = fold_key(prefix.slice());
                        let fresh = !opaque_seen.contains_key(&pkey);
                        if fresh {
                            opaque_seen.insert(pkey, ());
                        }
                        let t = arena.app(cf, cx); // blockers/delegates still need real terms
                        reps_by_size[n].push(reps.len());
                        reps.push(Rep { term: t, size: n as u32, vector: None, composable: fresh });
                        capped_count += 1;
                    }
                }
                if reps.len() > dp_gate {
                    eprintln!("dp stop-gate: >{dp_gate} reps at size {n} — deeper sizes unexplored");
                    gate_tripped = true;
                    break 'sizes;
                }
            }
            let newc = reps_by_size[n].iter().filter(|&&ri| reps[ri].vector.is_some()).count();
            eprintln!(
                "  size {n}: {} cands → +{} classes, +{} opaque ({} total reps) · par {}ms merge {}ms",
                cands.len(),
                newc,
                reps_by_size[n].len() - newc,
                reps.len(),
                t_par.as_millis(),
                t_merge0.elapsed().as_millis()
            );
        }
        // diagnostic probe: decompose a known witness, check each subterm's class membership
        if let Some(bits) = &dp_probe {
            let t = decode_bits(&mut arena, bits).expect("bad probe bits");
            let tkey = match dp_sigvec(&mut arena, t, &caps, dp_a, &mut bufs) { SigRes::Full(v) => Some(fold_key(v.slice())), SigRes::Capped(_) => None };
            eprintln!("probe {bits}: key={tkey:?} in_classes={}", tkey.map(|k| class_of.contains_key(&k)).unwrap_or(false));
            let n = arena.node(t);
            if n.tag == TAG_APP {
                for (side, sub) in [("fn", n.a), ("arg", n.b)] {
                    let sbits = encode_bits(&arena, sub);
                    match dp_sigvec(&mut arena, sub, &caps, dp_a, &mut bufs) {
                        SigRes::Full(v) => {
                            let k = fold_key(v.slice());
                            match class_of.get(&k) {
                                Some(&ri) => {
                                    let rb = encode_bits(&arena, reps[ri].term);
                                    eprintln!("  {side} {sbits}: class rep={rb} (size {})", reps[ri].size);
                                }
                                None => eprintln!("  {side} {sbits}: key NOT in classes"),
                            }
                        }
                        SigRes::Capped(_) => eprintln!("  {side} {sbits}: sigvec CAPPED"),
                    }
                }
                // compose the reps and compare keys
                let to_key = |r: SigRes| match r { SigRes::Full(v) => Some(fold_key(v.slice())), SigRes::Capped(_) => None };
                let (fk, xk) = (to_key(dp_sigvec(&mut arena, n.a, &caps, dp_a, &mut bufs)), to_key(dp_sigvec(&mut arena, n.b, &caps, dp_a, &mut bufs)));
                if let (Some(fk), Some(xk)) = (fk, xk) {
                    if let (Some(&fi2), Some(&xi2)) = (class_of.get(&fk), class_of.get(&xk)) {
                        let composed = arena.app(reps[fi2].term, reps[xi2].term);
                        let ck = match dp_sigvec(&mut arena, composed, &caps, dp_a, &mut bufs) { SigRes::Full(v) => Some(fold_key(v.slice())), SigRes::Capped(_) => None };
                        eprintln!("  app(rep_fn, rep_arg) = {}: key={ck:?} same_as_probe={}", encode_bits(&arena, composed), ck == tkey);
                    }
                }
            }
        }
        // birds: match class by key, verify EXACTLY by NF strings at every arity (guards
        // against 128-bit key collisions for every published claim)
        // Escalated signatures for every opaque rep at every declared bird arity — the
        // frontier's only expensive input — computed UP FRONT in parallel with TIERED
        // budgets: 10× first (most slow-but-terminating terms resolve there), the full
        // escalation only for survivors. This was the single-core tail after the size loop.
        let esc_table: FastMap<(u32, u8), Option<(u64, u64)>> = {
            let arities: Vec<usize> = {
                let mut a: Vec<usize> = birds.iter().map(|b| b.arity).collect();
                a.sort_unstable();
                a.dedup();
                a
            };
            let jobs: Vec<(u32, u8)> = reps
                .iter()
                .filter(|r| r.vector.is_none())
                .flat_map(|r| arities.iter().map(move |&a| (r.term, a as u8)))
                .collect();
            let tier1 = Caps { steps: steps_cap.saturating_mul(10), nodes: nodes_cap.saturating_mul(10) };
            let mut table: FastMap<(u32, u8), Option<(u64, u64)>> = FastMap::default();
            if jobs.len() < 32 {
                for &(t, a) in &jobs {
                    let r = signature_vars(&mut arena, t, a as usize, &tier1, true, &mut bufs)
                        .or_else(|| signature_vars(&mut arena, t, a as usize, &esc_caps, true, &mut bufs));
                    table.insert((t, a), r);
                }
            } else {
                let p_nodes: &[Node] = &arena.p_nodes;
                let p_dedup = &arena.p_dedup;
                let jobs_ref = &jobs;
                let tier1_ref = &tier1;
                let esc_ref = &esc_caps;
                let enext = std::sync::atomic::AtomicUsize::new(0);
                let enext = &enext;
                let done: Vec<(usize, Vec<(usize, Option<(u64, u64)>)>)> = std::thread::scope(|sc| {
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
                                let _ = w;
                                loop {
                                    let ji = enext.fetch_add(1, Ordering::Relaxed);
                                    if ji >= jobs_ref.len() {
                                        break;
                                    }
                                    let (t, a) = jobs_ref[ji];
                                    let r = signature_vars(&mut wk, t, a as usize, tier1_ref, true, &mut wbufs)
                                        .or_else(|| signature_vars(&mut wk, t, a as usize, esc_ref, true, &mut wbufs));
                                    out.push((ji, r));
                                }
                                (wk.max_var_demand, out)
                            })
                        })
                        .collect::<Vec<_>>()
                        .into_iter()
                        .map(|h| h.join().expect("esc worker panicked"))
                        .collect()
                });
                for (d, out) in done {
                    if d > arena.max_var_demand {
                        arena.max_var_demand = d;
                    }
                    for (ji, r) in out {
                        table.insert(jobs[ji], r);
                    }
                }
            }
            table
        };
        let mut findings: Vec<String> = Vec::new();
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
                let mut best: Option<(u32, String, u32)> = None;
                for r in reps.iter() {
                    if let Some(rv) = &r.vector {
                        if rv.slice()[b.arity..] == bslice[b.arity..] {
                            let cand = (r.size, encode_bits(&arena, r.term), r.term);
                            if best.as_ref().map(|w| (cand.0, &cand.1) < (w.0, &w.1)).unwrap_or(true) {
                                best = Some(cand);
                            }
                        }
                    }
                }
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
                        let (rsize, rterm) = (bsize, bterm);
                        let rbits = bbits;
                        // frontier: opaque (capped) reps strictly cheaper than the winner —
                        // escalate each at the bird's declared arity (memoized)
                        let target = signature_vars(&mut arena, term, b.arity, &esc_caps, true, &mut bufs);
                        let mut winner: (u32, String, u32) = (rsize, rbits, rterm);
                        for ci in 0..reps.len() {
                            if reps[ci].vector.is_some() {
                                continue;
                            }
                            let csize = reps[ci].size;
                            let cterm = reps[ci].term;
                            if csize > winner.0 {
                                continue;
                            }
                            let cbits = encode_bits(&arena, cterm);
                            if csize == winner.0 && cbits >= winner.1 {
                                continue;
                            }
                            match (esc_table.get(&(cterm, b.arity as u8)).copied().flatten(), target) {
                                (Some(s), Some(t2)) if s == t2 => {
                                    winner = (csize, cbits, cterm);
                                }
                                (Some(_), _) => {}
                                (None, _) => unresolved += 1,
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
            findings.push(format!(
                "    {{ \"sym\": {}, \"arity\": {}, \"current_bits\": {}, \"current_iotas\": {}, \"minimal_bits\": {}, \"minimal_iotas\": {}, \"minimal_nf\": {}, \"status\": {}, \"class_size\": 0, \"unresolved_before_winner\": {} }}",
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
        for n in 1..=(if dp_slim { 0 } else { max_iotas }) {
            let newc = reps_by_size[n].iter().filter(|&&ri| reps[ri].vector.is_some()).count();
            if newc > 0 {
                census.push((n, newc));
            }
        }
        let mut samples: Vec<(String, String)> = Vec::new();
        let sample_idx: Vec<usize> = if dp_slim { Vec::new() } else { (0..reps.len()).step_by(1 + reps.len() / 300).collect() };
        for ri in sample_idx {
            if reps[ri].vector.is_none() {
                continue;
            }
            if let Some(nf) = nf_string(&mut arena, reps[ri].term, 5, &caps, &mut bufs) {
                samples.push((encode_bits(&arena, reps[ri].term), nf));
            }
        }
        let classed_total = reps.iter().filter(|r| r.vector.is_some()).count();
        let mut j = String::from("{\n");
        j.push_str(&format!(
            "  \"meta\": {{ \"mode\": \"dp\", \"dp_arity\": {dp_a}, \"max_iotas\": {max_iotas}, \"steps_cap\": {steps_cap}, \"nodes_cap\": {nodes_cap}, \"esc_mult\": {esc_mult}, \"total_terms\": {pair_count}, \"capped_terms\": {capped_count}, \"dp_classes\": {classed_total}, \"max_var_demand\": {}, \"gate_tripped\": {}, \"persistent_nodes\": {} }},\n",
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
        std::fs::write(&out_path, &j).expect("write output");
        println!(
            "minimal-forms[dp]: {pair_count} pairs -> {classed_total} classes + {capped_count} capped reps <={max_iotas}iota · {} birds: {proven} proven-mod-cong, {conditional} conditional, {improved} improved · {}ms -> {out_path}",
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
