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
**Status:** Accepted (Codex consensus).

Context: Combinate reduces data structurally (Scott per ADR 4), so a catalog arithmetic
op recurses O(n) — slow for big computations (notably Haskell-panel programs, ADR 7).

Decision: **Architecture B — a reducer-local peephole, no new `Node` kind.** Extend the
existing optimize seam (the `fast`-mode saturated-named-`comb` hook in `reduce.ts`
`redexAt` and `graph.ts` `contract`): when a **whitelisted saturated catalog op**
(`(+)`,`(-)`,`(*)`,`(==)`,`(<)`,`cons`,`<>`,`map`,`not`,`and`,…) is applied to args that
the `value.ts` matchers recognise as values, and the matching native toggle is on,
compute natively and **emit the canonical pure tree immediately**. No native value ever
escapes the reducer — so the round-trip invariant holds *by construction*: permalinks
(`toEgg`), the behavioural probe, the type/read lenses, and toggling-off all keep seeing
ordinary pure terms. The native flags thread through the reducer like `fast` does (the
pure core never imports the view toggle); default off = today's exact reduction.

Implemented (`core/native.ts`): **numbers** (`(+) (-) (*) (==) (/=) (<) (<=) (>) (>=)
compare`), **lists** (`<> map concat`), **booleans** (`not and or`) — each a toggle.
Each op mirrors its catalog rule's forcing (`(+) a n = Succ^a n` never forces `n`;
`(*) 0 _ = 0`; `[] <> ys = ys`; `and False _ = False`), so native never reduces an
operand the pure rule wouldn't. The discovery check (`nativeOpArity`) is cheap; the
match happens in the redex's `build` (so `firingRule`/existence checks don't pay for it).
A 490+17-case grid asserts native output == pure output structurally. Numeral output is
capped (`MAX_NAT`) because a Scott numeral is a depth-N tree the recursive reducer walks.

**No native `chars` toggle:** a Char is a Scott numeral (codepoint), so char comparison
is already the number ops — a separate char peephole would be redundant. Rendering a
char-list as a *string* is a read-lens concern (`types.ts`), not a reducer peephole;
left as a possible follow-up.

**Scope / honest limit (Codex):** this is a **catalog-Scott (named-op)** fast path. It
does **not** speed up the SKI-Quest's **Church** arithmetic — gcd/factorial there are
compiled to raw S/K/I with no named op to intercept, so the reducer can't see them. The
Quest's `gcd` (TODO §4) therefore stays an engine limit until **kernels** (ADR 11) or a
separate Church abstract-interpreter lands. Native values v1 helps the main sandbox and
Haskell-compiled programs, not raw-combinator Church terms.

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
