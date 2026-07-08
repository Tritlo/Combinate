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
    p_nodes: Vec<Node>,
    p_dedup: FastMap<u64, u32>,
    s_nodes: Vec<Node>,
    s_dedup: FastMap<u64, u32>,
    scratch: bool, // where do NEW nodes go?
}

impl Arena {
    fn new() -> Self {
        Arena {
            p_nodes: Vec::new(),
            p_dedup: FastMap::default(),
            s_nodes: Vec::new(),
            s_dedup: FastMap::default(),
            scratch: false,
        }
    }
    fn intern(&mut self, tag: u8, a: u32, b: u32) -> u32 {
        let key = ((tag as u64) << 60) | ((a as u64) << 30) | b as u64;
        // Persistent nodes are always reusable; scratch nodes only while scratch lives.
        if let Some(&id) = self.p_dedup.get(&key) {
            return id;
        }
        if self.scratch {
            if let Some(&id) = self.s_dedup.get(&key) {
                return id;
            }
            let id = SCRATCH_BASE + self.s_nodes.len() as u32;
            self.s_nodes.push(Node { tag, a, b });
            self.s_dedup.insert(key, id);
            id
        } else {
            debug_assert!(a < SCRATCH_BASE && b < SCRATCH_BASE, "persistent node referencing scratch");
            let id = self.p_nodes.len() as u32;
            self.p_nodes.push(Node { tag, a, b });
            self.p_dedup.insert(key, id);
            id
        }
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
    fn clear_scratch(&mut self) {
        self.s_nodes.clear();
        self.s_dedup.clear();
    }
}

// ---------------- reducer: leftmost-outermost to full NF ----------------

struct Caps {
    steps: u64,
    nodes: usize, // scratch-allocation budget per signature
}

enum NfResult {
    Done(u32),
    Capped,
}

/// Reduce `root` to full normal form. Iterative: an explicit spine stack for the
/// head-reduction loop, and an explicit frame stack for normalizing the arguments of
/// a stuck head. Caps: total contractions + scratch nodes allocated (the caller runs
/// this inside a fresh scratch window, so both are deterministic per term).
fn normalize(arena: &mut Arena, root: u32, caps: &Caps, steps_used: &mut u64) -> NfResult {
    enum Frame {
        Norm(u32),
        Rebuild(u32, usize),
    }
    let mut frames: Vec<Frame> = vec![Frame::Norm(root)];
    let mut results: Vec<u32> = Vec::new();
    let mut spine: Vec<u32> = Vec::new(); // reused arg stack for the head loop

    while let Some(frame) = frames.pop() {
        match frame {
            Frame::Norm(mut t) => {
                // Head-reduce: unwind the application spine, contract at the head until stuck.
                spine.clear();
                loop {
                    let n = arena.node(t);
                    if n.tag == TAG_APP {
                        spine.push(n.b);
                        t = n.a;
                        continue;
                    }
                    // Leaf head; spine top = FIRST argument.
                    let argc = spine.len();
                    let contracted = match n.tag {
                        TAG_IOTA if argc >= 1 => {
                            // ι x → x S K
                            let x = spine.pop().unwrap();
                            let s = arena.leaf(TAG_S, 0);
                            let k = arena.leaf(TAG_K, 0);
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
                            let gx = arena.app(g, x);
                            spine.push(gx);
                            spine.push(x);
                            t = f;
                            true
                        }
                        _ => false,
                    };
                    if contracted {
                        *steps_used += 1;
                        if *steps_used > caps.steps || arena.s_nodes.len() > caps.nodes {
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
                    t = arena.app(t, a);
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
fn struct_hash(arena: &Arena, t: u32, want_string: bool) -> (u64, u64, Option<String>) {
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
    const VARS: [&str; 5] = ["va", "vb", "vc", "vd", "ve"];
    let mut stack: Vec<W> = vec![W::T(t)];
    while let Some(w) = stack.pop() {
        match w {
            W::Lit(l) => eat(l, &mut s),
            W::T(id) => {
                let n = arena.node(id);
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

// ---------------- signatures ----------------

const SIG_ARITY: usize = 5;

/// NF signature hash of `t v0 … v(arity-1)`, or None if capped. Runs in a fresh
/// scratch window (cleared on entry) so caps are deterministic per term.
fn signature(arena: &mut Arena, t: u32, arity: usize, caps: &Caps) -> Option<(u64, u64)> {
    signature_vars(arena, t, arity, caps, true)
}

/// Like `signature`, but `distinct = false` applies the SAME fresh variable `arity`
/// times: t x x … x. Identifying variables is a homomorphic coarsening, so equal
/// terms MUST collide here — a cheap necessary condition (the QuickSpec prefilter);
/// only colliding terms need the distinct-variable proof.
fn signature_vars(arena: &mut Arena, t: u32, arity: usize, caps: &Caps, distinct: bool) -> Option<(u64, u64)> {
    arena.clear_scratch();
    arena.scratch = true;
    let mut applied = t;
    for v in 0..arity {
        let fv = arena.leaf(TAG_FREE, if distinct { v as u32 } else { 0 });
        applied = arena.app(applied, fv);
    }
    let mut steps = 0u64;
    let out = match normalize(arena, applied, caps, &mut steps) {
        NfResult::Done(nf) => {
            let (h1, h2, _) = struct_hash(arena, nf, false);
            Some((h1, h2))
        }
        NfResult::Capped => None,
    };
    arena.scratch = false;
    out
}

/// NF STRING of `t v0 … v(arity-1)` (reported artifacts), or None if capped.
fn nf_string(arena: &mut Arena, t: u32, arity: usize, caps: &Caps) -> Option<String> {
    arena.clear_scratch();
    arena.scratch = true;
    let mut applied = t;
    for v in 0..arity {
        let fv = arena.leaf(TAG_FREE, v as u32);
        applied = arena.app(applied, fv);
    }
    let mut steps = 0u64;
    let out = match normalize(arena, applied, caps, &mut steps) {
        NfResult::Done(nf) => struct_hash(arena, nf, true).2,
        NfResult::Capped => None,
    };
    arena.scratch = false;
    out
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

fn main() {
    let t_start = Instant::now();
    let mut max_iotas: usize = 13;
    let mut steps_cap: u64 = 2_000;
    let mut nodes_cap: usize = 20_000;
    let mut out_path = String::from("spec/minimal-forms.json");
    let mut prefilter = false; // 1-var necessary-condition pass; skips full sigs for bird-irrelevant terms (partial census!)
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--max-iotas" => max_iotas = args.next().unwrap().parse().unwrap(),
            "--steps" => steps_cap = args.next().unwrap().parse().unwrap(),
            "--nodes" => nodes_cap = args.next().unwrap().parse().unwrap(),
            "--out" => out_path = args.next().unwrap(),
            "--prefilter" => prefilter = true,
            other => panic!("unknown arg {other}"),
        }
    }
    let caps = Caps { steps: steps_cap, nodes: nodes_cap };
    let esc_caps = Caps { steps: steps_cap * 100, nodes: nodes_cap * 100 };

    let mut arena = Arena::new();

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
    let bird_sig5: Vec<Option<(u64, u64)>> = bird_terms
        .iter()
        .map(|&t| signature(&mut arena, t, SIG_ARITY, &esc_caps))
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
            match signature_vars(&mut arena, t, SIG_ARITY, &esc_caps, false) {
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
                match signature_vars(&mut arena, t, SIG_ARITY, &caps, false) {
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
            match signature(&mut arena, t, SIG_ARITY, &caps) {
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
        let target = signature(&mut arena, term, b.arity, &esc_caps);
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
                match signature(&mut arena, t, b.arity, &esc_caps) {
                    Some(s) if s == target => {
                        f.minimal_bits = Some(bits);
                        f.minimal_iotas = Some(sz);
                        f.minimal_nf = nf_string(&mut arena, t, b.arity, &esc_caps);
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
            let nf = nf_string(&mut arena, bird_terms[bird_idxs[0]], SIG_ARITY, &esc_caps)
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
            let nf = nf_string(&mut arena, c.min_term, SIG_ARITY, &esc_caps).unwrap_or_else(|| "<capped>".into());
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
        if let Some(nf) = nf_string(&mut arena, t, SIG_ARITY, &caps) {
            samples.push((encode_bits(&arena, t), nf));
        }
    }

    // -- JSON out (hand-rolled) --
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
    let mut j = String::from("{\n");
    j.push_str(&format!(
        "  \"meta\": {{ \"max_iotas\": {max_iotas}, \"steps_cap\": {steps_cap}, \"nodes_cap\": {nodes_cap}, \"total_terms\": {total_terms}, \"capped_terms\": {capped_count}, \"persistent_nodes\": {}, \"timings_ms\": {{ \"birds\": {}, \"enumerate\": {}, \"signatures\": {}, \"certify\": {} }} }},\n",
        arena.p_nodes.len(),
        t_birds.as_millis(),
        (t_enum - t_birds).as_millis(),
        (t_sigs - t_enum).as_millis(),
        (t_cert - t_sigs).as_millis(),
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
