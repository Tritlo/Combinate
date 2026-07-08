# 27. Minimal ι-forms certified by exhaustion + symbolic probing

`crates/minimal` + `scripts/certify-minimal.ts` (run: `npm run minimal-forms`) find, for
each symbolic catalog bird, the provably smallest pure-ι term equal to it. Method: valid
IOTA_CODEs are exactly binary-tree shapes (Catalan-many per ι-count — all ≤13 ι is just
290k terms), so exhaustive enumeration is cheap; equality is decided by the **symbolic
signature** — the full normal form of `t v₁…vₙ` on fresh free variables, which by
Church–Rosser is a *proof* of extensional equality at that arity, not a test. Classes are
bucketed at arity 5 (equality at n ≤ 5 implies equality at 5), then candidates re-verified
at each bird's DECLARED arity — the app's own probe semantics — because arity-5 equality
does not imply lower-arity equality (K I ≠ S K at arity 1). `proven` requires the whole
cheaper frontier to have normalized-and-differed; any cap-out (even under 100× escalated
budgets) downgrades to `conditional`. The Y-family is excluded by construction (no NF —
equality there is undecidable, Scott–Curry). Every published claim is re-proven in
TypeScript against `normalize`/`structKey` before the report is written; the Rust side
(hash-consed arena, scratch/persistent split, iterative spine reducer) exists purely for
speed (≤15 ι ≈ 3.7M terms in ~6 s / 330 MB). MicroHs was considered and rejected as the
engine: its runtime evaluates closed programs in its own basis and exposes no open-term NF.

First run: Barker's I/K/S (and A = ι I) certified minimal; X = ι S (14→6 ι), B 18→10,
GT 10→7, W 16→13; and the tool's construction exposed + fixed a real catalog bug
(IOTA_BITCODE encoded unexpanded combs as "1", colliding Scott-1 with S). Discovered
coincidence: **N ≡ Succ** — the Nuthatch is Scott's successor.

Applying winners to `IOTA_CODE` is deliberately a separate reviewed step (it shifts golf
ι-costs and Zoo visuals); this ADR covers the tool and its certificates only.
