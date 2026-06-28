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

> **All tasks done and pushed.** 1 Optimizations modal · 2 Native values · 3 Answer key
> (committed regression test, **gcd now solved** via the cmod kernel — 48/107, the rest a
> backfill follow-up) · 4 Quest Mode · 5 Kernels (cmod unblocks gcd) · 6 Reorg (shared
> Modal base; "core ports" dropped per ADR 0001; app.ts extraction + QuestProgress
> persistence-hoist = follow-ups) · 7 Perf (engine spine O(L²)→O(L); heavy compute is
> native/graph; deeper redexAt spine-rewalk + a profiled rendering pass = follow-ups).
> Also: the in-HUD hint now reuses the Quest as the single hint source.
>
> **Answer key — DONE: 107/107 supported puzzles solvable** (was a 48/107 partial). Fixed
> `allowOk` to permit env-given combinators (basis puzzles like "I from M,T,A,B" were
> unsolvable); backfilled fold-lists, pairs, Church numerics, restricted-basis
> combinatory-completeness builds + terminating fixed points (with Codex). The 4
> unsupported are `caps` (linear/affine structural goals) + multi-input — **kept as-is**
> (already filtered out of play; vendored data left intact for fidelity).
>
> **Open follow-ups:** migrate Quest/Zoo/Golf onto the Modal base; hoist QuestProgress's
> localStorage to the shell; app.ts extraction; the redexAt spine-rewalk; an
> interactively-profiled render pass.

## 8. Quest UX — log + iota preview

- [x] **Prologue order** — already correct (`prologue-i` ι ι=I → `prologue-a` ι I=A →
      `prologue-k` ι A=K → `prologue-s` ι K=S); no change.
- [ ] **Quest log** — see previously-solved quests (the completed stages), not just the
      current one. A scrollable list (chapter · stage · the bird unlocked).
- [ ] **Iota preview** — preview the combinator you're about to discover *in ι form* (its
      `iotaTreeOf` / `IOTA_CODE`), so you can see the target you're building.

## 1. Optimizations modal — ✅ DONE  · ADR 9 (mini)

Shipped: the two reduction toggles moved into a System-1 settings modal
(`src/view/optimize.ts`, `Reduce ▸ Optimizations…`), single store path
(`isOpt`/`setOpt`/`onOptChange`), permalink-safe (`setOpt(…, persist:false)`).

## 2. Native values — ✅ DONE  · ADR 10 (mini)

Shipped (`src/core/native.ts`): opt-in **native numbers** (`(+) (-) (*) (==) (/=) (<)
(<=) (>) (>=) compare`), **native lists** (`<> map concat`), **native booleans**
(`not and or`) — each a toggle. Round-trip-safe by construction (a 490+17-case grid
asserts native output == pure output structurally), discovery cheap, numeral output
capped. No `chars` toggle (Char ≡ Scott numeral). Graph-mode native unwired (a follow-up).

## 3. SKI-Quest answer key — last 3, **and commit it**

The prior key (`scratchpad/answer-key.mts`, 99/102) was **lost** (session scratchpad is
ephemeral) — so reconstruct it *and commit it* this time. Solutions found this session:

- [x] **Identity but later** (`BzhFzwua`) — `B C C` (also `W B C`, `Q C C`). A delayed
      identity: `B C C a b = C (C a) b` is a **normal form** (a, b never merged), and
      `B C C a b c → C(C a) b c → C a c b → a b c`. (The η-long `λabc.abc` and `I` fail —
      they reduce `i (WI)(WI)` to Ω. The arity gate isn't needed; nested `C` holds the
      apply-order until `c` arrives.) Verified against `makeGoal`.
- [x] **Plan first / `if`** (`uvtknMlN`) — `c -> t -> e -> x -> c x (t x) (e x)`: the
      check `c x` (→ K/KI) selects `t x` vs `e x`. Verified against `makeGoal`.
- [ ] **gcd** (`u1Sr43PU`) — Church Euclid is over-budget; **gated on kernels (§5)**:
      native values don't help (raw S/K/I, no named op — ADR 10), so it needs a
      kernel-backed Church primitive or stays an honest engine limit. Reassess in §5.
- [ ] **Commit the answer key as a committed regression test** so it can't be lost again:
      a runnable check (no `/tmp`) mapping each supported puzzle → a solution string and
      asserting `makeGoal` passes, over the vendored `skiq/data.ts`. Seed with the two
      solved above; backfill the rest (bird-combo solutions are auto-searchable; lambda /
      numeral / Y-fixpoint ones authored). gcd stays listed as pending-kernels.

## 4. Quest Mode — a tracked-quest side panel  · ADR 13 (mini)

A persistent "tracked quest" HUD on the side of the canvas — think **WoW's tracked-quest
tracker**: show the player's current chapter + puzzle, its objective/goal text, and the
case(s) still to satisfy, so the active goal is always visible while you build (instead of
only inside the Quest modal). Pin/unpin a quest; collapse; updates live as cases pass.

- [ ] Brainstorm with Codex + frontend-design: placement (right rail, System-1 chrome),
      what to show (objective, cases, progress), how it tracks the "current" quest
      (last-opened in the Quest panel? an explicit "Track" button?), light/dark, mobile.
- [ ] Reuse the Quest data/goal machinery (`core/quest.ts`, `core/skiq/engine.ts`); the
      panel is a view that reflects quest state. Don't duplicate the goal logic.
- [ ] Persist the tracked quest; keep FPS unaffected (it's static DOM, not Pixi).

## 5. Kernels / FFI — third-last  · ADR 11 (full ADR: `docs/adr/0009-kernels.md`)

- [ ] Spike a MicroHs-style **kernel** mechanism: bind a named combinator to a native JS
      kernel (registry `Map<sym, fn>` + arity + a saturated-call reducer hook).
      Generalises §2 (native values are built-in kernels); could surface real primitives
      in the Haskell panel, and a **Church** primitive could unblock gcd (§3).
      **Kernels are PURE for now** — a kernel is a pure function of its (evaluated)
      arguments, no IO/effects. (FFI with real effects is a possible future, out of scope.)
      ADR first; consider refactoring `native.ts`'s hardcoded ops onto the registry.

## 6. Reorg / refactor — penultimate  · ADR 12 (mini)

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
- [ ] **Shared modal base** — 5-6 System-1 modals (Fluff, Optimizations, Quest, the new
      Quest-Mode panel, Zoo, Golf, About) each rebuild the same chrome and have repeated
      the same bugs (blurry text from fractional pixels, scroll clamping). Factor the
      chrome + fixes into one place — a `Modal` base and/or a `SettingsModal(spec)` for the
      checkbox-list ones — so a fix lands once. Migrate the modals onto it.
- [ ] **`app.ts` is large** — look for cohesive seams to extract (transport, auto-reduce
      loop, the dev seam, menu wiring) without breaking the functional-core/shell split.
- [ ] Other organization / dead-code / naming cleanups Codex flags. Keep behaviour
      identical (no feature changes in this pass); verify nothing regressed.

## 7. Performance / efficiency pass — LAST, with Codex

- [ ] Final **rendering** pass (Pixi batches, per-frame work, ticker idling) and
      **engine** pass (reducer allocations, the native-value fast paths, graph sharing).
      Profile first, then optimize the real hot spots. Codex-review the changes.
