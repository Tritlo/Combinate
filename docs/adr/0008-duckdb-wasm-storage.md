# 8. DuckDB-WASM query prototype (and future quack-protocol leaderboards)

**Status:** accepted, with the shipped adapter explicitly in-memory

## Context

The new features create persistent state: the discovered set, user-defined
combinators (ADR 0006), challenge bests (ADR 0005), and shared/saved trees. The
maintainer wants **DuckDB (as WASM)** as the local store, with a later step using
the *quack protocol* to back **leaderboards**. DuckDB is the maintainer's house
default for databases; but DuckDB-WASM is a multi-MB dependency, and networked
leaderboards break the current "static, no backend" shape.

## Decision

Adopt `@duckdb/duckdb-wasm` **now** (decision b) as a **lazy driven adapter** behind
a pure `Store` port — `src/core/` stays DB/DOM/wasm-free (extends ADR 0001). The
opt-in `?store=duckdb` adapter is an **in-memory query/leaderboard prototype**;
durable `Store` state remains in the default `LocalStore` (other preferences use
`localStorage` directly), because DuckDB-WASM has no durable cross-session storage.
The **quack-protocol leaderboard architecture is prototyped early** rather than
deferred — that is the reason for taking the dependency now. DuckDB-WASM is
lazy-loaded (never on first paint); a first-time visitor who only plays ships none
of it.

## Why

Chosen over keeping only localStorage (option a) specifically to **de-risk the
quack/leaderboard path early** — validating that architecture is worth carrying the
dependency before it fully earns out. Structured, queryable local state using the
maintainer's house DB, with the core kept pure (storage as an adapter).

## Consequences

- DuckDB-WASM is heavy (multi-MB) — must be lazy/gated, fetched only when the
  prototype is explicitly selected; the default first paint ships none of it.
- Leaderboards (quack) introduce networking, but the trust model keeps the backend
  thin: **verify-by-replay** — a leaderboard entry *is* a re-runnable permalink
  (`{challenge, bitcode, metric, handle}`); because the reducer is pure and fast,
  every client re-verifies a submitted solution against the challenge predicate and
  recomputes its metric, silently dropping fakes. So the shared store is **dumb and
  append-only** (a DuckDB file over httpfs or a one-line serverless write) — no
  trusted validator, near-static. Cheating requires actually finding a better
  solution. (This is the domain-native anti-cheat and the reason DuckDB-over-quack
  is a clean fit: store + query *verifiable* rows.)
- A durable storage design is still needed before DuckDB can replace `LocalStore`.

## Open questions (for the grill)

- ~~Is DuckDB-WASM justified for the local-only phase?~~ **Resolved: yes, adopt
  now (b) to prototype quack early; lazy-loaded, never on first paint.**
- ~~Leaderboard trust/anti-cheat model?~~ **Resolved: verify-by-replay — entries
  are re-runnable permalinks, clients verify, shared store is dumb/append-only.**
- ~~Where the ~76 MB DuckDB engine is served from?~~ **Resolved (v8.0): the public
  jsDelivr CDN via `getJsDelivrBundles()` — a third-party engine isn't ours to host,
  unlike the MicroHs runtime which we vendor on a Release (ADR 0007).**
- Where the shared (append-only) leaderboard DB physically lives: DuckDB file over
  httpfs on object storage vs a one-line serverless write endpoint.
- ~~What is actually stored locally?~~ **Resolved:** durable definitions/bests live
  in `LocalStore`; the DuckDB experiment holds definitions, bests, and leaderboard
  rows only for the current page lifetime.
- ~~Lazy-load trigger?~~ **Resolved:** the explicit `?store=duckdb` query parameter.
