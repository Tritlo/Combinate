# 19. Turbo honours the rules setting (wasm + rules + native + sharing)

**Status:** accepted

## Context

Turbo (the wasm graph reducer, ADR 16) had native kernels + call-by-need sharing but **no
catalog rules** — it def-unfolded every named combinator down to ι/S/K/I and ground through it.
It was also *mutually exclusive* with Rule-Based Reduction. Profiling `fac` showed the cost is
step-bound, not reflow-bound: the wasm def-unfold grind did far more contractions than the TS
`rules+native` path did rule-steps (~95% of the profile was `Graph::step`, <1% reflow/decode).
So the wasm engine needed the rules, and to be combinable with them.

## Decision

Forward the current opts into the wasm session so `wasm + rules + native` is a real, toggleable,
fastest reduction tier (fewest steps via rules, no blow-up via sharing, fast wall-clock via wasm).

- **Rule templates on the wire.** Each catalog combinator that carries a `rule` ships its rule
  applied to placeholder args (`$warg0…`) as an immutable-prefix subtree (`rule_root`), next to the
  existing def-unfold trees, gated by a `FAST_RULES` header bit. Placeholders emit as a new
  `TAG_ARG` node. This reuses `catalog.ts` as the single source of the laws — zero rule logic in
  Rust (`wasmCodec.ts`).
- **Instantiate, don't def-unfold.** In fast mode the graph engine reduces a saturated named
  combinator by cloning its template over the redex, substituting each `TAG_ARG(i)` with the
  *shared* actual arg cell (`instantiate_rule`, the graph analogue of `clone_def`). Same
  leftmost-outermost order and dispatch as `reduce.ts`'s `redexAt`: native kernel first (when its
  operands are values), else the rule, else def-unfold. No per-rule Rust code.
- **Eligibility.** `turboEligible` drops the `!fast` guard (Turbo still steps aside for Graph
  mode, which drives its own loop); `makeSession` forwards `fast` + native into the session, and
  toggling Rule-Based Reduction rebuilds resident sessions (they bake `fast` at construction).
- **Basis-combinator defs (prerequisite).** A MicroHs-compiled program's basis combinators
  (`C'/K2/K3/K4/C'B`) aren't in the catalog but carry their own SKI `def`/`arity` on the node. The
  codec resolved defs from the catalog only, so these emitted as *inert* primitives — no compiled
  program could reduce in wasm (it stuck; with rules on, the recursion base case never routed, so
  it diverged). The codec now also emits each non-catalog comb's inline def, exactly as the TS
  reducer unfolds them via `fn.def`.

## Consequences

`wasm+rules+native` reduces every workload to the **same** normal form as the TS fast path (parity
net: 588 fast-mode checks + 8 end-to-end MicroHs dumps, 0 mismatches) with equal-or-fewer steps
(sharing) and far less wall-clock. Engine-only (no UI pacing): `fac` 4775 ms → 0.33 ms, `quicksort`
310 ms → 0.32 ms, and on sharing-free linear workloads (`map Succ [..80]`) identical step counts at
~14× the speed — the target "same steps, faster wall-clock" exactly. Basis combinators without a
catalog law (`C'/K2/K3/K4/C'B`) still def-unfold (a minor SKI grind); the catalog combinators that
dominate the plumbing (`B/C/Φ/D/T/V/Z`, arithmetic, `Y`) all fire rules. The wire's sym table grew
3→4 i32s (adds `rule_root`); the persistent (non-fast oracle) reducer ignores rules and stays the
def-unfold mirror.
