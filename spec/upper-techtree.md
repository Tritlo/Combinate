# upper-techtree — from the ι-cycle to quicksort

> **Status: STRETCH / direction sketch.** A direction for the post-MVP upper tree,
> captured so the design isn't lost — **not** part of the buildable MVP. The MVP is
> `iota-render.md` phases 0–3 (ι-cycle through the SK zoo). The data/recursion/list
> tiers and quicksort below are deferred and **to be reconsidered** before any of
> them are built. Open questions in U9 are genuinely open.
>
> **Scott-world update (ADR 0004 + 0006).** This doc was written against a Church
> encoding and went stale after the switch to **Scott** data (ADR 0004 — the
> encoding MicroHs compiles `data` to). It has been re-grounded in the Scott world,
> and `src/core/catalog.ts` is now the **canonical** source for every encoding/law
> below — where this sketch and the catalog disagree, the catalog wins. The two
> authoring verbs (U2) have since **shipped** as one-hole Define/Abstract (ADR
> 0006, `src/core/authoring.ts`).

Extends [`iota-render.md`](./iota-render.md). That doc bootstraps from ι to the SK
zoo (I, A, K, S, X, then B, C, W) and lists numbers/lists/pairs/recursion as
*stretch*. This doc specifies the **upper tech tree**: booleans → pairs → Scott
numerals → **recursion** → comparison → lists → quicksort, the way Little Alchemy
combines simple elements into increasingly elaborate ones.

Section references like "§7.1" point into `iota-render.md` unless prefixed `U`.

---

## U1. Two decisions that shape everything

1. **Construction = build-it-yourself, with abstraction.** The player still *wires*
   programs from blocks (the soul of the game, §8.4 "watch what you built run"); the
   game does not hand them qsort. To make a large program authorable, two mechanics
   carry the weight (U2): **Define** (collapse a tree into a named block) and
   one-hole **Abstract** (bracket abstraction over a single placeholder variable).
   Both shipped (ADR 0006). Probing confirms what you wired (U3).

2. **Discovery oracle = hybrid.** Free-variable normal-form matching (§7.1) stays
   for the pure-combinator tiers, where it's exact and pretty. The data/recursion
   tiers switch to **example-based** tests carried in the catalog (U3). Reason: `Y`
   has *no* normal form, and the recursive Scott folds stick on an opaque argument —
   neither can be probed by reduce-and-compare, but both have finite example tests.
   (Today's catalog marks these recursive birds "built, not discovered" via a
   sentinel reference that never matches; example-tests are the planned upgrade.)

Alternatives (alchemy-recipes / blueprint / MicroHs import; examples-everywhere)
are recorded in U9.

---

## U2. The authoring mechanic (the keystone) — **shipped**

The base spec has one constructor (snap = application) and one block source (stamp a
discovered law's tree). That tops out around the zoo. The upper tree needs two more
verbs. Both live in the **functional core** (`src/core/authoring.ts`) and produce
ordinary ι/named trees — nothing about the reducer, serializer, or probe changes. A
user-defined combinator is the *same object as a discovery* (CONTEXT.md): a labelled
leaf backed by a tree, registered into the shared catalog.

### U2.1 Define — collapse a tree into a named block

```
select a connected subtree (or whole tree)  ──►  "Define"  ──►  name it
   → the subtree collapses to a single labelled leaf  { kind:"comb"; sym:<name> }
   → a new hotbar slot appears that stamps that tree (exactly §7.3's mechanic)
   → the name → tree binding is appended to the catalog as a user `Law`
```

This is §7.3 generalized: discovered laws were *pre-seeded* named blocks; now the
player mints their own from anything they build. **Discovery (auto, via probe) and
Definition (manual, player-named) are two routes to the same object.** Implemented:
the new leaf carries the subtree as its `def` so the reducer unfolds it when applied
(arity 1 — it unfolds as soon as it has an argument). Persisted via the `Store`
(`putDefinition`, ADR 0008) and reloaded on startup; the name must not collide with
a catalog symbol (rejected — ADR 0006). Serialization (§3.2) is unchanged: a named
block round-trips as its underlying tree through `toEgg`/`fromEgg`.

### U2.2 Abstract — bracket abstraction over a single hole

Combinatory logic has no λ, so a program is a *variable-free* tree. Hand-deriving
that tree is not humanly reasonable. The bridge is the classic **bracket
abstraction** compilation, surfaced as a player verb — restricted to **one hole**
(no multi-hole / lambda editor until the one-hole verb feels good, ADR 0006):

```
mark ONE leaf of a tree as a hole  x   (it becomes a §7.1 free-var placeholder)
   "Abstract x"  ──►  the core computes [x]T, a tree with no x, such that ([x]T) x = T
   ──►  Define the result to name it
```

The algorithm (textbook; ~12 lines, pure — the same one `catalog.ts` uses to derive
each bird's `def` from its law):

```
[x] x        = I
[x] M        = K M                 (when x does not occur in M)
[x] (M x)    = M                   (η, when x ∉ M)
[x] (M N)    = S ([x]M) ([x]N)
```

Compose verbs for multiple parameters: Abstract one hole, Define, then Abstract
again on the next — each step pulls out one argument. This is *exactly* how
λ-calculus compiles to CL, so it doubles as the game teaching that translation. It
keeps full agency — **you** build the body with the variable; the game does only the
mechanical S/K plumbing.

> Worked (Scott `Succ n = λz s. s n`): the successor is a *constructor*, already a
> single block in the catalog. The authoring verbs shine on derived functions — e.g.
> build `(+)`'s body with a hole for the recursive call and Abstract it out, rather
> than hand-deriving the point-free `S/K` blob.

---

## U3. Hybrid discovery (extends §7.1)

Catalog entries (§7.2) carry a discovery strategy. Today the recursive birds use a
**sentinel reference** (`noProbe`) so they never auto-match; the planned upgrade is
an optional `tests` field the probe picks per law:

```ts
type Law = {
  sym: string;
  lawText: string;             // reused in toast + notebook (§7.4)
  arity: number;
  // discovery strategy:
  reference: (vars) => Term;                         // §7.1 free-var match (exact)
  tests?:   { in: Term[]; out: Term }[];             // example-based (planned)
};
```

- **Free-var (combinator tiers):** unchanged §7.1 — apply to fresh free vars,
  reduce, compare normal form to `reference`. Exact for combinators.
- **Example (data/recursion tiers, planned):** for each case, build `T in₀ in₁ …`
  from the player's *discovered* blocks (Scott numbers as stacked `Succ`, lists as
  stacked `cons`), reduce with the step cap, compare normal form to `out`.
- Even `Y` gets a finite test: `Y (K a) ≡ a` — and that is exactly how the catalog
  probes it today (`args: v => [K a]`). Recursion is discoverable without ever
  reducing a non-terminating term.
- **`userDefined` laws are never probed** (ADR 0006): they are *authored*, not
  discovered, so the probe skips them and they never auto-collapse another tree.

---

## U4. The tech tree (tiers 2–9) — Scott

Each atom is built from lower tiers via U2, confirmed via U3. **Bold** = headline
discovery. Encodings/laws below mirror `catalog.ts` (the canonical source).

| tier | block | law / definition (Scott) | built from |
|------|-------|--------------------------|------------|
| **2 bool** | False | `False = K` | K |
| | True | `True = A`  (= `K I`) | A |
| | if | `if c t e = c e t`  (= `C`) | C |
| | not | `not b = b True False` | bool |
| | and / or | `and p q = p False q`, `or p q = p True q` | bool |
| **3 pair** | pair | `V x y z = z x y`  (Vireo) | B, C, T |
| | fst / snd | `fst p = p K`, `snd p = p A` | K, A |
| **4 nat** | Z (zero) | `Z = K` | K |
| | **Succ** | `Succ n z s = s n`  (Scott constructor) | — |
| | Pred | `Pred (S p) = p;  Pred Z = Z`  (= `λm. m Z I`) | — |
| | (+) | `(+) Z n = n;  (+) (S p) n = S (p + n)` | Succ, Y |
| | (-) | `(-) m Z = m;  (-) m (S p) = Pred (m - p)`  (monus) | Pred, Y |
| | (*) | `(*) Z n = Z;  (*) (S p) n = n + (p * n)` | (+), Y |
| **5 rec** | M (ω) | `M x = x x`  (= `S I I`) | S, I |
| | **Y** | `Y f = f (Y f)`  (= `B M (C B M)`) | M, B, C |
| **6 cmp** | isZero | `isZero n = n True (λp. False)` | bool |
| | leq | `leq m n = isZero (m - n)`  *(to build)* | (-), isZero |
| | gt | `gt m n = not (leq m n)`  *(to build)* | leq, not |
| **7 list** | nil | `nil = K` | K |
| | cons | `cons h t n c = c h t`  (Scott) | — |
| | null / head / tail / uncons | `xs <nil-case> (λh t. …)` deconstruction | cons |
| | (\<\>) | `[] <> ys = ys;  (h:t) <> ys = h : (t <> ys)` | cons, Y |
| | map | `map f [] = [];  map f (h:t) = f h : map f t` | cons, Y |
| | concat | `concat [] = [];  concat (xs:xss) = xs <> concat xss` | \<\>, Y |
| **8 listfn** | filter | `filter p l = l [] (λh t. p h (h : filter p t) (filter p t))`  *(to build)* | bool, cons, Y |
| **9** | **qsort** | see U6 | \<\>, filter, leq |

`isZero`, `leq`, `gt`, and `filter` are **not yet in the catalog** — they are the
next blocks to add for the upper tree. Everything else above ships today.

### U4.1 The alchemy collisions (the payoff) — corrected for Scott

These coincidences are real CL facts, and they're the Little-Alchemy "wait, WHAT"
moments — the same element resurfacing in unrelated recipes. **In the Scott world
the collision point is the Kestrel `K`, not the Albatross `A`:**

- **`False = 0 = nil = K`** — all three are the Kestrel. The number *zero* (`Z`),
  Boolean *False*, and the *empty list* (`nil`) are one and the same bird. Each is a
  re-skin of `K`.
- **`A = K I = True = snd`** — the Albatross is Boolean *True* (the second of two
  case arms) **and** a pair's second projection (`snd`).
- **`if = C`** — the Scott boolean case `if c t e = c e t` is exactly the Cardinal.
- **`fst = K`, `snd = A`** — projecting a Scott pair `V x y` reuses the same two
  bird-constants the booleans are made of.

Curate these as bonus achievements ("You found `K` again — it's also ZERO *and*
nil"). They turn the recipe graph into a web of surprises rather than a linear
ladder.

### U4.2 Stacking is the unifying verb

The §4 ι-cycle teaches "stack ι on top, reduce, climb." That same gesture recurs:

- stack ι → walk I→A→K→S→X (tier 0)
- stack **Succ** on `Z` → climb 1, 2, 3, … (tier 4)
- stack **cons** → grow `[3,1,2]` (tier 7)

One verb, three ladders. Numbers and lists are *literally* built by repeated
snapping, no new UI — the early-game feel carried upward.

---

## U5. Recursion — the keystone tier (deep dive)

This is the "big discovery" the whole arc points at, and it needs its own moment.

- **The aha is self-application.** `M = S I I`, and `S I I x → I x (I x) → x x`. The
  reveal: *a tree can feed itself to itself.* Build `M`, apply it to something,
  watch it duplicate. (`M M` is the classic non-terminator — a great,
  safe-because-capped toy.)
- **Y wraps M.** `Y f = f (Y f)` — the fixpoint, `Y = B M (C B M)` in the catalog.
  Discovered via the finite test `Y (K a) ≡ a` (U3).
- **Normal-order is load-bearing, not a default.** §6.4 already picks
  leftmost-outermost. That choice is *what makes `Y` terminate* on finite data: the
  recursive call sits under a Scott case (the `nil`/`Z` arm) and normal order doesn't
  force it until that branch is taken. Under applicative order plain `Y` diverges.
  Promote §6.4's normal-order from a tunable to a hard requirement for the recursive
  tiers. (If a strict mode is ever wanted, ship a strict fixpoint like `Θ` instead.)
- **Presentation:** slow the first `M` duplication way down (like the first
  ι-unfold, §8.4). "Recursion discovered" deserves the biggest toast in the game.

---

## U6. The summit: quicksort

Scott-encoded, normal-order, point-free after abstraction:

```
qsort = Y (λrec l.
  l                                            -- deconstruct the list (nil-case first)
    []                                         -- nil case
    (λp xs.                                     -- cons case: p = pivot = head, xs = tail
       append (rec (filter (λy. leq y p)        xs))   -- sort the ≤-partition
              (cons p
                    (rec (filter (λy. not (leq y p)) xs)))))  -- pivot ∷ sort the >-partition
```

(Scott deconstruction is `l nilCase consCase`, the arms in constructor-declaration
order — so the `[]` arm comes first, matching `null`/`head`/`tail` in the catalog.)

- **`pivot`** = `head l`, falls straight out of the Scott `cons` case `λp xs. …`.
- **partition** = the two `filter` calls with `leq y p` / `not (leq y p)`.
- **Author it** (U2): build each body with a hole for the recursive call / element,
  Abstract it out, and `Define` the `≤p` / `>p` predicates and `filter` as their own
  named blocks first to keep qsort small.
- **Probe** (U3, example): `qsort [] ≡ []`, `qsort [2,1] ≡ [1,2]`,
  `qsort [3,1,2] ≡ [1,2,3]`.
- **The payoff** (ties to §11.4): stamp `qsort`, drag `[3,1,2]` from your
  list-builder, snap, and **watch it sort** — partitions split, recursion fans out,
  the result reassembles. The closing shot of the MVP.

---

## U7. Optimize mode is now primary for the upper tree (perf, extends §6.4)

§6.4 ships pure-ι first and treats named reduction as a later fast mode. **For the
data/recursion tiers that inverts.** In pure ι, `2+2` is already hundreds of steps
and `qsort [3,1,2]` astronomically many — far past the §6.4 cap, and unwatchable. So:

- **Optimize mode** (the v5 toggle, ADR'd) — reduce named combinators by their
  catalog `rule` (the Scott recursion via named sub-combinators, no `Y`-blob
  grinding) — is the **default reducer from the nat tier up.** Step counts stay
  legible.
- **Pure ι becomes "peek under the hood"** — an unfold-and-watch for *small* terms
  only (the ι-cycle, a single `Succ`), gated by a size check.
- The morph animation (§6.3) for big Scott-case trees must **not** animate the
  discarded branch's full reduction — `drop` it (the dead-arm provenance) and move
  on, or the `filter` steps drown in dead-branch noise.
- Keep the step cap, mode-aware (named: plenty for qsort on small lists; pure-ι: cap
  by *tree size* before even starting).

---

## U8. Build plan (extends §10 phases 0–3)

| phase | deliverable | status |
|-------|-------------|--------|
| **4 authoring** | The two U2 verbs: **Define** + one-hole **Abstract** (bracket abstraction with η), persisted via the Store, collision-checked. | **shipped** (ADR 0006) |
| **5 data** | Example-based probe (U3 `tests`). Add `isZero`, `leq`, `gt`. Number-builder (stack `Succ`). The Scott alchemy-collision achievements (U4.1). | bool/nat/pair, `Succ`/`Pred`/`(+)`/`(-)`/`(*)` already in catalog; `leq`/`gt`/`isZero` + example probe pending |
| **6 recursion** | `M` + `Y` (in catalog), the finite-`Y` probe (in catalog), the §U5 reveal animation. | `M`/`Y` shipped; reveal animation pending |
| **7 lists → qsort** | Scott list blocks (in catalog) + list-builder (stack `cons`); `filter`; **qsort**, its example probe, and the §U6 payoff. Optimize mode primary (U7). | `cons`/`head`/`tail`/`null`/`uncons`/`<>`/`map`/`concat` shipped; `filter`/`qsort` + payoff pending |

Phases 4–7 sit on top of the existing 0–3; nothing below changes.

---

## U9. Open decisions (recommendations in **bold**)

- **Include bracket abstraction (U2.2)?** → **Yes — shipped** as one-hole Abstract
  (ADR 0006). It's the only thing that makes the build-it-yourself path tractable
  past the data tier, and it teaches λ→CL for free. *Open:* multi-hole later, or is
  one hole + composition enough forever?
- **List encoding?** → **Scott** (`cons h t n c = c h t`) — decided (ADR 0004).
  Pattern-matching falls out of the encoding (`l caseNil caseCons`), which is what
  the recursive list fns need, and it matches MicroHs's `data` encoding for the
  import path.
- **Construction model?** → **build-it-yourself + abstraction** *(decided, U1)*.
  Alternatives: alchemy-recipes (hand you qsort — loses the build payoff);
  blueprint-with-holes (fill a template — a half-step from U2.2);
  MicroHs-compile-and-drop (the §11.4 spectacle path, deferred to the WASM phase).
- **Discovery oracle?** → **hybrid free-var + example** *(decided, U1)*. The example
  half is still pending (recursive birds use the `noProbe` sentinel today).
- **Naming/collisions?** → **reject duplicates** against catalog symbols (ADR 0006);
  *open:* a namespace (`my/foo`) if rejection chafes in playtest.
- **Risks to watch:** (1) point-free authoring difficulty even *with* U2.2 — needs
  playtesting; (2) rendering/perf of large trees and their reduction (§5.3 tween
  budget); (3) the morph for Scott cases drowning in dead-branch steps (U7).
