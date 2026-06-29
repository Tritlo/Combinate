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
[docs/adr/0009-kernels.md](adr/0009-kernels.md) — **Accepted** (Codex consensus).

A MicroHs-style mechanism binding a named combinator to a native JS "kernel"
(primitive op), generalising native values into one registry + reducer hook. **Pure
kernels only** — a deterministic function of its evaluated args, no IO/effects; emits the
canonical pure tree, falls back to the catalog rule. Native numbers/lists/booleans become
registered kernels (thin adapter). Church helpers extracted to `core/church.ts`; a Church
`cmod` kernel is the route to unblock gcd (not a `gcd` cheat kernel).

## 12: Reorg — shared modal base (refactor)
**Status:** Accepted (Codex consensus).

Context: the System-1 DOM modals (Fluff, Optimize, Quest, About) each re-inject the same
chrome — `@font-face`, the paper/ink palette, `root/card/titlebar+close/body`, backdrop +
ESC close, `onThemeChange→applyPalette` — so a chrome fix (blurry text from fractional
pixels, scroll clamping) has to be made N times.

Decision: a behaviour-preserving **`view/modal.ts`** — a `Modal` base owning *only* the
chrome (`.md-*` classes, the font/style injected once, open/close/toggle, backdrop/ESC,
the scroll fix `overflow-y:auto; min-height:0`, palette + an `extraVars` hook, a
`--md-width` override), exposing a protected `body` and an `onOpen()` refresh hook; plus a
thin `SettingsModal` for the checkbox-list ones. Subclasses keep their content **and their
own store logic** (`isFluff`/`isOpt`/listeners) and their body CSS (`.ms-*`/`.ab-*`, so no
selector collisions).

This pass migrates **Fluff, Optimize, and About**. **Quest** is a follow-up (it was just
extended with the tracker's `onAdvance`/getters; its gold accent uses the `extraVars`
hook when migrated). Zoo/Golf (Pixi `Graphics` overlays) and the MhsPanel (GitHub-styled,
not System-1) are intentionally out.

**Scope correction (Codex):** TODO §6's "ports & adapters — push core to depend on
renderer/sound/wasm port interfaces" is **rejected** — ADR 0001 deliberately chose
shell→core with *no* formal port interfaces for this single-UI frontend, and `Store` is
the one real port that earns its keep. The genuine impurity to fix is narrow:
`QuestProgress` writes `localStorage` inside `core/quest.ts` despite its "pure" header —
hoist that persistence to the shell later. **`app.ts` extraction** (1355 lines: transport,
auto-reduce, dev seam, menu wiring) is real but needs its own boundary decisions — a
follow-up, not this pass.

## 13: Quest Mode — tracked-quest side panel
**Status:** Accepted (Codex consensus).

Context: the SKI-Quest objective lives only inside the Quest modal (under Special); while
you build on the canvas the goal is out of sight, and the modal is easy to miss.

Decision: a persistent, glanceable **tracked-quest HUD** (`view/questTracker.ts`) on the
right rail — WoW-style — reflecting the *current* stage: chapter eyebrow, stage title, the
objective (last `intro` line, HTML-stripped, with a fixed fallback), `stage i/N · chapter
c/C` progress, and the unlock reward; the whole card opens the full modal. A **read-only
view of existing state** — no second copy of the goal logic.

Why this shape (Codex):
- **Ownership stays in `QuestPanel`.** It already privately owns `QuestProgress` and is the
  only path that advances it (`progress.check` in `onNormalForm`). The tracker subscribes
  via a new `onAdvance(cb)` hook + reads `current()/location()/done`, and renders once
  initially (progress loads a persisted stage in its constructor, so the hook alone
  isn't enough). No hoisting — that would duplicate ownership for no goal-logic benefit.
- **Cut the modal's density**: no hint UI, no chapter step-dots, no story — just the
  objective. Those stay in the modal.
- **Default ON while unfinished, auto-hide at `done`.** Persist only the user's explicit
  hide (`View ▸ Track Quest`) and collapse prefs — not "unfinished ⇒ visible" itself.
- **Placement** `top: 72px; right: 16px; width: min(320px, calc(100vw − 32px))` — below
  the top HUD, clear of the transport bar (`innerWidth−18, 34`) and the top-center expr
  readout (`y=32`). Narrow screens collapse to a small tab. System-1 chrome (matches
  Fluff/Optimize/Quest; the shared-modal base is the later ADR 12), static DOM (no FPS
  cost).

## 14: Deep perf + reorg push (`reorg-perf`)
**Status:** Accepted (Codex consensus).

A perf cut across the app plus the `app.ts` extraction deferred in ADR 12.

**Perf — engine hot path.** `redexAt`'s fast/native scan re-collected the applied spine at
*every* recursion level, so checking a settled D-deep spine for normal form (the value-read
/ NF hot path, run on every edit) was O(D²). The head comb is unchanged down the function
spine, so a private `redexAtGo(..., headChecked)` skips the head re-scan in the
`fn`-recursion (built-in ι/I/K/S/def handlers stay outside it and still fire deep heads) →
O(D). Made correct-by-construction (Codex): kernels now receive exactly their arity and the
reducer reapplies extras (`reapplyExtras`), so `headChecked` can't skip a kernel that only
fires on an exact-arity prefix.

**Perf — rendering.** The per-frame edge draw cached each edge's endpoint `NodeVis` at index
time, dropping ~4 `objs` Map lookups per edge per frame. The floor is the `Graphics`
geometry + GPU upload — wasm can't help there (see below).

**Impurity (ADR 0001).** `QuestProgress` read/wrote `localStorage`; made pure — the starting
stage + a `persist` callback are injected by the view. `core/` is now 0 DOM/localStorage refs.

**`app.ts` extraction.** Codex order: ReadoutLens → ReductionController → (TransportBar) →
CanvasController, app.ts stays the composition root, no global `AppState` (that just renames
the tangle). Landed `ReadoutLens` (the focused-tree read-out + re-fold/type lenses),
`ReductionController` (the auto-reduce loop + transport state machine; Pixi flourish +
transport bar injected as callbacks), and `TransportBar`. app.ts 1416 → 1089. **CanvasController
(trees/focus/drag/snap/pan/pinch) is deferred** — Codex: it's the riskiest/most stateful;
split it (a `TreeCanvas` owner first) rather than lifting it all at once, and only after the
boundary is proven.

**wasm reducer — investigated, built, verified, *shelved*.** Spiked a Rust→wasm flat-arena
raw reducer (ι/I/K/S + def-unfold, defs imported from TS catalog — zero rule/kernel
duplication). Verified equivalent to the TS non-fast reducer (213/0 cross-check) and 42×
faster in isolation. **Not wired:** end-to-end (encode+wasm+decode) is only 2–3× on
already-sub-10ms terms — the JS codec dominates, and escaping it needs a wasm-resident term
(a second runtime + view rewrite, not an adapter). Heavy arithmetic/data already have native
kernels + graph sharing. Kept as a documented, cross-checked capability (`crates/reduce`,
`src/core/wasmCodec.ts`, `npm run check:reduce-wasm`); revisit only for a visibly-slow
(>100 ms) raw-reduction path. Full rationale + numbers: `docs/perf-spike-findings.md`.
**(Superseded by ADR 16 — the visibly-slow path appeared: big MicroHaskell programs.)**

## 16: Turbo — wasm resident reduction for big trees
**Status:** Accepted (Codex consensus).

Context: ADR 14 shelved the wasm reducer because the *per-call* codec floor capped it at
2–3× end-to-end. But big raw trees — a compiled MicroHaskell program applied to input —
reduce through thousands of steps where the TS persistent reducer is allocation/GC-bound
(measured: a 1801-node church-mul intermediate is 559 ms in TS) and one tween-per-step
playback is unwatchably slow (minutes). That's the visibly-slow path ADR 14 said to wait for.

Decision: a **resident wasm reduction** behind a "Turbo (wasm)" optimize toggle.
- **Resident session** (`crates/reduce` `Session`): the term + def trees live in linear
  memory, so the playback loop runs thousands of contractions per frame with no marshalling,
  snapshotting the current term out only for display — this escapes the codec floor (the
  reduction dominates; encode/decode amortise to ~0). `snapshot()` compacts the arena while
  preserving an immutable def-tree prefix (`def_len`) so `def_root` stays valid (Codex's trap).
- **Raw turbo, gated.** It does raw ι/I/K/S + def-unfold only (= TS non-fast mode); eligible
  only when rules/native/graph are all off, else the TS reducer runs. No rule/kernel port (no
  drift). The cross-check (`npm run check:reduce-wasm`) drives it: 213/0 + invariance 3/0.
- **Frame-budget playback** (`ReductionController` turbo path): cap steps/frame + a perceptible
  reflow gap → a big tree churns through a few **dramatic reflows** instead of one jump or one
  slow tween/step. A huge ballooning intermediate (Scott arithmetic) is reduced resident +
  undrawn (render-skip) until it resolves; an explosion guard pauses true blow-ups.
- **Bounded probes (the real blocker).** Turbo surfaced a *pre-existing* freeze: the value /
  `recognize` / quest / golf probes REDUCE the focused term unbounded and explode on big
  Church arithmetic (`read()` OOM'd on a 175-node term). Fixed: `normalize` gains an opt-in
  `maxNodes` size guard (a step-capped reduction can still build a heap-blowing tree via the
  S-rule clone); the value matchers + `probe()` use it; `recognize` skips > 256-node terms;
  the read-out skips its probes > 400 nodes; `finishNormalForm` skips the catalog/quest/golf
  probes when the result/source > 150 nodes (a big result is neither a bird nor a solution).

Measured (in-browser, Turbo on): church-mul egg(30) ~1.0 s, egg(50) ~1.3 s, vs DEFAULT
minutes (it managed 723/4714 steps in 19 s). No freezes; the intermediate spine renders
mid-churn.

**Update — the engine is now a wasm GRAPH reducer with number kernels** (the persistent
Session became the cross-check oracle). Call-by-need sharing (a faithful port of `graph.ts`:
cells iota|comb|free|app|IND, `force` chases indirections, the S-rule shares its arg by
index) tames the materialisation blow-up that bailed the persistent engine — Scott `(*) 5 5`
reduces in 1 ms / 1910 cells vs 16.7 M nodes / bail. The **number kernels** (a port of
`native.ts`'s `numberOp` with its exact forcing — `(+) a n` keeps n a thunk, `(*) 0 _`
short-circuits, `(-) m 0 → m`) compute clean canonical Scott results in the wasm directly, so
`(*) 8 8` reads "64" in ~500 ms. Turbo is eligible with native *numbers* on (kernels handle
them); rules/graph/list/bool kernels still gate it off. Hardening (Codex review): step /
readback / decode made ITERATIVE (deep Succ^k overflowed the stack), snapshot compacts the
arena (drop IND chains + dead cells, preserve the def prefix), caps aligned to native.ts
(match 9999 / `(*)` product 4096), and a normal form too large to lay out is not drawn.
Cross-check (`npm run check:reduce-wasm`): one-shot + persistent + graph 213/0 vs
`normalize(_,false)`/`evalShared(_,false)`, graph+kernels 253/0 vs `normalize(_,false,
{numbers:true})`, session invariance 3/0. Deferred: list/bool kernels; a wasm value-read.

## 17: Game controls — keyboard/controller input (`game-controls`)

Combinate becomes playable with a controller, not just mouse drag-and-drop. Designed with
Codex (consensus).

**Problem.** Drag-and-drop construction is spatial (two roots within a radius merge into
`app(fn,arg)`, fn = whichever is left by x); a d-pad/controller has no analog precision and no
spatial fn/arg cue. We need a DISCRETE, navigable scheme that reuses the one construction op
(application) and keeps the reduction spectacle (watching big trees reduce).

**Decision — Register Tray + Hand.** A small fixed set of *buckets* (registers), each holding
one term. A *hand* holds a term you've picked up. You navigate a HUD strip of bucket
slot-chips with the d-pad; each bucket's actual term is a real world-space `TreeView` at a
fixed anchor (so the reduction still plays out on the canvas — a HYBRID of HUD-chip navigation
and world-space spectacle). The selected bucket is the `focus` (read-out + reduction work
unchanged), and selecting auto-fits the camera to it.

- **Hand lifecycle.** `A`/Space with an empty hand picks up: the hotbar cursor's symbol (a
  *fresh* term — infinite supply) or the selected bucket's term (a *move* — empties the
  bucket). With a hand: into an empty bucket, place it; over an occupied bucket, `X` applies
  the held term as the **function** (`bucket := app(hand, bucket)`), `Y` as the **argument**
  (`bucket := app(bucket, hand)`). `Esc`/`B` cancels (restores a bucket-origin term).
- **Apply is explicit, not spatial.** `commitSnap`'s build/merge logic is factored into a
  non-spatial `applyTerms(fn, arg, anchor, fromWorld?)` (preserving `reduce.forget`, destroy,
  merged `TreeView`, `addTree`, `focus`, `animateAttachFrom`, `reduce.schedule`); the X/Y
  buttons choose direction, so the x-position rule is dropped on this path.
- **Coexists with mouse.** A `GameInputController` runs parallel to pointer input; mouse
  drag/drop/delete stay fully live. Mouse-dragging a bucket-owned tree *detaches* it from its
  slot (the one desync rule). Game mode is a toggle (Special menu), **OFF by default**; when ON
  it OWNS the keyboard — game keys act and every *other* desktop letter-shortcut is suspended
  (so a stray `r` can't clear the canvas; `z`/`x` mean zoom not Zoo/expand) — while modifier
  combos (Ctrl/Cmd/Alt) and the menu bar (Esc / mouse) still pass through. Shows the tray + a
  button-hint bar.
- **Speeds.** Transport gains numeric speed levels 0-4 (0=pause … 4=8×), wired into the
  normal, heavy-jump-cut, AND turbo pacing (so level 4 actually speeds the big trees the mode
  is for); `pause|play|ff` stay as compat aliases.
- **Keymap** is single-sourced in `keymap.ts` (intent → keyboard keys + gamepad button names),
  rendered by a keybinds reference page in settings, and consumed by the controller — so the
  gamepad layer (later) maps the same intents. The scheme was tuned with the Magi council
  (Codex + Grok, consensus) for naturalness — **apply lands on the bumpers, spatially**:
  fn = the LEFT child, so `LB` / `Q` applies the held term as the function and `RB` / `E` as
  the argument (a physical left/right pair beats arbitrary X/Y; `Q` is also left of `E`).
  Keyboard: **arrows + WASD** = move cursor / switch hotbar↔buckets (nav is the primary action,
  so it owns the home keys), Space = pick/place, `Q`/`E` = apply fn/arg, `[`/`]` = page,
  **IJKL = pan** (mirrors the right stick), `=`/`-` (then `z`/`x`) = zoom, `0`-`4` = speed,
  `Esc` = cancel / menu. Gamepad: D-pad nav (paging by pushing past the toolbar edge), A pick,
  LB/RB apply, B cancel, right-stick pan, RT/LT zoom, Select cycles speed.

Rejected: a root-cursor on the free canvas (d-pad nav across zoomed/overlapping roots is the
exact ergonomics trap), an RPN stack (feels like a calculator, loses the buckets-on-screen
fantasy), a modal builder panel (hides the canvas, breaks the watch-it-reduce loop); X/Y for
apply (named buttons don't encode the fn=left/arg=right spatial split the bumpers do).
