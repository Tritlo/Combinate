# 3. Typing: a decoder/lens, not a gate

**Status:** accepted — but the **concrete Church encodings below are superseded by ADR 0004**
(data now uses MicroHs's Scott encoding). The lens design is unchanged; only the bare-combinator
mapping flips: the ambiguous leaf is now the Kestrel `K` (= `0`/`[]`/`false`), not `A`, and
`true` = `A`. Read every "`A` is `0`/`[]`/`false`" below as "`K` is `0`/`[]`/`false`".

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

Type is a forced *reading* layered on the structural value matchers, seeded by the
current hotbar page. Two pieces, both opt-in, neither blocking the sandbox:

1. **`read(n, hint)` — type-guided reading (built).** `src/core/value.ts` supplies
   policy-free structural matchers (`matchNumeral`/`matchList`/`matchPair`/
   `matchBool`); `src/core/types.ts` owns the one reading policy. With no hint it
   auto-discovers unambiguous values and defers the bare Kestrel `K`, because under
   the Scott encoding `0`/`[]`/`false` are literally the same term. A hint runs the
   matching decoder directly, so `read(K, "Int")` is `0`, `read(K, "List")` is
   `[]`, and `read(K, "Bool")` is `false`.

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

2. **Simple-type inference lens (built).** Hindley–Milner over the tree
   (`src/core/infer.ts`): `K:a→b→a`, `S:(a→b→c)→(a→b)→a→c` are hard-coded; named
   birds get a scheme inferred once from their SKI def and instantiated per use;
   `ι` uses its SKI form. Inferred on the *normal form* (so `ι ι :: a → a`,
   behavioural like the rest of the app). A failed unify (occurs check) → no simple
   type, so `M`/`L`/`U`/`Y` read "no simple type — the price of recursion" while
   `S`/`K`/`B`/`C`/`W` and the numerals get textbook types. A "type" rail toggle
   badges it onto the read-out. Independent of (1).

A typed page replaces the per-node *annotation* seed considered earlier: reduction
discards the typed `Succ`/`cons` nodes, so a raw normal form carries no type — a
page-as-mode is the cheapest seed that needs no per-node state and no reducer change.

## Consequences

- Core stays pure/deterministic (ADR 0001): structural matchers = run-on-eliminators
  + read; inference = unification. No Pixi/DOM/time. Auto and forced readings share
  one `read` implementation rather than parallel public APIs.
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
