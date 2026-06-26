/**
 * The `Store` port (PLAN.md Phase A, ADR 0008): the interface the shell talks to
 * for persistence, independent of backend. The default impl is localStorage
 * ({@link ./local.ts}); a lazy DuckDB-WASM impl ({@link ./duckdb.ts}) backs the
 * query/leaderboard surface. The core (`src/core/`) never imports this — storage
 * is a driven adapter.
 *
 * Leaderboards follow the **verify-by-replay** trust model (ADR 0008): the store
 * is dumb and append-only — it just holds re-runnable rows; the *client* verifies
 * each entry (replaying the bit-code against the challenge) and drops fakes.
 */

/** A user-defined combinator (ADR 0006 authoring): a name + its term as an egg
 *  s-expression (round-trips via `core/refold.ts`). */
export interface Definition {
  name: string;
  egg: string;
}

/** A personal best for a challenge (ADR 0005): the metric + the solution permalink. */
export interface Best {
  challengeId: string;
  metric: number;
  permalink: string;
}

/** A leaderboard row (ADR 0008): a re-runnable solution. `bitcode` is the solution
 *  term; clients re-verify it against the challenge before trusting `metric`. */
export interface LeaderEntry {
  challengeId: string;
  bitcode: string;
  metric: number;
  handle: string;
}

export interface Store {
  // discovered combinators (the Pokédex progress)
  getDiscovered(): Promise<string[]>;
  addDiscovered(sym: string): Promise<void>;
  // user-defined combinators
  getDefinitions(): Promise<Definition[]>;
  putDefinition(d: Definition): Promise<void>;
  // challenge personal bests
  getBest(challengeId: string): Promise<Best | null>;
  putBest(b: Best): Promise<void>;
  // leaderboard (verify-by-replay; the store just holds rows)
  topN(challengeId: string, n: number): Promise<LeaderEntry[]>;
  submit(e: LeaderEntry): Promise<void>;
}
