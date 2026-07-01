# Combinate — domain glossary

The shared language of the project. A glossary, not a spec — terms and what they
mean, devoid of implementation detail. Architecture decisions live in `docs/adr/`.

## The calculus

- **ι (iota)** — the single universal combinator the whole sandbox is built from
  (`ι = λf. f S K`). Every program is a binary tree whose only leaf is ι.
- **Combinator / bird** — a named function with no free variables (Smullyan's bird
  names: S, K, I, B, C, W, …). Birds are *discovered*, not primitive — they all
  reduce back to ι.
- **Application tree** — the binary tree the player builds: leaves are ι, internal
  nodes are application. The whole object of the game.
- **Reduction** — rewriting an application tree toward its normal form by the
  rewrite rules (`ι x → x S K`, `S x y z → x z (y z)`, …). Normal-order.
- **Normal form** — a tree with no redex left; "the answer."

## The loop

- **Discovery** — when a built tree's *behaviour* matches a known combinator's law,
  the player unlocks that combinator (it joins the hotbar). Behavioural, not
  syntactic — `ι ι` *behaves as* `I` even though it is not the glyph `I`.
- **Law** — a combinator's defining equation, stated behaviourally (`K x y = x`).
- **The Zoo** — the catalogue of all combinators with their lore, lit progressively
  as they are discovered (a Pokédex).

## Readings (never gates)

- **Lens** — a *display-only* reading layered over a tree; it never blocks or
  changes a build. Type is a lens, not a gate; untypable birds are celebrated.
- **Value reader** — a lens that reads a data normal form back to a value
  (`[1, 2, 3]`, `4`, `true`).
- **Encoding** — how data (naturals, lists, booleans, pairs) is *represented* as
  combinators. Combinate uses the **Scott** encoding (matching MicroHs).
- **Optimize mode** — an opt-in reading of *reduction itself*: reduce named
  combinators by their rule rather than grinding everything down to raw ι/SKI.

## Sharing, golf, and authoring

- **Permalink** — a shareable encoding of a tree + active modes; the link *is* the
  state. The unit of sharing.
- **Challenge (golf)** — a goal with a target (a value or behaviour to reach) and a
  best-metric (fewest ι, fewest steps). A *solution* is a permalink. Turns
  "discover by accident" into "discover on purpose."
- **Leaderboard** — a ranking of solutions to a challenge.
- **Verify-by-replay** — the leaderboard trust model: an entry is a re-runnable
  solution, so any client re-verifies it (the reducer is pure and fast) and drops
  fakes. The shared store needs no trusted validator.
- **Authoring** — building your own combinators rather than only discovering them.
  - **Define** — name a tree you built; it becomes a hotbar block (same object as a
    discovery).
  - **Abstract** — pull a variable (a *hole*) out of a tree, turning a concrete tree
    into a combinator.
- **The encodable fragment** — the slice of Haskell with a combinatory form: Scott
  data, numbers (Scott naturals), and `Char`/`String` (ASCII codes as naturals).
  Everything else (`IO`, FFI, `Float`) is the **primitive wall** — no ι form.
- **The wow** — typing a real Haskell program and watching it compile to ι and
  reduce, live, in the sandbox.

## Quest, kernels, and performance

- **Quest / SKI-Quest** — Combinate's main game: a chapter/stage progression of
  little SKI-expression puzzles (adapted, with permission, from Konstantin
  Uvarin's SKI-Quest), run on Combinate's own reducer.
- **Kernel** — a named combinator bound to a pure native JS fast path (ADR 11):
  same input/output contract as reducing the combinator's law, but computed
  directly instead of grinding through the rewrite. Native values (below) are
  built-in kernels.
- **Native values / "Primitives"** — an opt-in reducer peephole (ADR 10): when a
  saturated named op (`(+)`, `<>`, `not`, …) is applied to recognised values,
  compute the result natively and emit the canonical Scott tree, instead of the
  full structural reduction. Labelled **Primitives** in the UI.
- **Turbo** — the resident wasm reduction engine (`crates/reduce`, ADR 16/19): a
  call-by-need graph reducer with native kernels + catalog rules, for reducing big
  trees (e.g. compiled Haskell programs) in about a second instead of minutes.
- **The 3D sphere view** — a secondary, read-only 3D visualization (packed-sphere
  layout, ADR 21) of the focused tree; the core experience stays 2D.
- **H-tree layout** — a compact 2D/3D layout for big trees: a nested square (or
  cubic) antenna whose arms shrink with depth, laid out incrementally in
  O(changed) per reduction step (ADR 18).
