# Fixpoint combinators in the raw ι-forest — the corrected census

*(hand-maintained; data from `--fpc-sweep` / `--fpc-brute` + the TS vetting pass.
Supersedes the retracted first census — see the retraction commit.)*

## The retraction

The first census headlined a **26ι "smallest fixpoint combinator"**,
`X (X (X O)) ι` (X = ιS, O = SI). It is not one. It is a sixteenfold iterator:

```
T =β λf. f¹⁶ (O f)      so  T f  and  f (T f)  have distinct normal forms.
```

Caught twice independently within hours: by hand-probing the X-tower family in
the app, and by an external review. Three things went wrong, in order:

1. **The v2 detector certified "closes Böhm f⁵" and stopped.** Five f-levels is
   *necessary* evidence for a sage, never sufficient — any finite tower `fᵏ·u`
   with k ≥ 5 passes. This tower's floor is at level 17.
2. **The prose upgraded the label.** "Closes Böhm f⁵" became "is a fixpoint
   combinator" in the headline. The certificate was honest; the claim was not.
3. **The budget hid the floor.** `T·f` normalizes at 2,138 steps — 138 past the
   detector's 2,000-step budget — so no test we ran could see the bottom.

## The corrected method

Three tiers, two independent tests, controls in both directions:

- **Candidate finder** (Rust, `head_trace_fpc` v3): head-reduce `t·f`, demand
  f-headed levels, and *descend until the budget dies* — any non-f floor within
  budget is a definitive rejection. Budget 2,000 head-steps; the memoless walk
  cannot reach deep floors, so its accepts are **candidates**, never verdicts.
- **Impostor killer** (authoritative): memoized `normalize(t·f)`. A sage's
  `t·f` can never have a normal form (`N =β f·N` is impossible for a finite
  `N`), so *any* NF is a definitive kill — and the memoized walk reaches floors
  the head-walk cannot (the 90-story tower's NF lands at 59,847 steps; the
  head-walk is still f-headed after 10⁶ steps). Depth matters: the TS pass at
  4M nodes killed floors ≤ 90, but the 186-floors below needed the Rust
  reducer (`--nf-probe`, 8-byte nodes, 500M-node ceiling from the 31-bit id
  packing; reducer parity with TS is the repo's standing oracle). A diagnostic
  that pairs with it: true sages' Böhm level count *climbs* with budget
  (Y-54: 427 levels at 10⁶ head-steps; Θ: 305) while a deep tower *saturates*
  (the 27ι stalled at 22 levels from 10⁵ to 10⁷).
- **Planted controls**: Curry's Y (54ι) must fire at census budget; the
  retracted 26ι tower must be rejected at vetting budget. Both gate every run.

What no finite test can do: distinguish a sufficiently deep tower from a true
sage (Scott–Curry). And Böhm-tree evidence is *strictly weaker* than the
fixed-point equation — terms with `BT(t·f) = f^ω` that are **not** FPCs exist
(the literature calls the near-misses *non-standard fixed-point combinators*).
So the tiers are:

| tier | meaning |
|---|---|
| `tower-k` | impostor, proven: `t·f` has an NF, `fᵏ(…)` |
| `candidate` | no NF found (200M memoized steps, node ceiling untouched), f-headed descent past 10⁶ head-steps — *evidence*, FPC-ness open |
| proven | a β-conversion certificate of `t f =β f (t f)` |

## Results (the 26 entries of the retracted census, re-vetted)

**23 impostors** — finite towers. Floors from 15 to 90 f-levels for the
ι-tailed X-towers (the retracted 26ι headline is `tower-16`), and — the second
twist — **the whole `X (X (X O)) I` family is `tower-186`**. The ι → I tail
swap that briefly made the 27ι the headline candidate doesn't create a sage;
it makes a *much deeper mirage*: `t·f =β f¹⁸⁶ (…)`, floor at 213,529 memoized
steps — far past the first vetting pass's caps, caught on a re-check (its
Böhm level count saturating at 22 was the tell).

**3 candidates** stand (`fixpoint-combinators.txt`, format
`iotas|f⁵-steps|verdict|bits`), from two families unrelated to the X-tower:

- **29ι `ι (X I) (S ι (S X A))`-shaped** — **smallest surviving candidate** —
  and a 30ι sibling of the same family;
- **30ι `X (S (S (K O)) I) ι`-shaped**.

All three: no NF after **200,000,000 memoized steps** (node ceiling untouched)
and sage-like level-growth (274/189/132 levels at 10⁵ head-steps, climbing).
That is three orders of magnitude past the deepest known floor — but evidence,
not proof; they stay candidates.

**Smallest proven fixpoint combinators** in the catalog remain:

- **Θ = U U (Turing), 46ι** as ι-code — proven by its one-step unfolding
  `U U f →* f (U U f)`.
- **Y (Curry), 54ι** — the textbook derivation.

Whether any ≤30ι candidate is a strict FPC — or a genuinely non-standard one —
is **open**. A β-proof for the 29ι would cut the proven record by 17ι.

## The exhaustive floor (brute census, `--fpc-brute`)

Streaming enumeration of *every* ι-shape, Catalan-count-asserted per size,
planted controls both ways:

> **No term of ≤ 23ι reaches Böhm f⁵ within 2,000 head-steps.**
> (124,936,258,127 shapes, exhaustive; stopped by decision after size 23 —
> size 24 alone is another 343B shapes, ~28h.)

Since any true FPC closes every Böhm level, this bounds strict FPCs and
non-standard candidates alike: below 24ι there is *nothing* within budget.
The budget label is permanent (a hypothetical slower-than-2,000-step sage
would be missed; no finite budget removes this caveat).

## Game-side fallout

The same class of bug lived in the app: the sage probe `Y (K a) ≡ a` accepted
any `λx. x·u` impostor (`O ι O`, 15ι, recognized and display-folded as the 54ι
Sage). Fixed in `probe.ts`: an NF pre-pass (`t·f` normalizing ⇒ not a sage)
plus the v3 Böhm descent, shared by discovery and the fold. The 18 towers with
floors ≤ 90 are rejected in-game; Curry's Y, Θ = U U, and the 3 candidates
recognize as Y.
(Cap honesty: the in-game pre-pass cannot reach a 186-deep floor, so a
deliberately built deep tower can still fold as Y in play — the census tiers
here, not the in-game probe, are the source of truth.)
