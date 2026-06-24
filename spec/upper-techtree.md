# upper-techtree — from the ι-cycle to quicksort

> **Status: STRETCH / not committed to.** This is a *direction sketch* for the post-MVP
> upper tree, captured now so the design isn't lost — **not** part of the buildable MVP. The
> MVP is `iota-render.md` phases 0–3 (ι-cycle through the SK zoo). Everything here (the
> abstraction mechanic, the data/recursion/list tiers, quicksort) is deferred and **to be
> reconsidered later** before any of it is built. Open questions in U9 are genuinely open.

Extends [`iota-render.md`](./iota-render.md). That doc bootstraps from ι to the SK zoo
(I, A, K, S, X, then B, C, W) and lists numbers/lists/pairs/recursion as *stretch*. This
doc specifies the **upper tech tree**: booleans → pairs → Church numerals → **recursion** →
comparison → lists → quicksort, the way Little Alchemy combines simple elements into
increasingly elaborate ones.

Section references like "§7.1" point into `iota-render.md` unless prefixed `U` (this doc).

---

## U1. Two decisions that shape everything

1. **Construction = build-it-yourself, with abstraction.** The player still *wires* programs
   from blocks (the soul of the game, §8.4 "watch what you built run"); the game does not
   hand them qsort. To make a ~60-node program authorable, two new mechanics carry the
   weight (U2): **Define** (collapse a tree into a named block) and **Abstract** (bracket
   abstraction over a placeholder variable). Probing confirms what you wired (U3).

2. **Discovery oracle = hybrid.** Free-variable normal-form matching (§7.1) stays for the
   pure-combinator tiers (0–1), where it's exact and pretty. Tiers 4+ (data, recursion)
   switch to **example-based** tests carried in the catalog (U3). Reason: `Y` has *no*
   normal form, and `qsort` applied to free vars is stuck on `leq a b` — neither can be
   probed by reduce-and-compare, but both have finite example tests.

These were chosen deliberately; the alternatives (alchemy-recipes / blueprint / MicroHs
import; examples-everywhere) are recorded in U9.

---

## U2. The abstraction mechanic (the keystone)

The current spec has exactly one constructor (snap = application) and one block source
(stamp a discovered law's canonical ι-tree). That tops out around the zoo. The upper tree
needs two more verbs. Both live in the **functional core** (`abstract.ts`, `define.ts`) and
produce ordinary ι/named trees — nothing about the reducer, serializer, or probe changes.

### U2.1 Define — collapse a tree into a named block

```
select a connected subtree (or whole tree)  ──►  "Define"  ──►  name it
   → the subtree collapses to a single labelled leaf  { kind:"comb"; sym:<name> }
   → a new hotbar slot appears that stamps that tree (exactly §7.3's mechanic)
   → the name → tree binding goes in a symbol table (presentation layer only)
```

This is §7.3 generalized: discovered laws were *pre-seeded* named blocks; now the player
mints their own from anything they build. **Discovery (auto, via probe) and Definition
(manual, player-named) are two routes to the same object: a labelled leaf backed by a tree.**

- Under the hood a named leaf *is* its definition tree. Serialization (§3.2 bit-code) is
  unchanged — a named block serializes as its underlying ι-tree, so round-tripping with the
  MicroHs toolchain still holds; names are a symbol table, not part of the wire format.
- In **named mode** (§6.4) the leaf fires by a derived rule (or stays inert and unfolds on
  demand). "Unfold to ι" (§6.4) expands it back. Pure-ι mode always expands.

### U2.2 Abstract — bracket abstraction over a placeholder

Combinatory logic has no λ, so a program is a *variable-free* tree. Hand-deriving that tree
(e.g. the S/K/B/C form of `filter`) is not humanly reasonable. The bridge is the classic
**bracket-abstraction** compilation, surfaced as a player verb:

```
drop a free-var leaf  x   (a §7.1 "free" node, reused as an editing placeholder)
   build any tree T using x  (snap it together like normal)
   "Abstract x"  ──►  the core computes [x]T, a tree with no x, such that ([x]T) x = T
```

The algorithm (textbook; ~15 lines, pure):

```
[x] x        = I
[x] (M N)    = S ([x]M) ([x]N)
[x] M        = K M                 (when x does not occur in M)
   + the standard B/C/η optimizations to keep trees small:
[x] (M x)    = M                   (when x ∉ M)            -- η
[x] (M N)    = B M ([x]N)          (when x ∉ M, x ∈ N)
[x] (M N)    = C ([x]M) N          (when x ∈ M, x ∉ N)
```

Nest it for multiple parameters: `[f][x] T` builds a 2-arg combinator. This is *exactly*
how λ-calculus compiles to CL, so it doubles as the game teaching the player that
translation. It keeps full agency — **you** build the body with the variable; the game only
does the mechanical S/K plumbing you'd otherwise do by hand.

> Worked: build `succ`. Drop vars `n f x`. Wire `f (n f x)`. Abstract `x`, then `f`, then
> `n` → out comes `S(S(KS)K)` ( = `S B`), the canonical successor. The player *sees* the
> point-free form crystallize out of the readable body.

This is the one genuinely new idea versus the base spec — flagged for sign-off in U9.

---

## U3. Hybrid discovery (extends §7.1)

Catalog entries (§7.2) gain an optional `tests` field. The probe picks its strategy per law:

```ts
type Law = {
  sym: string;
  lawText: string;             // reused in toast + notebook (§7.4)
  ingredients: string[];       // prerequisite blocks — the Little-Alchemy recipe + hint gate
  // exactly one discovery strategy:
  freeVar?: { arity: number; reference: Term };      // tiers 0–1: §7.1 free-var match
  tests?:   { in: Term[]; out: Term }[];             // tiers 4+: example-based
};
```

- **Free-var (tiers 0–1):** unchanged §7.1 — apply to `n` fresh free vars, reduce, compare
  normal form to `reference`. Exact for combinators.
- **Example (tiers 4+):** for each case, build `T in₀ in₁ …` from the player's *discovered*
  blocks, reduce with the step cap, compare normal form to `out`. All inputs/outputs are
  themselves discovered blocks (numbers as stacked `succ`, lists as stacked `cons`), so the
  oracle only ever uses things the player already has.
- **`ingredients`** is the recipe edge (the DAG below) and the **hint gate**: a law is only
  *probed for* once its ingredients are unlocked, and the notebook can nudge "you have
  `pred` + `isZero` — try building `leq`."
- Even `Y` gets a finite test: `Y (K a) ≡ a` (`Y(K a) → (K a)(Y(K a)) → a`). Recursion is
  discoverable without ever reducing a non-terminating term.

---

## U4. The tech tree (tiers 2–9)

Each atom is built from lower tiers via U2, confirmed via U3. Behavioural law + key deps.
**Bold** = headline discovery; SK forms given only where clean (catalog stores the rest).

| tier | block | law / definition | built from |
|------|-------|------------------|------------|
| **2 bool** | true | `true = K` | K |
| | false | `false = A`  (= `K I`) | A |
| | if | `if = I`  (`if b t e = b t e`) | I |
| | not | `not = C`  (`C b t e = b e t`) | C |
| | and / or | `and p q = p q false`, `or p q = p true q` | bool |
| **3 pair** | pair | `pair a b f = f a b` | B, C |
| | fst / snd | `fst p = p K`, `snd p = p A` | K, A |
| **4 nat** | 0 | `0 = A`  (= `λf x. x`) | A |
| | **succ** | `succ n f x = f (n f x)`  (= `S B`) | S, B |
| | + | `+ m n f x = m f (n f x)` | succ |
| | × | `× = B`  (`B m n f = m (n f)`) | B |
| | isZero | `isZero n = n (K false) true` | bool |
| **4b** | pred | `pred n = fst (n shift (pair 0 0))`, `shift p = pair (snd p) (succ (snd p))` | pair, succ |
| | sub | `sub m n = n pred m`  (monus) | pred |
| **5 rec** | ω | `ω = S I I`  (`ω x = x x`) | S, I |
| | **Y** | `Y f = f (Y f)`  (std SK: `S(K(SII))(S(S(KS)K)(K(SII)))`) | ω / S,K,I |
| **6 cmp** | leq | `leq m n = isZero (sub m n)` | sub, isZero |
| | gt | `gt = not ∘ leq` | leq, not |
| **7 list** | nil | `nil = A`  (`λc n. n`) | A |
| | cons | `cons h t c n = c h t`  (Scott) | (pair-shaped) |
| | isNil / head / tail | `l (λh t. …) …` deconstruction | cons |
| **8 listfn** | append | `Y(λr a b. a (λh t. cons h (r t b)) b)` | Y, cons |
| | filter | `Y(λr p l. l (λh t. p h (cons h (r p t)) (r p t)) nil)` | Y, cons, bool |
| **9** | **qsort** | see U6 | append, filter, leq |

### U4.1 The alchemy collisions (the payoff)

These coincidences are real CL facts, and they're the Little-Alchemy "wait, WHAT" moments —
the same element resurfacing in unrelated recipes (like water in steam *and* ice):

- **`false = 0 = nil = A`** — all four are `K I`. The ι-cycle's quirky `A` (§4) is secretly
  *false*, *zero*, **and** the *empty list*. Discovering each is a re-skin of `A`.
- **`true = K`**, **`if = I`** — booleans and conditionals were already in your hotbar.
- **`× = B`** — "composition *is* multiplication" on Church numerals.
- **`not = C`** — "flip *is* negation" on booleans.

Curate these as bonus achievements ("You found `A` again — it's also ZERO"). They turn the
recipe graph into a web of surprises rather than a linear ladder.

### U4.2 Stacking is the unifying verb

The §4 ι-cycle teaches "stack ι on top, reduce, climb." That same gesture recurs:

- stack ι → walk I→A→K→S→X (tier 0)
- stack **succ** on `0` → climb 1, 2, 3, … (tier 4)
- stack **cons** → grow `[3,1,2]` (tier 7)

One verb, three ladders. Numbers and lists are *literally* built by repeated snapping, no
new UI — exactly the early-game feel, carried upward.

---

## U5. Recursion — the keystone tier (deep dive)

This is the "big discovery" the whole arc points at, and it needs its own moment.

- **The aha is self-application.** `ω = S I I`, and `S I I x → I x (I x) → x x`. The reveal:
  *a tree can feed itself to itself.* Build `ω`, apply it to something, watch it duplicate.
  (`ω ω = Ω` is the classic non-terminator — a great, safe-because-capped toy.)
- **Y wraps ω.** `Y f = f (Y f)` — the fixpoint. Discovered via the finite test `Y(K a) ≡ a`
  (U3), or by building it from `ω` + composition and probing.
- **Normal-order is load-bearing, not a default.** §6.4 already picks leftmost-outermost.
  That choice is *what makes `Y` terminate* on finite data: the recursive call sits under a
  conditional (`isNil`/`if`) and normal order doesn't force it until the branch is taken.
  Under applicative order plain `Y` diverges. Promote §6.4's "normal-order" from a tunable to
  a hard requirement for tiers 5–9. (If a strict mode is ever wanted, ship `Z` instead.)
- **Presentation:** slow the first `ω` duplication way down (like the first ι-unfold, §8.4).
  "Recursion discovered" deserves the biggest toast in the game.

---

## U6. The summit: quicksort

Scott-encoded, normal-order, point-free after abstraction:

```
qsort = Y (λrec l.
  l                                            -- deconstruct the list
    (λp xs.                                     -- cons case: p = pivot = head, xs = tail
       append (rec (filter (λy. leq y p)        xs))   -- sort the ≤-partition
              (cons p
                    (rec (filter (λy. not (leq y p)) xs))))  -- pivot ∷ sort the >-partition
    nil)                                        -- nil case
```

- **`pivot`** = `head l`, falls straight out of the Scott `cons` case `λp xs. …`.
- **partition** = the two `filter` calls with `leq y p` / `not (leq y p)`.
- **Author it** (U2): build the body with placeholders `rec l p xs y`, abstract them away,
  `Define` the `≤p` and `>p` predicates as their own named blocks first to keep it small.
  qsort collapses to ~12 visible blocks once `filter`/`append`/partition are named leaves.
- **Probe** (U3, example): `qsort [] ≡ []`, `qsort [2,1] ≡ [1,2]`, `qsort [3,1,2] ≡ [1,2,3]`.
- **The payoff** (ties to §11.4): stamp `qsort`, drag `[3,1,2]` from your list-builder, snap,
  and **watch it sort** — the partitions split, the recursion fans out, the result reassembles.
  This is the closing shot of the MVP.

---

## U7. Named mode is now primary (perf, extends §6.4)

§6.4 ships pure-ι first and treats "named" as a later fast mode. **For tiers ≳3 that
inverts.** In pure ι, `2+2` is already hundreds of steps and `qsort [3,1,2]` is astronomically
many — far past the §6.4 10⁴ cap, and unwatchable. So:

- **Named mode is the default reducer from tier ~3 up.** Named leaves fire by their own rule
  (`B x y z → x(y z)`, `succ`'s rule, …); the step counts stay legible.
- **Pure ι becomes "peek under the hood"** — an unfold-and-watch for *small* terms only
  (the ι-cycle, a single `succ`), gated behind a size check so nobody auto-detonates qsort
  into a billion-leaf tree.
- The morph animation (§6.3) for big conditional trees must **not** animate the discarded
  branch's full reduction — `drop` it (the `K`/`if`-dead-branch provenance) and move on, or
  the `filter` steps drown in dead-branch noise.
- Keep the step cap, but make it mode-aware (named: ~10⁴ is plenty for qsort on small lists;
  pure-ι: cap by *tree size* before even starting).

---

## U8. Build plan (extends §10 phases 0–3)

| phase | deliverable |
|-------|-------------|
| **4 abstraction** | The two U2 verbs: **Define** (collapse → named leaf + hotbar slot + symbol table) and **Abstract** (bracket abstraction over a placeholder var, with B/C/η opt). Unit-test against hand-derived forms (succ, B, C). |
| **5 data** | Hybrid probe (U3, `tests` in catalog). Tiers 2–4: bool, pair, Church nat, isZero, pred, sub. Number-builder (stack `succ`). The alchemy-collision achievements (U4.1). |
| **6 recursion** | ω + Y, the finite-`Y` probe, the §U5 reveal animation. Promote normal-order to hard requirement. leq/gt (tier 6). |
| **7 lists → qsort** | Scott list blocks + list-builder (stack `cons`); append, filter; **qsort**, its example probe, and the §U6 "drop `[3,1,2]` and watch" payoff. Named mode primary (U7). |

Phases 4–7 sit on top of the existing 0–3; nothing below changes. The MVP nugget the user
described — "all the way to quicksort" — is **phase 7 complete**.

---

## U9. Open decisions (recommendations in **bold**)

- **Include bracket abstraction (U2.2)?** → **Yes.** It's the only thing that makes the
  chosen build-it-yourself path tractable past tier 4, and it teaches λ→CL for free. *The one
  decision to confirm — it adds a verb the base spec doesn't have.* Alt: stay strictly
  point-free (only `Define`) — keeps the spec minimal but makes `filter`/`qsort` effectively
  un-authorable by hand; I'd reject it.
- **List encoding?** → **Scott** (`cons h t c n = c h t`). Pattern-matching falls out of the
  encoding itself (`l caseCons caseNil`), which is what the recursive list fns need, and it
  matches MicroHs's data encoding (§11.4) for the import path. Church/fold lists make `fold`
  trivial but deconstruction (head/tail) awkward — wrong trade for qsort.
- **Construction model?** → **build-it-yourself + abstraction** *(decided, U1)*. Recorded
  alternatives: alchemy-recipes (hand you qsort — loses the build payoff); blueprint-with-holes
  (fill a template — half-step from U2.2); MicroHs-compile-and-drop (the §11.4 spectacle path,
  deferred to the WASM phase).
- **Discovery oracle?** → **hybrid free-var + example** *(decided, U1)*. Alt: examples
  everywhere (one mechanism, but loses the exact "apply to fresh vars" feel for combinators).
- **How point-free should qsort end up?** → let the player `Define` aggressively (named
  partition/filter blocks) rather than forcing one giant tree; the bit-code (§3.2) is identical
  either way. Golf (§7.3) can reward minimal trees as a stretch.
- **Risks to watch:** (1) point-free authoring difficulty even *with* U2.2 — needs playtesting;
  (2) rendering/perf of 40–80-node trees and their reduction (§5.3 tween budget); (3) the
  morph for conditionals drowning in dead-branch steps (U7).
