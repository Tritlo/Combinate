# ADRs

Index of architecture decisions. **Small decisions** live inline here as mini-ADRs
(a paragraph or two — title, then context + decision + why). **Bigger decisions** get
their own file under `docs/adr/NNNN-slug.md` and are linked from here.

Keep it terse and honest — short enough that people actually read it.

## 1: Functional core, imperative shell (hexagonal)
[docs/adr/0001-functional-core-imperative-shell.md](adr/0001-functional-core-imperative-shell.md)

## 2: egg-via-WASM re-sugarer
[docs/adr/0002-egg-wasm-refolder.md](adr/0002-egg-wasm-refolder.md)

## 3: Typing — a decoder/lens, not a gate
[docs/adr/0003-typing-as-a-lens-not-a-gate.md](adr/0003-typing-as-a-lens-not-a-gate.md)

## 4: Data uses MicroHs's Scott encoding, not Church
[docs/adr/0004-scott-encoding-for-data.md](adr/0004-scott-encoding-for-data.md)

## 5: Shareable permalinks, golf challenges, and sonification
[docs/adr/0005-shareable-state-golf-sonification.md](adr/0005-shareable-state-golf-sonification.md)

## 6: KISS authoring — Define, then one-hole Abstract
[docs/adr/0006-kiss-authoring-define-abstract.md](adr/0006-kiss-authoring-define-abstract.md)

## 7: In-browser MicroHs Haskell→combinator compiler
[docs/adr/0007-microhs-in-browser-compiler.md](adr/0007-microhs-in-browser-compiler.md)

## 8: DuckDB-WASM for local storage
[docs/adr/0008-duckdb-wasm-storage.md](adr/0008-duckdb-wasm-storage.md)

---

<!-- New mini-ADRs below. Fill these in (brainstorm the design with Codex) as the
     work in TODO.md lands. Keep each to 1-3 short paragraphs. -->

## 9: Optimization settings modal
**Status:** Accepted (Codex consensus).

Context: the two reduction optimizations — `Optimize (rule steps)` (`fastMode`: reduce a
saturated named combinator by its catalog rule) and `Graph reduction (DAG)` (`shareMode`:
call-by-need sharing) — were loose toggles in the Reduce menu. Native-value toggles (ADR
10) want a home too.

Decision: a standalone System-1 settings modal `src/view/optimize.ts`, mirroring
`view/fluff.ts` (paper/ink chrome, Mac checkbox rows, localStorage, light/dark). **No
master switch** — unlike Fluff's playful layer, optimizations are independent
capabilities (and already separate `optimize`/`graph` fields in permalinks). Opened from
`Reduce ▸ Optimizations…`; the two loose menu toggles are removed.

Why this shape: route **every** read/write through one explicit setter
(`isOpt`/`setOpt`/`onOptChange`), so the persisted modal state is the single source of
truth and the three other consumers stay in agreement — permalink restore
(`applyModes`), the `__combinate.fast/.graph` dev hooks, and **GraphReducer
invalidation** (a grapher bakes `fast` at construction, so changing `rules` must clear
live graphers; changing `graph` reschedules the focused tree). `onOptChange` carries the
changed key so the shell does exactly the right invalidation and nothing more. Build it
standalone now; the shared-modal extraction is deferred to ADR 12 (avoid premature
abstraction). Default off = today's exact behaviour.

## 10: Native values (opt-in evaluation)
**Status:** Proposed — _to be written with Codex (TODO §2)._

Context: Combinate reduces data structurally (Scott per ADR 4, Church in the Quest),
so arithmetic is O(n)/op and gcd/factorial blow the step budget. Decision (TBD):
opt-in toggles (native numbers / lists / booleans / chars) that evaluate recognised
value-subtrees natively, with the hard constraint that a native value round-trips to
the exact pure tree (pure-ι semantics stays the default ground truth; toggling off,
permalinks, and the Zoo probe must be unaffected). Records where the fast path lives
and how it stays a single semantics, not two.

## 11: Kernels / FFI
[docs/adr/0009-kernels.md](adr/0009-kernels.md) — _to be written with Codex (TODO §3); the bigger one._

A MicroHs-style mechanism binding a named combinator to a native JS "kernel"
(primitive op), generalising native values. **Pure kernels only for now** — a kernel is
a pure function of its evaluated arguments, no IO/effects (effectful FFI is a possible
future, out of scope). Full ADR because it's load-bearing and larger; spike first.

## 12: Reorg — ports & adapters, shared modal base (refactor)
**Status:** Proposed — _to be written with Codex (TODO §5)._

Context: the codebase is drifting; some side-effecting concerns leak into `core/`, and
4-5 System-1 modals each rebuild the same chrome (repeating bugs: blurry text from
fractional pixels, scroll clamping). Decision (TBD): push ADR 1 deeper into **ports &
adapters** — the pure core depends only on injected port interfaces (we already have
`Store`; add renderer/sound/wasm/persistence as earns-its-keep), the shell wires the
concrete adapters (Pixi, etc.). Within that, a shared `Modal` base / `SettingsModal`
adapter so a chrome fix lands once. Behaviour-preserving pass.
