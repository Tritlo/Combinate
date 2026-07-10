/**
 * Release integrity checks (docs/release-checklist.md) — the mechanically checkable
 * half. Every check here exists because its absence once shipped (or nearly shipped)
 * a gap: blank META cards, non-recognizing adopted encodings, stale generated rules.
 * Exits non-zero on any failure.
 *
 *   npm run check:release
 */
import { execSync } from "node:child_process";
import { type Node, decode } from "../src/core/term";
import { CATALOG, META, PAGES, IOTA_CODE, IOTA_FASTEST, IOTA_STEPS, IOTA_BITCODE, countIotas, iotaTreeOf } from "../src/core/catalog";
import { recognize } from "../src/core/probe";
import { iotaCost } from "../src/core/challenges";
import { comb } from "../src/core/term";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (!ok) {
    failures++;
    console.error(`✗ ${msg}`);
  }
};

// -- Catalog / data integrity --
const syms = new Set(CATALOG.map((l) => l.sym));
for (const l of CATALOG) {
  if (l.userDefined) continue;
  check(META[l.sym] !== undefined, `META missing for ${l.sym} (blank Zoo blurb + discovery card)`);
}
for (const page of PAGES) for (const e of page.entries) check(e.sym === "ι" || syms.has(e.sym), `PAGES entry ${e.sym} (page ${page.name}) has no catalog law`);
for (const sym of Object.keys(IOTA_FASTEST)) {
  check(IOTA_CODE[sym] !== undefined, `IOTA_FASTEST[${sym}] has no IOTA_CODE (Zoo toggle needs both)`);
  check(IOTA_STEPS[sym] !== undefined, `IOTA_FASTEST[${sym}] has no IOTA_STEPS (stats line)`);
}
for (const sym of Object.keys(IOTA_STEPS)) check(IOTA_FASTEST[sym] !== undefined, `IOTA_STEPS[${sym}] has no IOTA_FASTEST`);

// -- Encodings: recognition + golf-cost coherence (an adopted code that can't recognize
//    at game caps silently kills that bird's discovery — the Pred/tail lesson) --
for (const [sym, code] of Object.entries({ ...IOTA_CODE, ...IOTA_FASTEST })) {
  const law = CATALOG.find((l) => l.sym === sym);
  if (law && /norec/.test(String(law.reference))) continue; // noProbe sentinels only — Y now self-recognizes via the Böhm-prefix probe and is asserted like any bird
  if (sym === "J") continue; // designer-exempt: certified equal at 500k caps, slower than play budgets (see catalog.ts)
  const rec = recognize(decode(code));
  check(rec?.sym === sym, `${sym}: decode(code) does not recognize at game caps (got ${rec?.sym ?? "nothing"})`);
}
for (const [sym, code] of Object.entries(IOTA_CODE)) {
  check(IOTA_BITCODE[sym] === code, `${sym}: IOTA_BITCODE does not route through IOTA_CODE`);
  const law = CATALOG.find((l) => l.sym === sym);
  if (law) check(countIotas(iotaTreeOf(law)) === (code.match(/1/g) ?? []).length, `${sym}: iota count mismatch`);
  check(iotaCost(comb(sym)) === (code.match(/1/g) ?? []).length, `${sym}: golf iotaCost disagrees with the code`);
}

// -- Generated artifacts freshness (the stale-rules.txt lesson: new birds must reach
//    the egg re-folder + the enumerator's bird list) --
try {
  execSync("npx tsx scripts/gen-rules.ts", { stdio: "pipe" });
  execSync("npx tsx scripts/gen-minimal-birds.ts", { stdio: "pipe" });
  execSync("git diff --exit-code -- crates/refold/src/rules.txt crates/minimal/src/birds.txt", { stdio: "pipe" });
} catch {
  failures++;
  console.error("✗ generated artifacts stale: rerun gen:rules / gen-minimal-birds and commit (git diff shows the drift)");
}

console.log(failures === 0 ? `check-release: ALL PASS (${CATALOG.length} laws, ${Object.keys(IOTA_CODE).length} codes, ${Object.keys(IOTA_FASTEST).length} fastest)` : `check-release: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
