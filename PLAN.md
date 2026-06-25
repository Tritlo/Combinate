# PLAN — Re-folding reduction results into readable values

Branch: `refolding` (worktree). Goal of this work: when a tree reduces to a big
raw ι/SKI normal form, show it as a **compact value** instead.

```
map succ (cons 1 (cons 1 nil))   →   reduces to   ((S ((S (K S)) …    (unreadable)
                                      we want      [2, 2]
```

## Why it happens (context for a fresh session)

- Combinator `def`s are pure SKI (bracket-abstracted from their laws). Reduction
  **inlines everything to ι/SKI to compute**, so the result behaves like
  `cons (succ 1) (cons (succ 1) nil)` but contains no `cons`/`succ` nodes.
- `recognize` (`src/core/probe.ts`) only matches the *whole* term against a
  *single* catalog law. `[2,2]` is not one combinator, so nothing fires and the
  raw SKI is shown.
- The read-out is `exprOf` in `src/app.ts` (an s-expression of the focused
  tree's `node`); the canvas tree is rendered by `src/view/tree.ts`.

This is the **re-sugaring / folding** problem: recover structure from a normal
form. Two engines are planned; **do Phase 1 first.**

## Decision (from the design discussion)

- **Display form: compact values.** Numerals as digits (`2`), lists as
  `[a, b, c]`, booleans as `true`/`false`, pairs as `(x, y)`. (Not constructor
  form like `cons (succ 1) …`.)
- **Display-only.** Never change reduction or recognition. The logical `node`
  stays the raw normal form; we only compute a nicer string/picture from it.
- egg-via-WASM is allowed for the general engine (Phase 2) — do **not** hand-roll
  an egraph in TS.

## The Church encodings in this codebase (the reader must match these)

From `src/core/catalog.ts`:

- **Numerals** (Church): `n f x = fⁿ x`. `0 = A` (= `K I`), `1 = I`,
  `Succ n f x = f (n f x)`.
- **Lists** (right fold): `cons h t = λc n. c h (t c n)`, `nil = λc n. n = K I = A`,
  `fold = V`. So a list is `λc n. c h₁ (c h₂ (… n))`.
- **Booleans**: `true = K`, `false = A` (= `K I`). `if = I`.
- **Pairs** (Vireo): `V x y f = f x y`; `fst = λp. p K`, `snd = λp. p A`.

**Irreducible ambiguity:** `K I` (= `A`) is simultaneously `0`, `[]`, `false`,
and `nil`. A bare `A` cannot be uniquely read. Disambiguate by structure where
possible (a non-empty list / a numeral ≥ 1 / a 2-arg pair are unambiguous);
for the trivial leaf, pick a documented default or fall back to the name `A`.

---

## Phase 1 — encoding-directed value reader (TS, recommended, ship first)

A pure, bounded "value reader" — the *inverse* of `TreeView.expand()`. It probes
the term as each known encoding (just like `probe` applies a term to fresh free
variables and inspects the normal form), recursing on sub-values.

### New file: `src/core/value.ts` (pure — no Pixi/DOM)

```ts
export function readValue(n: Node, depth = 0): string | null
```

Returns a compact string, or `null` if `n` isn't a recognizable value. Uses
`normalize` (`./reduce`) and `freeVar` (`./term`). A small structural matcher on
the normal form (compare with the `structKey` walk in `probe.ts`).

Algorithm (try in this order; first non-trivial match wins; bound everything):

1. **List** — apply to two fresh distinct vars `c`, `n`; `normalize` (cap). If
   the NF is a right-fold spine `app(app(c, hᵢ), rest)` repeated, ending in `n`:
   read each `hᵢ` with `readValue(hᵢ, depth+1)` and return `[v₁, …, vₖ]`.
   (NF `= n` → `[]`.) Cap list length (~64) → else `[…]`.
   - Numerals do **not** false-match: `Nⁿ` applied to `c,n` gives `c (c (… n))`
     where `c` has **one** arg per level, but a cons spine needs `c` with **two**
     (head + rest), so the shape check rejects numerals. Good.
2. **Numeral** — apply to two fresh `f`, `x`; `normalize`. If NF is a left chain
   `f (f (… x))` (every fn is `f`, innermost arg is `x`), return the count.
   (`x` → `0`.) Cap (~9999) → else fall through.
3. **Boolean** — apply to two fresh `a`, `b`; if NF `= a` → `true`, `= b` →
   `false`.
4. **Pair** — apply to one fresh `f`; if NF `= app(app(f, x), y)` →
   `(readValue(x), readValue(y))`.
5. else `null`.

Bounds: `normalize` cap, max list length, max numeral, `depth ≤ ~8`. Any cap hit
or `null` from a sub-value → bail to `null` (caller falls back to the raw sexp).

### Wire into the shell (`src/app.ts`)

- The top read-out currently shows `exprOf(focus.node)`. Change it to prefer the
  value: `readValue(focus.node)` if non-null (e.g. show `= [2, 2]`), else the
  existing sexp. Keep it cheap — only recompute when `focus.node` changes (it
  already diffs on `lastExpr`).
- Optional follow-up (not MVP): a small "value" badge on the canvas tree, or
  show both `raw` and `= value`. Decide after seeing Phase 1.

### Tests (tsx smoke, like the existing ones)

- Build `map succ (cons 1 (cons 1 nil))` from the catalog `def`s, `normalize`,
  assert `readValue` → `"[2, 2]"`.
- Numerals `0,1,5`; nested list `[[1],[2]]`; `true`/`false`; pair `(1, 2)`;
  empty list `[]`; a non-data term (e.g. `S`) → `null` (falls back to sexp).

### Cost / risk

Low. One pure file + a small read-out change. No new toolchain. Covers exactly
the data players compute. **This alone satisfies the stated example.**

---

## Phase 2 — general re-sugarer via egg (Rust → WASM), optional

For folding *arbitrary* combinator expressions (not just data values) back to
named form. Heavier; only pursue if Phase 1 proves insufficient.

### Approach

- Rust crate (`crates/refold/`) using [`egg`](https://crates.io/crates/egg).
- `Language`: `App([Id;2])` + named constants (`S K I B C … cons succ`) as
  symbols. (Combinators are nullary constants; application is binary; pattern
  vars `?x ?y ?z` range over subterms — this is **first-order**, so e-matching
  is standard, no binders.)
- Rules: each combinator equation **bidirectionally** where sound — reduction
  (`S ?x ?y ?z => (?x ?z)(?y ?z)`, …) and folding (`?x (?y ?z) => B ?x ?y ?z`,
  cons's NF pattern `=> cons ?h ?t`, …).
- **Explosion control:** folding rules fire everywhere on SKI; cap hard with
  `Runner::with_node_limit` + `with_iter_limit`.
- **Extraction:** custom cost (named combinator ≪ App ≪ ι-expansion) so the
  extracted form is the most-named / fewest-ι. Resolves ambiguity
  (`2` vs `succ 1`) via the cost weights.
- Boundary: pass the term as a **bit-code / s-expression string**; parse in
  Rust; return the folded s-expression; parse back to a `Node` in TS.

### Build + integration

- `wasm-pack build --target web` → `pkg/`. Vite via `vite-plugin-wasm`
  (+ top-level await) or manual `init()`.
- Async init at startup; expose a `Refolder` port: `refold(term): term`.
- Bundle adds a few hundred KB of wasm — gate behind a setting/flag.

### Risks

Toolchain (Rust + wasm-pack in CI/Pages build), egraph blow-up (needs limits),
ambiguity (cost tuning), bundle size. Genuinely a multi-session effort.

---

## Architecture (keep it hexagonal)

- The value reader is a **pure core** function (`src/core/value.ts`) — no Pixi,
  no DOM. It's a port: "given a term, give a readable rendering."
- egg-WASM (Phase 2) is a **driven adapter** behind the same port, wired by the
  shell (async init). `src/core/` stays Pixi/DOM-free —
  `grep -rn "pixi\|window\.\|document\." src/core/` must stay empty.

## Definition of done (Phase 1)

- `map succ (cons 1 (cons 1 nil))` shows `= [2, 2]` in the read-out (verified
  headless), raw sexp still shown for non-data terms.
- `readValue` is pure, bounded, has smoke tests, `npm run typecheck` + build
  clean. Commit on `refolding`; merge to `main` separately (CI deploys to Pages).

## Open questions for the session

1. Read-out: replace the sexp with the value, or show both (`raw  = value`)?
2. Bare `A`/`KI` default reading — `0`, `[]`, `false`, or show the name `A`?
3. List sugar for elements that aren't clean values — show `?` or the raw head?
4. Do Phase 2 at all, or is Phase 1 enough?

## Pointers

- `src/core/term.ts` — `Node`, `app`, `freeVar`, `decode`, `iotaTreeFrom`, `IOTA_ID_SPAN`.
- `src/core/reduce.ts` — `normalize(node, cap)`, `step`.
- `src/core/probe.ts` — the apply-to-fresh-vars + `structKey` pattern to copy.
- `src/core/catalog.ts` — `CATALOG`, the encodings, `iotaTreeOf`, `IOTA_BITCODE`.
- `src/app.ts` — `exprOf` and the read-out ticker (where to surface the value).
- Verify headless with the cached Playwright chromium + the `__combinate` dev seam.
