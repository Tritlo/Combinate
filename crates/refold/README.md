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

## Behavioural pre-pass

egg reasons *syntactically* — it re-sugars assembled structure (`S(KS)K → B`) but
cannot collapse **eta-equivalent** forms (`S K K`, behaviourally `I`). So the
re-folder runs a **behavioural pre-pass first** (`recognizeDeep` in
`src/core/refold.ts`): it recursively applies the existing `recognize` probe —
which *is* extensional (it reduces the term applied to fresh variables) — to name
every single-combinator subterm, including the eta cases egg misses. Its residual
is then handed to egg for any remaining multi-combinator folds. The pre-pass is
pure TS, so the lens also works (behaviourally) if the wasm fails to load.

## Known limitation

Neither stage reads **data values** — a Church numeral or list is not a single
catalog combinator, so `[2, 2]` is not recovered here; that is the encoding-
directed value reader (PLAN.md Phase 1). The TS guard only shows a folding when
it is strictly simpler than the input, so the lens never makes a term *less*
readable.
