/**
 * DuckDB-WASM {@link Store} (ADR 0008): the query/leaderboard
 * backend, **lazy-loaded** — the multi-MB engine is dynamically imported only on
 * first use, never on first paint. Behind the same port as {@link ./local.ts}.
 *
 * This is an in-memory DuckDB prototype that de-risks the quack/leaderboard path
 * (decision b). The shared, networked leaderboard (verify-by-replay over an
 * append-only remote DuckDB / httpfs) is wired on top of `topN`/`submit` in the
 * golf/leaderboard stream. Cross-reload persistence remains with the default
 * LocalStore: DuckDB-WASM itself has no durable cross-session storage.
 */
import type { Store, Definition, Best, LeaderEntry } from "./port";

// The duckdb-wasm async connection surface we use (kept loose so the lazy import
// stays the single source of the real types).
interface Conn {
  query(sql: string): Promise<{ toArray(): Array<Record<string, unknown>> }>;
  prepare(sql: string): Promise<{
    query(...params: unknown[]): Promise<{ toArray(): Array<Record<string, unknown>> }>;
    close(): Promise<void>;
  }>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS definitions(name VARCHAR PRIMARY KEY, egg VARCHAR);
  CREATE TABLE IF NOT EXISTS bests(challengeId VARCHAR PRIMARY KEY, metric INTEGER, permalink VARCHAR);
  CREATE TABLE IF NOT EXISTS leaderboard(challengeId VARCHAR, bitcode VARCHAR, metric INTEGER, handle VARCHAR);
`;

export class DuckdbStore implements Store {
  private connP: Promise<Conn> | null = null;

  /** Lazily instantiate DuckDB-WASM (dynamic import keeps it off the main bundle). */
  private conn(): Promise<Conn> {
    if (this.connP) return this.connP;
    this.connP = (async () => {
      const duckdb = await import("@duckdb/duckdb-wasm");
      // DuckDB is a third-party engine (~76 MB of wasm) — serve it from the public
      // jsDelivr CDN rather than our own origin. `selectBundle` picks `eh` where
      // exception-handling is supported, else falls back to `mvp`.
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const worker = await duckdb.createWorker(bundle.mainWorker!);
      const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker ?? undefined);
      const conn = (await db.connect()) as unknown as Conn;
      await conn.query(SCHEMA);
      return conn;
    })();
    return this.connP;
  }

  private async run(sql: string, ...params: unknown[]): Promise<void> {
    const stmt = await (await this.conn()).prepare(sql);
    try {
      await stmt.query(...params);
    } finally {
      await stmt.close();
    }
  }
  private async rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const stmt = await (await this.conn()).prepare(sql);
    try {
      const result = await stmt.query(...params);
      return result.toArray() as T[];
    } finally {
      await stmt.close();
    }
  }

  async getDefinitions(): Promise<Definition[]> {
    return this.rows<Definition>("SELECT name, egg FROM definitions");
  }
  async putDefinition(d: Definition): Promise<void> {
    await this.run("INSERT INTO definitions VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET egg = excluded.egg", d.name, d.egg);
  }
  async getBest(challengeId: string): Promise<Best | null> {
    const r = await this.rows<Best>("SELECT challengeId, metric, permalink FROM bests WHERE challengeId = ?", challengeId);
    return r[0] ?? null;
  }
  async putBest(b: Best): Promise<void> {
    await this.run(
      "INSERT INTO bests VALUES (?, ?, ?) ON CONFLICT (challengeId) DO UPDATE SET metric = excluded.metric, permalink = excluded.permalink WHERE excluded.metric < bests.metric",
      b.challengeId,
      b.metric,
      b.permalink,
    );
  }
  async topN(challengeId: string, n: number): Promise<LeaderEntry[]> {
    return this.rows<LeaderEntry>(
      "SELECT challengeId, bitcode, metric, handle FROM leaderboard WHERE challengeId = ? ORDER BY metric LIMIT ?",
      challengeId,
      Math.max(0, Math.floor(n)),
    );
  }
  async submit(e: LeaderEntry): Promise<void> {
    await this.run("INSERT INTO leaderboard VALUES (?, ?, ?, ?)", e.challengeId, e.bitcode, e.metric, e.handle);
  }
}
