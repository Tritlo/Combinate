# [07] More Haskell compile examples: `2 < 3` and `quicksort [3,1,2]`

The user's running examples; also give bigger trees for the progress bar [02] + 3D wow [06].

## Findings
- `src/view/mhs/examples.ts` curates examples (arith/inc/sum/filter/rev/fac); each has Haskell
  source + a pruned, vendored `.comb` dump (`public/vendor/mhs/examples/<name>.comb`), regenerated
  by `scripts/gen-mhs-examples.ts` with the GHC-built `gmhs` (primitive-free programs only).

## Plan
- Add two examples:
  - **`lt`** — `2 < 3` (a Bool result; small, demonstrates comparison → reads "True").
  - **`quicksort`** — `quicksort [3,1,2]` (a list result; a meaty tree — great for the 3D view
    and the progress bar). Author a primitive-free quicksort in the curated Prelude subset.
- Add to `examples.ts` (source + metadata + read-as type), regenerate the `.comb` dumps via
  `gen-mhs-examples.ts`, and re-vendor (upload to the vendor-assets release per CLAUDE.md).
- Verify each compiles primitive-free and reduces to the expected value.

## Council questions
- Quicksort phrasing within the curated primitive-free Prelude (no Int primitives beyond the
  Scott-encoded ops) — confirm it compiles + isn't pathologically huge.

## Council verdict (consensus)
- Feasible + low runtime risk (net data, no code-path change). `2 < 3` is trivial (the `filter`
  example already exercises `<` + Scott Bool → reads "True"). `quicksort [3,1,2]` is feasible in
  the existing primitive-free subset (reuses filter / `<` / append / cons / nil) and expands to a
  meaty tree — the point (good for 3D + the progress bar).
- **Verify AFTER regenerating the dumps**, not from source syntax: assert each `.comb` dump is
  primitive-free + size-bounded (set a ceiling before committing quicksort), and smoke-check the
  reduced result (Scott `True`; the sorted list `[1,2,3]`). Risk is only in the gen + vendor step.
