/**
 * DuckDB-WASM {@link Store} (PLAN.md Phase A, ADR 0008): the query/leaderboard
 * backend, **lazy-loaded** — the multi-MB engine is dynamically imported only on
 * first use, never on first paint. Behind the same port as {@link ./local.ts}.
 *
 * This is the local DuckDB prototype that de-risks the quack/leaderboard path
 * (decision b). The shared, networked leaderboard (verify-by-replay over an
 * append-only remote DuckDB / httpfs) is wired on top of `topN`/`submit` in the
 * golf/leaderboard stream — this class is the local store + the seam for that.
 */
import type { Store, Definition, Best, LeaderEntry } from "./port";

// The duckdb-wasm async connection surface we use (kept loose so the lazy import
// stays the single source of the real types).
interface Conn {
  query(sql: string): Promise<{ toArray(): Array<Record<string, unknown>> }>;
  prepare(sql: string): Promise<{ query(...params: unknown[]): Promise<unknown>; close(): Promise<void> }>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS definitions(name VARCHAR, egg VARCHAR);
  CREATE TABLE IF NOT EXISTS bests(challengeId VARCHAR, metric INTEGER, permalink VARCHAR);
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
    await stmt.query(...params);
    await stmt.close();
  }
  private async rows<T>(sql: string): Promise<T[]> {
    return (await (await this.conn()).query(sql)).toArray() as T[];
  }

  async getDefinitions(): Promise<Definition[]> {
    return this.rows<Definition>("SELECT name, egg FROM definitions");
  }
  async putDefinition(d: Definition): Promise<void> {
    await this.run("DELETE FROM definitions WHERE name = ?", d.name);
    await this.run("INSERT INTO definitions VALUES (?, ?)", d.name, d.egg);
  }
  async getBest(challengeId: string): Promise<Best | null> {
    const r = await this.rows<Best>(`SELECT challengeId, metric, permalink FROM bests WHERE challengeId = '${challengeId.replace(/'/g, "''")}' ORDER BY metric LIMIT 1`);
    return r[0] ?? null;
  }
  async putBest(b: Best): Promise<void> {
    const cur = await this.getBest(b.challengeId);
    if (cur && cur.metric <= b.metric) return;
    await this.run("DELETE FROM bests WHERE challengeId = ?", b.challengeId);
    await this.run("INSERT INTO bests VALUES (?, ?, ?)", b.challengeId, b.metric, b.permalink);
  }
  async topN(challengeId: string, n: number): Promise<LeaderEntry[]> {
    const cid = challengeId.replace(/'/g, "''");
    return this.rows<LeaderEntry>(`SELECT challengeId, bitcode, metric, handle FROM leaderboard WHERE challengeId = '${cid}' ORDER BY metric LIMIT ${Math.max(0, Math.floor(n))}`);
  }
  async submit(e: LeaderEntry): Promise<void> {
    await this.run("INSERT INTO leaderboard VALUES (?, ?, ?, ?)", e.challengeId, e.bitcode, e.metric, e.handle);
  }
}
