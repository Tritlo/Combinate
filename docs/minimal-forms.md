# The minimal-forms research program — results

*(The capstone summary. Deep artifacts: `spec/minimal-forms-deep.md` — the per-bird
certificate table; `spec/fixpoint-combinators.md` — the FPC census; ADR 27 — the
methodology decision; `crates/minimal/README.md` — the engine. Status: closed
2026-07-10 after the FPC retraction saga; open threads listed at the end.)*

## What we set out to do

For every catalog bird, find the **provably minimal** pure-ι encoding (and the
**fastest**, measured in reduction steps), by exhaustive enumeration with symbolic
certification — and, once the machinery existed, ask a bigger question: *what lives
in the raw ι-forest that the catalog doesn't name?* The answer to that second
question turned out to be the most instructive part.

## Headline results

**Minimal encodings.** Every eligible catalog bird has a certified-minimal ι-form
within the search bound **≤ 43ι** (5.5B semantic classes examined; the deep table in
`spec/minimal-forms-deep.md` re-proves every row against the app's own reducer at
declared arity). Adopted into `IOTA_CODE` across v12: dozens of birds shrank,
including A 7→3, Pe 88→33, Q1 74→42, Q2 65→42, G 49→41, Q4 59→43. Golf costs and
Zoo cards follow the certified forms; every adoption passed the recognition gate
(decode → recognize at game probe caps) — two step-cheap forms (not, null) were
rejected by that gate and stayed out.

**Fastest forms.** `IOTA_FASTEST` records the step-optimal encodings
(`IOTA_FASTEST_BOUND = 43`). Minimal ι ≠ minimal steps: golfed forms can unfold
slower (C: 110→345 steps). **15 birds are unconditionally settled** (`IOTA_SETTLED`)
via the live-core theorem: a class's minimum step count is achieved by a term with
no more ι than steps, so a fastest form found below the bound is optimal, full stop.

**The exhaustive floors.** Brute enumeration (every shape, Catalan-count-asserted):
zero mismatches against the semantic-class DP at ≤ 17ι, and — for the fixpoint
question — **no term of ≤ 23ι reaches Böhm f⁵ within 2,000 head-steps**
(124,936,258,127 shapes).

**The fixpoint census** (the saga — see `spec/fixpoint-combinators.md` for the full
story). A sweep of 242M divergent classes found 26 terms ≤ 30ι that close five Böhm
levels. We headlined the 26ι one as "the smallest fixpoint combinator." **It isn't
one** — it is λf. f¹⁶ (O f), a finite iterator, and the claim was retracted. Its
27ι sibling (tail ι → I) fell next, spectacularly: an f-tower of height **186**,
floor at 213,529 memoized steps. Final tally: **23 of 26 are towers** (floors 15 to
186); **3 candidates stand** at 29–30ι (no NF after 200M memoized steps, sage-like
Böhm level growth) — candidates, not sages, because Böhm-tree f^ω evidence is
strictly weaker than `t f =β f (t f)` (the literature's *non-standard fixed-point
combinators*). **The smallest proven sages in the forest remain Θ = U U (46ι) and
Curry's Y (54ι).**

## Method (what made the results trustworthy)

- **Semantic-class DP**: enumerate one representative per behavior class (signature
  vectors, arities 0–8, incremental Church–Rosser normal forms), compose classes
  instead of shapes. 43ι ≈ 8.1B pairs → 1.26B classes on a 94GB box in ~1.5h after
  the memory diet (31-bit id packing, key-only open-addressed sets, streamed
  candidate windows, 8-byte reps).
- **Three-layer trust**: Rust finds → statuses stay honest (caps ⇒ `conditional`,
  heuristics ⇒ "modulo" labels, nothing silent) → **TypeScript re-proves every
  published claim** with the app's own reducer, byte-identical NF format. No claim
  ships without the TS stamp.
- **Marathon machinery**: per-layer findings checkpoints, compressed versioned
  `.hunt-state` snapshots (atomic write), `--resume` validated bit-identical — a
  multi-day hunt dies at the memory wall and still keeps everything it earned.
- **Planted controls, both directions**: the FPC census gates every run on Curry's
  Y firing *and* the retracted tower rejecting. A positive control alone had let a
  scratch-aliasing bug make an entire brute run vacuous.

## What the retraction taught us (the transferable lessons)

1. **A bounded certificate's label is the claim.** "Closes Böhm f⁵ within budget"
   is honest; upgrading it to "is a fixpoint combinator" in prose is how a
   16-story iterator becomes a headline. Tier vocabulary now: `tower-k` (proven
   impostor — its `t·f` has a normal form) / `candidate` (evidence) / `proven`
   (β-certificate only).
2. **Necessary-evidence detectors must run to exhaustion, not to k.** Detector v3
   descends until the budget dies; any floor reached is a definitive rejection.
3. **Memoization is a vetting superpower.** The memoless head-walk is still
   f-headed at 10⁸ steps on a tower whose floor the memoized reducer reaches in
   2×10⁵. Instruments: `--nf-probe` (memoized NF hunt), the level-growth
   diagnostic (sages climb — Y: 427 levels at 10⁶ head-steps; towers saturate —
   the 27ι stalled at 22).
4. **Adversarial re-checks work.** Both retractions came from probing "obvious"
   neighbors of the champion (`O ι O`, `X (X O)`, the ι→I tail) — and the same
   probing exposed a game bug: the sage probe `Y (K a) ≡ a` accepted any
   `λx. x·u` impostor. The app now uses an NF pre-pass + Böhm descent, and Y's
   self-recognition is asserted in `check:release` like any other bird.

## Open threads

- **The 3 candidates** (29|471, 30|570, 30|395): a β-proof would cut the proven
  sage record by 17ι; a deeper floor would finish the pattern. Nothing below 24ι
  can compete (exhaustive, budget-labeled).
- The brute census's 24–25ι tail (~4.5 days of compute) if the floor should reach
  the 26ι tower's size.
- True 44ι+ hunts need a bigger box (the 94GB wall) — the `.hunt-state` resume
  machinery is built for exactly that migration.
- Coincidence classes → egg re-folder rules; Zoo surfacing of the census story.
