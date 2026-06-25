# 3. Typing: a decoder/lens, not a gate

**Status:** accepted

## The problem

The same untyped combinator plays many roles: `A` (= `K I`) is Boolean **False**,
Church **0**, the empty list **nil**, and a pair's **snd**. `K` is **True** and
**fst**. `I` is **1** and **If**. The catalog already records this as `alias`es
across PAGES. The question: can we *type* combinators — tag some as `Int`, `Bool`,
`List` — so we know when an `A` is a `0` vs a `False` vs a `nil`, and what does that
buy us?

## The key insight (why "impossible in general" is the wrong frame)

You **cannot** recover the role from the term: `0`, `False`, and `nil` are the
*literally identical* combinator `A`. Church encoding *is* this overloading. Role is
**context, not content** — fixed by what the term is applied to (or what a typed
operator upstream forced it to be), never by inspecting it.

Two further truths shape the design:

- **Plain HM inference can't disambiguate roles.** The principal type of `A` is
  `a→b→b`; every Church numeral shares `(a→a)→a→a`; `nil`/`0`/`False` unify. Inferred
  types give *structural shape*, not *semantic role*. Disambiguation needs a **seed**:
  a player annotation, or a typed operator (`Succ : Int→Int`, `cons : a→[a]→[a]`).
- **Simple typing rejects the best birds.** Anything with self-application — `M`
  (`x x`), `L` (`x(y y)`), `U`, `Y` — has *no* simple type. A type-*checking gate*
  would lock out half the zoo and kill the "it's all the same stuff" magic. The
  fixpoint `Y` being untypable is *the lesson*, not an error to forbid.

**Conclusion: type is a lens you point at a tree, not a gate that blocks building.**

## Decision

Type is a forced *reading* layered on the existing value reader, seeded by the
current hotbar page. Two pieces, both opt-in, neither blocking the sandbox:

1. **`readAs(ty, n)` — a forced reading (built).** The re-folder ships an
   encoding-directed value reader (`src/core/value.ts: readValue`, ADR 0002 Phase 1)
   that *auto-discovers* an encoding and **defers** the trivial values that coincide
   with bare combinators (`0`/`[]`/`false` are all `A`, `1` is `I`, `true` is `K`),
   showing the combinator name instead. Typing splits that reader into pure
   structural *matchers* (`matchNumeral`/`matchList`/`matchPair`/`matchBool`, no
   policy) plus the auto-discovery `readValue`, then adds `readAs(ty, n)` in
   `src/core/types.ts`: given a tag it runs that one matcher and renders even the
   trivial cases — so the tag **resolves** the ambiguity `readValue` defers (`A`→`0`
   under `Int`, →`[]` under `List`, →`false` under `Bool`; `K`→`true`, `I`→`1`).

   **The seed is the hotbar page** (`Arithmetic`→`Int`, `Booleans`→`Bool`,
   `Lists`→`List`; `Programs`→auto). The read-out forces the page's reading and
   falls back to the combinator re-folder / raw sexp on a non-fit, so the *same*
   `A` reads as `0`/`false`/`[]` depending only on which tab you are on. No new UI —
   the tabs are the lens.

   Reading is recursive and returns a typed `Val` tree (rendered by the shell),
   which buys two things a flat reader can't: **propagation** — a list is
   homogeneous, so one unambiguous element resolves its ambiguous siblings
   (`[2, 0]` reads, the `0` was a deferred bare `A`); and **routing** — a non-data
   component falls to the combinator re-folder instead of sinking the whole
   structure (`cons 2 (cons B nil)` → `[2, B]`). Pairs are heterogeneous, so they
   route but never propagate (`(2, 0)` → `(2, A)`). This is the type-guided
   re-sugaring: type (page seed + intra-structure inference) routes each part to a
   value reading or a combinator name.

2. **Simple-type inference lens (future).** HM over the SKI/named tree
   (`K:a→b→a`, `S:(a→b→c)→(a→b)→a→c`; named birds get their derived type). Returns the
   principal type *or* "untypable (self-application)". Powers a badge: "this bird is
   `(a→a)→a→a`" vs "no simple type — that's the price of recursion." Independent of
   (1); not yet built.

A typed page replaces the per-node *annotation* seed considered earlier: reduction
discards the typed `Succ`/`cons` nodes, so a raw normal form carries no type — a
page-as-mode is the cheapest seed that needs no per-node state and no reducer change.

## Consequences

- Core stays pure/deterministic (ADR 0001): `readAs`/`readValue` = run-on-eliminators
  + read; inference (future) = unification. No Pixi/DOM/time. The matchers are shared
  by both the auto reader and the forced reader — one structural definition, two
  policies.
- We never reject a build for being ill-typed. Worst case a page reads "doesn't fit"
  and falls back to the auto value / combinator re-folder / raw sexp — information,
  not a wall.
- Verified end-to-end (headless units + a browser E2E driving the page seam): `A`
  reads as `A`/`0`/`false`/`[]` across the four pages.

## Considered and rejected

- **Type-checking gate** (block ill-typed snaps): kills the magic, locks out
  `M`/`Y`/`L`. No.
- **Infer roles bottom-up from the term**: impossible — roles aren't in the term.
- **Dependent/role types per encoding**: over-engineered for a sandbox; the seed +
  propagation model gets the same UX for a fraction of the machinery.
