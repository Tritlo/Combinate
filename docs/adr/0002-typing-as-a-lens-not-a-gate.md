# 2. Typing: a decoder/lens, not a gate

**Status:** proposed

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

Add a pure `src/core/types.ts` to the functional core with two *independent*
capabilities, both opt-in, neither blocking the sandbox:

1. **Type-tagged decode/encode (high value).** Given a type tag (`Int | Bool |
   List<T> | Pair`) and a normal form, run the term on canonical typed eliminators
   and *read* the result into a real value (`number | boolean | array`) — and the
   inverse (literal → canonical tree). This is "probe, but read the answer instead of
   matching it." Powers: native rendering ("you built **2 + 3 = 5**"), numeral/list
   literals, value entry.

2. **Simple-type inference lens (conceptual value).** HM over the SKI/named tree
   (`K:a→b→a`, `S:(a→b→c)→(a→b)→a→c`; named birds get their derived type). Returns the
   principal type *or* "untypable (self-application)". Powers a badge: "this bird is
   `(a→a)→a→a`" vs "no simple type — that's the price of recursion."

**Annotations as seeds** tie them together: the player tags a leaf/operator, the tag
propagates through application + known operators, and *that* provenance is how "this
`A` is a `0`" gets decided. A **typed-mode toggle** re-skins the canvas live (Int
mode: `A`→`0`, `Succ`→`+1`; Bool mode: `K`→True, `C`→Not) — the PAGES aliases applied
to the actual tree under a chosen lens.

## Consequences

- Core stays pure/deterministic (ADR 0001): decode = run-on-eliminators + read;
  inference = unification. No Pixi/DOM/time.
- We never reject a build for being ill-typed. Worst case a lens says "doesn't read
  as Int," which is information, not a wall.
- Scope is sliceable: (1) and (2) are independent; ship decode-Int first.

## Considered and rejected

- **Type-checking gate** (block ill-typed snaps): kills the magic, locks out
  `M`/`Y`/`L`. No.
- **Infer roles bottom-up from the term**: impossible — roles aren't in the term.
- **Dependent/role types per encoding**: over-engineered for a sandbox; the seed +
  propagation model gets the same UX for a fraction of the machinery.
