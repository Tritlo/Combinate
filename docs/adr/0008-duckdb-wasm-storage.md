# 8. DuckDB-WASM for local storage (and future quack-protocol leaderboards)

**Status:** accepted (finalised in a grill-with-docs pass; remaining open items are implementation defaults)

## Context

The new features create persistent state: the discovered set, user-defined
combinators (ADR 0006), challenge bests (ADR 0005), and shared/saved trees. The
maintainer wants **DuckDB (as WASM)** as the local store, with a later step using
the *quack protocol* to back **leaderboards**. DuckDB is the maintainer's house
default for databases; but DuckDB-WASM is a multi-MB dependency, and networked
leaderboards break the current "static, no backend" shape.

## Decision

Adopt `@duckdb/duckdb-wasm` **now** (decision b) as a **lazy driven adapter** for
client-side storage, behind a pure `Store` port — `src/core/` stays DB/DOM/wasm-free
(extends ADR 0001). The DB lives in the browser (persistence via OPFS/IndexedDB),
and the **quack-protocol leaderboard architecture is prototyped early** rather than
deferred — that is the reason for taking the dependency now instead of starting on
localStorage. DuckDB-WASM is lazy-loaded (never on first paint); a first-time
visitor who only plays ships none of it.

## Why

Chosen over deferring to localStorage (option a) specifically to **de-risk the
quack/leaderboard path early** — validating that architecture is worth carrying the
dependency before it fully earns out. Structured, queryable local state using the
maintainer's house DB, with the core kept pure (storage as an adapter).

## Consequences

- DuckDB-WASM is heavy (multi-MB) — must be lazy/gated, fetched only when
  persistence/queries are actually used; the default first paint ships none of it.
- Leaderboards (quack) introduce networking, but the trust model keeps the backend
  thin: **verify-by-replay** — a leaderboard entry *is* a re-runnable permalink
  (`{challenge, bitcode, metric, handle}`); because the reducer is pure and fast,
  every client re-verifies a submitted solution against the challenge predicate and
  recomputes its metric, silently dropping fakes. So the shared store is **dumb and
  append-only** (a DuckDB file over httpfs or a one-line serverless write) — no
  trusted validator, near-static. Cheating requires actually finding a better
  solution. (This is the domain-native anti-cheat and the reason DuckDB-over-quack
  is a clean fit: store + query *verifiable* rows.)
- A persistence schema to design (discoveries, definitions, challenge bests,
  leaderboard entries).

## Open questions (for the grill)

- ~~Is DuckDB-WASM justified for the local-only phase?~~ **Resolved: yes, adopt
  now (b) to prototype quack early; lazy-loaded, never on first paint.**
- ~~Leaderboard trust/anti-cheat model?~~ **Resolved: verify-by-replay — entries
  are re-runnable permalinks, clients verify, shared store is dumb/append-only.**
- Where the shared (append-only) leaderboard DB physically lives: DuckDB file over
  httpfs on object storage vs a one-line serverless write endpoint.
- What is actually stored locally, and the schema.
- Lazy-load trigger and where the adapter is wired.
