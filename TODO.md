# TODO

Work top-down. **Working rhythm for every task:**
1. **Brainstorm the design with Codex** (the `codex-fusion` MCP times out less now;
   pass an extended `time` when a derivation needs it). Push back, drive to consensus.
2. **Write / fill its mini-ADR** in `docs/ADRs.md` (or its own file under `docs/adr/`
   for the big ones) — the decision + the why, terse.
3. Implement.
4. **Review / simplify with Codex** (`review_diff`), then act on it.
5. **Commit frequently** — small, reviewable commits; push each piece once verified
   (pushing is authorised).

> Everything from the previous batch shipped: transport redesign, the Fluff modal +
> effects, leaf/vine mode, the full **SKI Quest** port (prologue + 17 chapters),
> polish/sharing, the render pass, and the behavioural-equality engine fix. The
> hand-authored answer key verifies **99/102** supported puzzles; the last 3 are §4.

## 1. Optimizations modal — do this FIRST  · ADR 9 (mini)

The two reduction optimizations are loose toggles in the **Reduce** menu:
`Optimize (rule steps)` (`fastMode`) and `Graph reduction (DAG)` (`shareMode`).
Move them into a System-1 settings modal, mirroring Fluff
(`src/view/fluff.ts` / `src/view/quest.ts` — paper/ink, IoskeleyMono, Mac square
checkboxes, `Done`, injected CSS, light/dark via `onThemeChange`).

- [ ] `src/view/optimize.ts` — an `OptimizePanel` like `FluffPanel`: one checkbox +
      one-line description per setting; persist to `combinate:optimize:v1`; expose
      `isOpt(key)`/`optOn()`/`onOptChange()` (mirror `isFluff`/`fluffOn`/`onFluffChange`).
- [ ] `Reduce ▸ Optimizations…`; drop the two loose toggles. Wire the existing two
      through the object: `rules` (was `fastMode`), `graph` (was `shareMode`).
      `onOptChange` re-schedules the focused tree / invalidates graphers exactly as the
      menu items do (`setFastMode`, `scheduleAuto(focus)`). Keep `currentModes()`
      permalink fields (`optimize`, `graph`) working.
- [ ] Verify both themes + persistence; FPS unaffected.

## 2. Native values — new toggles in the modal  · ADR 10 (mini)

Combinate reduces data structurally, so arithmetic is O(n)/op — gcd/factorial blow the
step budget. Add **opt-in native evaluation**, one toggle each, default OFF = today's
exact pure-ι behaviour. **Hard constraint:** a native value round-trips to the exact
pure tree (toggling off, permalinks, and the Zoo probe stay correct). Brainstorm the
fast-path location + the "single semantics, not two" design with Codex before coding.

- [x] **Native numbers** — Scott `Succ`ⁿ`Z`; `(+) (-) (*) (==) (/=) (<) (<=) (>) (>=)
      compare` native (one step vs ~1232 for `(*) 12 15`). _Church is out of scope — no
      named op to intercept (ADR 10)._
- [x] **Native lists** — Scott/`cons`; `<> map concat` native (force the structure-driving
      operand only; the other stays raw, matching the pure rule).
- [x] **Native booleans** — Scott `K`/`KI`; `not and or` native (short-circuit `and`/`or`).
- [~] **Native chars / strings** — dropped as a peephole: Char ≡ Scott numeral, so char
      comparison is already the number ops; string *display* is a read-lens follow-up (ADR 10).
- [x] Round-trip verified: a 490+17-case grid asserts native output == pure output
      structurally (so the probe / Golf / permalinks see the canonical tree). _Graph-mode
      native is unwired (tree mode is the default); a follow-up._

## 3. Kernels / FFI — stretch, longer  · ADR 11 (full ADR: `docs/adr/0009-kernels.md`)

- [ ] Spike a MicroHs-style **kernel** mechanism: bind a named combinator to a native JS
      kernel (registry `Map<sym, fn>` + arity + a saturated-call reducer hook).
      Generalises §2; could surface real primitives in the Haskell panel. ADR first.
      **Kernels are PURE for now** — a kernel is a pure function of its (evaluated)
      arguments, no IO/effects. (FFI with real effects is a possible future, out of scope.)

## 4. Finish the SKI-Quest answer key — last 3, with Codex

The key (`scratchpad/answer-key.mts`) solves 99/102. Re-collaborate with Codex on:

- [ ] **gcd** (`u1Sr43PU`) — Church Euclid is over-budget. ⚠️ Native numbers (§2) do
      **not** help: the solution is raw S/K/I with no named op to intercept (Codex,
      ADR 10). gcd needs **kernels** (§3) or a Church abstract interpreter — or it stays
      an honest engine limit. Reassess after §3.
- [ ] **Identity but later** (`BzhFzwua`) — a delayed identity that is a *normal form* at
      2 args (`i (WI)(WI)` terminates); the η-long `λabc.abc` fails (normal order reduces
      its inner `Ω`). Needs an inert-holding arity-3 term.
- [ ] **Plan first / `if`** (`uvtknMlN`) — the deferred-condition combinator. Reverse-engineer it.
- [ ] Then clean the answer key into a committed regression test (vendor the puzzle data
      so it runs without `/tmp`).

## 5. Refactor pass — make the codebase manageable  · ADR 12 (mini)

Discuss the plan with Codex; think hard about organization, not just the modals.

- [ ] **Ports & adapters — deeper hexagonal (ADR 0001).** Push the functional-core /
      imperative-shell split into proper ports & adapters: the core should depend only
      on interfaces, the shell wires the concrete adapters. We already have one clean
      port — `Store` (LocalStore / DuckdbStore adapters); generalise the pattern.
      Candidate ports: a **renderer** port (Pixi as the adapter — so the core scene/layout
      doesn't import Pixi), **sound**, the **wasm refolder** + **MicroHs compiler**
      (already worker-ish), **persistence/settings**. Goal: the pure `core/` has zero
      DOM/Pixi/wasm imports and every side-effecting capability is an injected port.
      Map the seams with Codex; don't over-abstract — only ports that earn their keep.
- [ ] **Shared modal base** — 4-5 System-1 modals (Fluff, Optimizations, Quest, Zoo,
      Golf, About) each rebuild the same chrome and have repeated the same bugs (blurry
      text from fractional pixels, scroll clamping). Factor the chrome + fixes into one
      place — a `Modal` base and/or a `SettingsModal(spec)` for the checkbox-list ones —
      so a fix lands once. Migrate the modals onto it. (A DOM/view adapter, in port terms.)
- [ ] **`app.ts` is large** — look for cohesive seams to extract (transport, auto-reduce
      loop, the dev seam, menu wiring) without breaking the functional-core/shell split.
- [ ] Other organization / dead-code / naming cleanups Codex flags. Keep behaviour
      identical (no feature changes in this pass); verify nothing regressed.

## 6. Performance / efficiency pass — LAST, with Codex

- [ ] Final **rendering** pass (Pixi batches, per-frame work, ticker idling) and
      **engine** pass (reducer allocations, the native-value fast paths, graph sharing).
      Profile first, then optimize the real hot spots. Codex-review the changes.
