# Fixpoint combinators in the raw ι-forest (generated — do not edit)

The first systematic screening of small ι-terms for fixpoint combinators
(`--fpc-sweep` over the ≤44ι marathon's 242M divergent terms; detector = the
Böhm-prefix test: head-reduce `t·f`, demand `f`-headedness, descend, five nested
levels = the certificate — machine-replayable via `--fpc-probe BITS`, anchored on
Curry's Y).

**Headline: the smallest known fixpoint combinator in the ι-calculus is 26ι** —
half of Curry's textbook Y (54ι as ι-translated SK):

```
000101010101100101010101100101010101100101010110111   (26ι, Böhm f^5 at 965 head steps)
```

Read through the encoding ladder (X = ιS), its shape is essentially
`X (X (X (S I))) ι` — the ladder recursing on itself.

Census: 26 fixpoint combinators at ≤30ι (full list with certificates in
`fixpoint-combinators.txt`, format `iotas|close-steps|bits`). Honesty labels:
each entry carries a *sound* equality certificate (`t f =β f (t f)` follows from
the observed head-cycle by congruence) but the census is complete only modulo
the DP's composition heuristics (opaque-head and prefix-dedup pruning) — a
dedicated brute FPC sweep at small sizes would firm the "smallest" claim into an
exhaustive one, and no entry below 26ι can exist without surviving that check.
