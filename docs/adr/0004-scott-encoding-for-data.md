# 4. Data uses MicroHs's Scott encoding, not Church

**Status:** accepted (supersedes the Church specifics in ADR 0003)

## Context

The catalog encoded data the **Church** (Boehm–Berarducci) way: numerals `n f x = fⁿ x`,
right-fold lists, `true = K` / `false = A`, Vireo pairs. MicroHs — the Haskell→combinator
compiler we want to import programs from (the MicroHs deep-dive) — compiles `data` to the
**Scott** encoding instead (`../MicroHs/src/MicroHs/EncodeData.hs`): a value is a *case on
itself*, applying the eliminator arm for its own constructor, in declaration order. For a
compiled MicroHs program (a sort over Peano `Nat`, say) to read back through our value
reader, the sandbox must speak the same encoding.

## Decision

Switch all algebraic data to Scott, matching MicroHs constructor-for-constructor:

- `Nat = Z | S Nat` → `Z = K`, `S p = λz s. s p` (Peano — MicroHs's `Int` is a runtime
  primitive with no combinatory form, so numbers are Peano naturals, the iota-films' choice).
- `[] | (:)` → `nil = K`, `cons h t = λn c. c h t`.
- `Bool = False | True` → `False = K`, `True = A` (= `K I`) — **swapped** from Church.
- pairs stay the Vireo `(x, y) = λf. f x y` (Scott's one-constructor/two-field encoding *is*
  the Vireo).
- `if c t e = c e t` (the Cardinal `C`).

The value reader (`value.ts` matchers + `types.ts`) peels Scott constructors one at a time.
The structural eliminators (`head`/`tail`/`uncons`/`null`/`Pred`) become trivial one-arm
reads — Scott's payoff, especially `tail` (the Church pair-shuffle is gone). The folds carry
no built-in recursion, so `map`/`<>`/`concat`/`(+)`/`(-)`/`(*)` recurse through the Sage `Y`;
they are **built, not discovered** (a recursive term sticks on the fresh-var probe, so it
never matches behaviourally).

## Consequences

- **The ambiguous bare leaf moves from `A` to `K`.** Under Scott, `0`/`[]`/`false` all
  coincide on the **Kestrel** `K` — the value every trivial case collapses onto — so a bare
  `K` is deferred and resolved by the hotbar-page tag or sibling propagation: exactly the
  ADR 0003 lens, just re-centred. `true` (= `A`) and numerals ≥ 1 are now *unambiguous* and
  read at any depth.
- **Numerals lose a uniform type.** Church numerals all shared `(a→a)→a→a`; each Scott
  numeral is a finite term with its own ad-hoc type (there is no uniform `Nat` type without
  recursion). The HM lens (ADR 0003) still returns *a* type for a concrete numeral — it just
  isn't shared across them; the general recursive shape and the `Y`-based folds stay
  untypable, on theme.
- **The Church bird-coincidences are gone.** `Not = C`, `And = X`, `Or = M` only held under
  `true=K`/`false=A`; Scott gets explicit `not`/`and`/`or` birds (`if` is still `C`). Mult/Exp
  were no longer the Bluebird/Thrush, so `(*)` became a `Y`-recursion and Exp was dropped.
- Verified headless: numerals, lists, bools, pairs read back; `head`/`tail`/`null`/`Pred`/
  `uncons` and `not`/`and`/`or` reduce correctly; the `Y` folds (`+ - *`, map, `<>`, concat)
  reduce on concrete data; `recognize` on normal gameplay trees stays sub-millisecond.

## Considered and rejected

- **Bend MicroHs to Church** (author imported programs with hand-rolled Church encodings so
  the existing reader is untouched). Rejected: Scott is what MicroHs *actually* emits, so
  meeting it there keeps **one** encoding across the sandbox and the imported programs (no
  second reader), and the structural-op simplification (a trivial `tail`!) is a real bonus.
  The cost — folds need `Y`, numerals lose a uniform type — is acceptable and even on theme.
