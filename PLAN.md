# PLAN — v6–v8 roadmap: shareability, authoring, and the MicroHs *wow*

The plan of record for the next arc. Decisions are in `docs/adr/0005`–`0008`
(finalised in a grill-with-docs pass); shared language is in `CONTEXT.md`. The
prior PLAN.md (the re-folding lens) shipped in v2–v3 and now lives in ADRs
0002–0004 and git history.

Three feature phases — shareability (v6), authoring (v7), and the in-browser
MicroHs compiler (v8) — plus a DuckDB-WASM store (0008) underneath. They are **not
4-way independent**: a foundation underpins three of them, and the MicroHs slice
must be built before its integration. So the shape is **preliminary → foundation →
parallel**, not four cold worktrees.

```
Phase 0 (MicroHs→WASM via nix-shell) ─────────────┐
                                                  ▼
Phase A (foundation: Store + permalink + trace) ──► B1 golf/leaderboards/sonify
                                                  ├► B2 authoring (Define/Abstract)
                                                  └► B3 MicroHs integration (uses Phase 0 blob)
```

Phase 0 and Phase A are independent and run concurrently; Phase B fans out once
both land.

---

## Phase 0 — MicroHs → WASM, reproducibly, in a nix-shell (preliminary)

The compile-only MicroHs WASM slice (+ the Prelude/char tweaks) is the prerequisite
for the wow feature (stream B3) and the one thing this environment can't produce. We
build it **reproducibly in a pinned `nix-shell`** (per house style: Nix builds run
in `nix-shell`), not ad-hoc — so the vendored blob is regenerable on each MicroHs
bump.

**Fork changes (in the `../MicroHs` fork):**
- A thin **`compileToComb(source) → combinator dump`** entry point (+ `typeOf`),
  reusing the already-factored stages (`Interactive.compile`, the pure
  `compileToCombinators`).
- **Char-literal desugaring → Scott `Nat`** of the ASCII code (since `Char` is not
  class-overloaded like numeric literals).
- A **primitive-free Prelude**: numeric literals → Scott `Nat` (`fromInteger`),
  `Char`/`String` → ASCII Scott `Nat`, and `+`/`*`/`-`/comparisons/list ops as the
  Scott versions. `IO`/FFI/`Float` stay primitive (rejected downstream).

**The nix-shell** (`nix/` in Combinate, pinning nixpkgs):
- Provides `ghc` (build/bootstrap `gmhs`), `emscripten` (`emcc`), `gnumake`.
- Builds the **compile-only slice** to WASM via MicroHs's existing emscripten/web
  target, trimmed to the compiler (no REPL/FFI), producing the blob + `base.pkg`.

**Outputs (deliverables of Phase 0):**
1. The vendored prebuilt **WASM blob (+ `base.pkg`)** — hosted as a release asset,
   **not** committed to git history (ADR 0007; explicit exception to ADR 0002).
2. A TS port of the **SKI-expansion step** (`iota/Iota.hs` → `decode()`-ready
   Barker bit-code, ~40 lines) — keeps the WASM slice a pure compiler.
3. The **curated example programs** (primitive-free Scott/Peano: a quicksort, etc.).
4. The **differential-oracle** binary (`iota/check`) for the dev/CI reducer test.
5. A documented `nix-shell` + build script so (1)–(4) regenerate on a MicroHs bump.

---

## Phase A — shared foundation (sequential; B1/B2 depend on it)

Small, shared core that everything builds on. Built directly (not fanned out),
because conflicts here would block the parallel streams.

- **`Store` port + DuckDB-WASM adapter** (ADR 0008). A pure `Store` interface in
  `src/core/`; a lazy DuckDB-WASM driven adapter in the shell (never on first
  paint; OPFS/IndexedDB persistence). Holds: discovered set, user definitions,
  challenge bests, leaderboard entries. Designed so the quack/leaderboard hook stays
  cheap (verify-by-replay).
- **Permalink codec** (ADR 0005). Tree (Barker bit-code) + active mode flags ⇄ URL
  hash; versioned (a schema byte); downloadable `.json`/bit-code fallback above a
  size cap. A solution / leaderboard entry *is* a permalink.
- **Rule-trace from `step()`** (ADR 0005). `step` (or a `stepWithRule`) surfaces the
  fired rule, so sonification can pick a tone and metrics can name the reduction —
  the one small core change v6 needs.

---

## Phase B — three parallel worktree streams (off the foundation)

Each in its own git worktree/branch off `main` (post-foundation), built and verified
independently, integrated as they land.

### B1 — Golf, leaderboards, sonification (ADR 0005)
- **Challenge layer** (shell state): id, target predicate (over the value reader or a
  target bit-code), best-metric (`countIotas` / steps); a *solution = a permalink*.
- **Leaderboards** via the quack adapter: **verify-by-replay** — store/query
  `{challenge, bitcode, metric, handle}`; clients re-run + re-verify on display and
  drop fakes; the shared store is dumb/append-only.
- **Sonification** (juice): a tiny WebAudio layer (one oscillator, tone per
  combinator family from the rule-trace), gated by a toggle.

### B2 — Authoring: Define, then one-hole Abstract (ADR 0006)
- **`Define`** (first): name a settled subtree → collapses to a hotbar block (reuse
  `collapsedNode` / `discover` / `hotbar.reveal`); persists via `Store`.
- **one-hole `Abstract`** (second): mark a leaf a *hole* (free var) → bracket-abstract
  over it (reuse `bracket` / `lam`). One hole only; no modal editor.
- Update the stale `spec/upper-techtree.md` to the Scott world.

### B3 — MicroHs integration (ADR 0007) — TS side
- A lazy **Web Worker** adapter behind a pure compiler port; loads the Phase 0 blob
  on demand (built against a stub until it lands).
- Wire `compileToComb → SKI-expand (TS, from Phase 0) → decode() → spawn`.
- The Haskell panel: **lead with curated examples** (editable, live-recompiled), a
  free-type editor, and an **honest reject** of `IO`/FFI/`Float` with a teaching
  message. (A Char display lens — Scott `Nat` → glyph — is an optional follow-up.)

---

## Sequencing & mechanics

1. Merge `roadmap` (ADRs 0005–0008 + `CONTEXT.md` + this PLAN) → `main`, so every
   worktree shares them.
2. Run **Phase 0 (nix-shell)** and **Phase A (foundation)** concurrently — they are
   independent.
3. Fan out **Phase B** into three worktree streams once A lands; B3 integrates the
   Phase 0 blob when ready.
4. Keep the **differential oracle** as a dev/CI test throughout (coexists with the
   live compiler).

## Implementation defaults (leftover UX detail, decided in-stream)

- Challenge set: ~6–8 starters (ι-cycle birds; build `I`/`K` in fewest ι; reduce to
  a target list). URL schema: versioned base64url of bit-code+flags.
- Sonification: combinator *family* by head symbol from the rule-trace.
- Authoring: hole gesture = drag a leaf out into a marked hole; multi-hole deferred;
  user-combinator names namespaced to avoid catalog collisions.
- Leaderboard backing store (append-only): DuckDB file over httpfs vs a one-line
  serverless write — decided when leaderboards land.
