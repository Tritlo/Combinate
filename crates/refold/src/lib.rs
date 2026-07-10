//! egg-based re-sugarer (ADR 0002). Given a combinator term as an
//! s-expression — `@` for application, bare atoms for leaves (`iota`, `S`, `K`,
//! `I`, and named birds like `B`, `cons`, `Succ`) — build an e-graph, saturate
//! it with the catalog's laws as *bidirectional* rewrites, and extract the
//! cheapest equivalent term under a cost that prefers named birds over raw
//! ι/S/K. The effect is to fold an SKI/ι form back to its most-named reading.
//!
//! The rules are generated from the TypeScript catalog (the single source of
//! truth) into `rules.txt` by `scripts/gen-rules.ts` and embedded at compile
//! time, so Rust and TS never drift.

use egg::*;
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

define_language! {
    /// First-order combinator language: binary application plus symbol leaves.
    /// Every leaf — ι, the primitives S/K/I, and the named birds — is a `Sym`;
    /// the rewrite rules distinguish them by name.
    pub enum Comb {
        "@" = App([Id; 2]),
        Sym(Symbol),
    }
}

/// Per-leaf extraction cost. Raw ι is the most expensive (we most want it gone),
/// the S/K/I primitives next; any *named* bird is cheap, so extraction collapses
/// an SKI tree into the named combinator it realises whenever a rule connects
/// them. Free variables (single lowercase letters left over from a probe) are
/// cheap too — they are already as readable as they get.
fn leaf_cost(s: &str) -> usize {
    match s {
        "iota" => 100,
        "S" | "K" | "I" => 30,
        _ => 1,
    }
}

/// Cost = sum of leaf costs + a small per-application charge, so the extractor
/// prefers fewer nodes and fewer raw primitives — i.e. the most-folded form.
struct ReadCost;
impl CostFunction<Comb> for ReadCost {
    type Cost = usize;
    fn cost<C: FnMut(Id) -> Self::Cost>(&mut self, enode: &Comb, mut costs: C) -> Self::Cost {
        let base = match enode {
            Comb::App(_) => 2,
            Comb::Sym(s) => leaf_cost(s.as_str()),
        };
        enode
            .children()
            .iter()
            .fold(base, |acc, &id| acc.saturating_add(costs(id)))
    }
}

/// Build rewrites from the embedded `rules.txt`. Each line is `name | lhs | rhs`
/// (a sound equation). We add each *direction* only when it is a valid e-match
/// rule — its applier's variables must all occur in its searcher — so an
/// argument-dropping law like `K x y = x` contributes only the contracting
/// direction (`K x y => x`) and never tries to invent the dropped `y`. Ground
/// definitional equations (no variables) are added both ways.
fn build_rules() -> Vec<Rewrite<Comb, ()>> {
    let spec = include_str!("rules.txt");
    let mut rules = Vec::new();
    for line in spec.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '|').map(str::trim).collect();
        if parts.len() != 3 {
            continue;
        }
        let (name, lhs_s, rhs_s) = (parts[0], parts[1], parts[2]);
        let lhs: Pattern<Comb> = match lhs_s.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let rhs: Pattern<Comb> = match rhs_s.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let lv: HashSet<Var> = lhs.vars().into_iter().collect();
        let rv: HashSet<Var> = rhs.vars().into_iter().collect();
        if rv.is_subset(&lv) {
            if let Ok(r) = Rewrite::new(format!("{name}>"), lhs.clone(), rhs.clone()) {
                rules.push(r);
            }
        }
        if lv.is_subset(&rv) {
            if let Ok(r) = Rewrite::new(format!("{name}<"), rhs, lhs) {
                rules.push(r);
            }
        }
    }
    rules
}

/// Re-sugar one term. Returns the folded s-expression, or the input unchanged if
/// it does not parse or nothing better is found. Pure and bounded: the runner is
/// capped on nodes, iterations, and wall-clock so a folding rule firing all over
/// an SKI tree cannot blow up.
#[wasm_bindgen]
pub fn refold(term: &str) -> String {
    let expr: RecExpr<Comb> = match term.parse() {
        Ok(e) => e,
        Err(_) => return term.to_string(),
    };
    let rules = build_rules();
    // Caps tuned for an interactive lens: a folding rule firing all over an SKI
    // tree saturates fast, so bound nodes/iters tightly and keep the wall-clock
    // ceiling low enough that one call never visibly stalls a frame.
    let runner = Runner::default()
        .with_expr(&expr)
        .with_node_limit(12_000)
        .with_iter_limit(40)
        .with_time_limit(std::time::Duration::from_secs(1))
        .run(&rules);
    let root = runner.roots[0];
    let extractor = Extractor::new(&runner.egraph, ReadCost);
    let (_cost, best) = extractor.find_best(root);
    best.to_string()
}
