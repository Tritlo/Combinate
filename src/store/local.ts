/**
 * localStorage-backed {@link Store} (PLAN.md Phase A): the working default, used
 * for all local persistence (discoveries, definitions, bests). The leaderboard
 * methods keep a *local* mirror only — the shared, networked leaderboard lands
 * with the DuckDB/quack adapter ({@link ./duckdb.ts}); both sit behind this port.
 */
import type { Store, Definition, Best, LeaderEntry } from "./port";

const KEY = "combinate:v1:";
const read = <T>(k: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(KEY + k);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown): void => {
  try {
    localStorage.setItem(KEY + k, JSON.stringify(v));
  } catch {
    /* quota / unavailable — persistence is best-effort */
  }
};

export class LocalStore implements Store {
  async getDiscovered(): Promise<string[]> {
    return read<string[]>("discovered", []);
  }
  async addDiscovered(sym: string): Promise<void> {
    const s = new Set(read<string[]>("discovered", []));
    s.add(sym);
    write("discovered", [...s]);
  }
  async getDefinitions(): Promise<Definition[]> {
    return read<Definition[]>("definitions", []);
  }
  async putDefinition(d: Definition): Promise<void> {
    const defs = read<Definition[]>("definitions", []).filter((x) => x.name !== d.name);
    defs.push(d);
    write("definitions", defs);
  }
  async getBest(challengeId: string): Promise<Best | null> {
    return read<Record<string, Best>>("bests", {})[challengeId] ?? null;
  }
  async putBest(b: Best): Promise<void> {
    const bests = read<Record<string, Best>>("bests", {});
    const cur = bests[b.challengeId];
    if (!cur || b.metric < cur.metric) {
      bests[b.challengeId] = b;
      write("bests", bests);
    }
  }
  async topN(challengeId: string, n: number): Promise<LeaderEntry[]> {
    return read<LeaderEntry[]>("leaderboard", [])
      .filter((e) => e.challengeId === challengeId)
      .sort((a, b) => a.metric - b.metric)
      .slice(0, n);
  }
  async submit(e: LeaderEntry): Promise<void> {
    const all = read<LeaderEntry[]>("leaderboard", []);
    all.push(e);
    write("leaderboard", all);
  }
}
