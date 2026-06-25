# refold — egg-based re-sugarer (PLAN.md Phase 2)

Folds a combinator term (SKI/ι form) back to its most-named reading, e.g.
`S (K S) K → B`. Used by the app's **refold lens** (the read-out shows the folded
form when the lens is on). Display-only: it never changes reduction or discovery.

## How it works

- `src/lib.rs` — a first-order [`egg`](https://crates.io/crates/egg) e-graph.
  Language is binary application (`@`) over symbol leaves. Every catalog law is a
  **bidirectional** rewrite; a cost function makes raw ι/S/K expensive and named
  birds cheap, so extraction returns the most-folded equivalent. Hard node / iter
  / time limits keep folding rules from blowing the graph up.
- `src/rules.txt` — **generated** from `src/core/catalog.ts` (the single source of
  truth) by `scripts/gen-rules.ts`. Do not edit by hand.
- Compiled to wasm and loaded lazily by the shell (`src/app.ts`); the pure
  `Node ⇄ egg s-expr` boundary lives in `src/core/refold.ts`.

## Regenerate + rebuild

From the repo root, after changing the catalog or the rules:

```sh
npx tsx scripts/gen-rules.ts                       # catalog → crates/refold/src/rules.txt
cd crates/refold
wasm-pack build --target web --out-dir pkg --release
```

The built `pkg/` is committed so CI (`npm run build`) bundles it without a Rust
toolchain. Quick local sanity check of folding quality (native, fast):

```sh
cd crates/refold && cargo run --release --example probe
```

## Known limitation

egg re-sugars *assembled* combinator structure well (`S(KS)K → B`), but cannot
collapse **eta-equivalent** forms to their simplest name (`S K K`, behaviourally
`I`, folds to a sound-but-quirky `M2 K`) — that needs extensionality, which
first-order e-matching does not have. The TS guard only shows a folding when it
is strictly simpler than the input, so the lens never makes a term *less*
readable.
