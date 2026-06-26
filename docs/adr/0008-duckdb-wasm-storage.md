# 8. DuckDB-WASM for local storage (and future quack-protocol leaderboards)

**Status:** proposed (draft — to be finalised by a grill-with-docs pass)

## Context

The new features create persistent state: the discovered set, user-defined
combinators (ADR 0006), challenge bests (ADR 0005), and shared/saved trees. The
maintainer wants **DuckDB (as WASM)** as the local store, with a later step using
the *quack protocol* to back **leaderboards**. DuckDB is the maintainer's house
default for databases; but DuckDB-WASM is a multi-MB dependency, and networked
leaderboards break the current "static, no backend" shape.

## Decision

Add `@duckdb/duckdb-wasm` as a **lazy driven adapter** for client-side storage,
behind a pure `Store` port — `src/core/` stays DB/DOM/wasm-free (extends ADR 0001).
Local-only first (the DB lives in the browser; persistence via OPFS/IndexedDB).
**Leaderboards (quack protocol) are explicitly deferred** to a later, separate
decision — the local store is designed so that hook stays cheap, but no networking
ships in this phase.

## Why

Structured, queryable local state (and a clean path to leaderboards) using the
maintainer's preferred DB; keeps the core pure with storage as an adapter.

## Consequences

- DuckDB-WASM is heavy (multi-MB) — must be lazy/gated, fetched only when
  persistence/queries are actually used; the default first paint ships none of it.
- Leaderboards (quack) will introduce networking — a real break from "static, no
  backend"; that trade is recorded when that phase lands, not now.
- A persistence schema to design (discoveries, definitions, challenge bests).

## Open questions (for the grill)

- **Is DuckDB-WASM justified for the *local-only* phase**, or is localStorage /
  IndexedDB the KISS choice until leaderboards actually need DuckDB's query/quack
  surface? (The multi-MB dep for key/value-ish local state is the central tension.)
- What is actually stored, and the schema.
- The quack-protocol leaderboard design (deferred): static-hostable? trust model?
- Lazy-load strategy and where the adapter is wired.
