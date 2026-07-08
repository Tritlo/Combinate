# 28. Deep minimal-form search composes behavior classes, not Catalan shapes

Brute exhaustion (ADR 27) walls out around 17 ι (48.8M shapes, 89 s, 4 GB; 25 ι would be
~5 × 10⁹). But the census showed the behavior space is tiny (452 classes under 48.8M terms),
so `--dp` enumerates the QUOTIENT: one minimal representative per behavior class — class id =
the signature VECTOR at arities 0..=`--dp-arity` (default 12) — composing `app(f, x)` over
representatives with `minsize(f)+minsize(x) = n`. Exchange argument: any class's min witness
decomposes into components replaceable by their class-min reps, so the DP reaches every class
at its true minimal size *if* bounded-arity equivalence is an application congruence — which
finite vectors cannot guarantee (Codex flagged it; an argument can be interrogated deeper than
the vector sees). Soundness posture instead of a false proof: bird matching compares the
vector SUFFIX from the declared arity up (equality at n implies equality above, nothing below
— full-key matching silently lost GT's 7-ι form before the `--dp-probe` diagnostic caught it);
capped terms compose as opaque singleton reps and block `proven`; every equality is
TS-certified; and the mode is validated **0-mismatch against brute ground truth at ≤17 ι**
(all 54 birds, sizes and statuses). Beyond that, minimality is labeled "modulo bounded-arity
congruence". Payoff: 17 ι in 0.13 s (700× over brute), 25 ι in 58 s / 44 MB — where brute is
impossible — finding `1` = 18 ι (vs 37), B1 = 22 (vs 45), U = 23 (vs 25), D = 16 (vs 36), all
conditional pending divergence analysis of their frontiers. ECTAs (Spectacular) were reviewed
and set aside: their leverage is entangled typed CHOICES, and pure-ι generation has none —
they become relevant if search moves to the named/typed basis.
