/**
 * SKI-Quest answer key + regression test.
 *
 * Maps *supported* puzzles (see {@link isSupported}) to a solution source — a SKI-Quest
 * expression — and asserts the case engine ({@link makeGoal}) accepts each. This is the
 * committed replacement for the old throwaway scratchpad key (which was lost): run it to
 * prove every recorded solution still satisfies its puzzle, so an engine change that
 * breaks one fails loudly.
 *
 *   npx tsx scripts/answer-key.mts          # verify; exits non-zero on any regression
 *   npx tsx scripts/answer-key.mts --list   # also list the still-uncovered puzzles
 *
 * Pure: runs on Combinate's own reducer over the vendored `src/core/skiq/data.ts`, no
 * network, no `/tmp`. Solutions are SKI-Quest source (the same language the player
 * types): combinators by name, `->` lambdas, juxtaposition for application.
 *
 * Coverage: **all 107 supported puzzles are solved** (`--list` shows none uncovered).
 * Solutions span bird combinators, fold/Scott-list ops, Church numerics (incl. factorial,
 * Fibonacci, n/2, binary), restricted-basis combinatory-completeness builds, terminating
 * fixed points, and the kernel-assisted gcd. The 4 *unsupported* puzzles are multi-input
 * or structural-property (`caps`) goals the single-canvas engine can't check (see
 * {@link isSupported}) — a known gap, not a missing answer.
 */
import { SKIQ_CHAPTERS } from "../src/core/skiq/data";
import { makeGoal, isSupported, buildEnvScope, type Puzzle } from "../src/core/skiq/engine";
import { parseExpr, type Scope } from "../src/core/skiq/parse";
import { SOLUTIONS } from "../src/core/skiq/solutions"; // the answer key (shared with the Quest review)

// A solution may reference the puzzle's env combinators (e.g. `M A` for "I from M,T,A,B"),
// so parse it in the puzzle's env scope (empty for env-less puzzles).
const scopeFor = (p: Puzzle): Scope => {
  const env = buildEnvScope(p.env);
  return (name) => env.get(name) ?? null;
};

/** Supported puzzles deliberately left unsolved, with why. (gcd is now solved — ADR 11.) */
const PENDING: Record<string, string> = {};

const findName = (id: string): string => {
  for (const ch of SKIQ_CHAPTERS) for (const p of ch.content) if (p.id === id) return p.name;
  return id;
};

function passes(p: Puzzle): boolean {
  try {
    return makeGoal(p)(parseExpr(SOLUTIONS[p.id], scopeFor(p)));
  } catch {
    return false;
  }
}

const list = process.argv.includes("--list");
let total = 0,
  solved = 0,
  unsupported = 0;
const failures: string[] = [];
const uncovered: string[] = [];
for (const ch of SKIQ_CHAPTERS) {
  for (const p of ch.content) {
    if (!isSupported(p)) {
      unsupported++;
      continue;
    }
    total++;
    if (p.id in PENDING) continue;
    if (!(p.id in SOLUTIONS)) {
      uncovered.push(`${p.id}  ${p.name.replace(/<[^>]+>/g, "")}`);
      continue;
    }
    if (passes(p)) solved++;
    else failures.push(`${p.id}  ${p.name.replace(/<[^>]+>/g, "")}  →  "${SOLUTIONS[p.id]}"`);
  }
}

const pending = Object.keys(PENDING).length;
console.log(
  `answer key: ${solved}/${total} supported puzzles solved  ` +
    `(${pending} pending-kernels, ${uncovered.length} uncovered, ${unsupported} unsupported · ${failures.length} REGRESSIONS)`,
);
for (const [id, why] of Object.entries(PENDING)) console.log(`  pending: ${id} ${findName(id).replace(/<[^>]+>/g, "")} — ${why}`);
if (list && uncovered.length) console.log("uncovered:\n  " + uncovered.join("\n  "));
if (failures.length) {
  console.error("\nREGRESSIONS — these recorded solutions no longer pass:\n  " + failures.join("\n  "));
  process.exit(1);
}
