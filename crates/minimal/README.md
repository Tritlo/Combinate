# minimal-forms — the ι-minimality engine

Finds, for every symbolic catalog bird, the provably smallest pure-ι term equal to it
(ADR 27), and the equivalence-class census that comes free with the search (ADR 28).
Equality is **symbolic**: the full normal form of `t v₁…vₙ` on fresh free variables is,
by Church–Rosser, a *proof* of extensional equality at that arity — never a test.
Everything the tool claims is re-proven in TypeScript against the app's own reducer
(`scripts/certify-minimal.ts`) before the report exists.

## Everyday use

```sh
npm run minimal-forms         # gen birds.txt → brute ≤13ι → TS certify → spec/minimal-forms.{json,md}
```

Canon (committed `spec/`) is the reproducible 13ι brute run. Statuses:
- `proven` — the whole cheaper frontier normalized and differed: a true minimality certificate.
- `conditional` — N cheaper cap-survivors stayed unknown even escalated; the winner is
  minimal *among terms normalizing within budget*. The N is in the JSON.
- `not-found-within-bound` — no equal term exists at this bound (floor not reached).

## Burning compute

Two engines. **Brute** (`--max-iotas N`, no `--dp`) exhausts every shape — certificates,
but Catalan-walled (~17ι = 89s/4GB, 18ι ≈ 6min/15GB, 19ι+ hopeless). **DP** (`--dp`)
composes behavior-class representatives — validated 0-mismatch against brute at ≤17ι,
labeled "modulo bounded-arity congruence + composition heuristics" beyond.

```sh
./pgo.sh                                          # ~20% faster binary (do this first)
B=target/release/minimal-forms
$B --hunt 42 --out /tmp/deep.json   # smallest + fastest + fixpoint, 16 workers, tuned defaults
cp /tmp/deep.json spec/minimal-forms.json && npx tsx scripts/certify-minimal.ts   # TS re-proof
npm run minimal-forms                              # restore canon before committing
```

Measured costs (24-core, PGO): 17ι = 0.02s · 25ι = 1.5s · 30ι ≈ 90s/2GB · 32ι ≈ 108s/4.6GB.
Growth is driven by class count (2.7M at 32ι) and the escalated frontier (the honest cost
of `conditional` labels — mostly divergers burning full budgets).

Knobs:
- `--steps N` / `--nodes N` — base signature caps (default 2000/20000, the app's probe scale).
- `--esc-mult K` — frontier escalation budget (default 100×, tiered 10× first). Raising it
  chases `conditional` statuses; the blockers that survive behave like true divergers,
  which no budget can disprove (Scott–Curry). **The conditional-chase recipe**: rerun a
  deep bound with `--esc-mult 100000` overnight and diff the unresolved counts.
- `--dp-arity A` — signature-vector arities 0..A (default 12; 8 validated identical ≤32ι).
  Equality claims never depend on it (upward closure from declared arity + exact string
  verify); it only guards minimality-completeness against class over-merge.
- `--dp-gate N` — rep-count stop gate; `--dp-slim` — skip census/samples in the JSON;
  `--dp-opaque-fn` — re-enable capped-HEAD composition (completeness ↑, cost ↑);
  `--prefilter` — 1-var necessary-condition pass (net loss today; scaffold);
  `--dp-probe BITS` — trace why a witness's class was(n't) reached;
  `--hunt N` — the everything hunt (smallest + fastest + fixpoint) with tuned defaults.
- `--fpc-sweep STATE` — post-hoc Böhm-f^5 fixpoint sweep over a snapshot's opaque reps
  (`--fpc-max N` bounds candidate size); finds land in `--out` as `iotas|close-steps|bits`.
- `--fpc-brute N` — EXHAUSTIVE fixpoint census: streams every shape ≤ N (no DP, no
  pruning — closes the delegate-congruence completeness hole for FPC search). Sizes
  ascend with a per-size finds flush + Catalan-count assert, so an interrupted run still
  certifies "exhaustive ≤ last completed size"; `--fpc-from M` composes runs across
  sizes; a planted 26ι positive control gates every run (the scratch-aliasing lesson).
  Certificates are budget-labeled: "no FPC ≤ N within 2000 total head-steps".

What deeper/bigger buys, and what it can't: a deeper bound only adds LARGER candidates
(finds floors not yet reached); smaller-than-known winners can only come from bigger
budgets or laxer heuristics resolving a bird's unresolved blockers. Adoption of winners
into `IOTA_CODE` is always a separate reviewed commit; the gate is certified equality +
recognition within the app's own probe caps (Pred and tail fail it — see catalog.ts).
Minimal ι ≠ minimal steps: golfed forms can unfold slower (C: 110→345 steps) — that's
what `--fastest` measures.

## The three-layer trust model

1. Rust finds (fast, hash-consed, parallel; ~everything in main.rs).
2. Statuses stay honest (caps → conditional; heuristics → modulo labels; nothing silent).
3. TypeScript re-proves every published claim with the app's own `normalize`/`structKey`
   at the declared arity, byte-identical NF format, plus reducer-parity samples.
   `certify-minimal.ts` exits non-zero on any mismatch — the report is untrustworthy
   without its stamp.
