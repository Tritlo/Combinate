/**
 * Export the catalog's SYMBOLIC birds for the minimal-forms enumerator
 * (crates/minimal): one line `sym|arity|iota_bitcode` per eligible law, written
 * to `crates/minimal/src/birds.txt` (committed; the crate `include_str!`s it —
 * the same pattern as gen-rules.ts → refold's rules.txt).
 *
 * Eligibility: a bird enters minimality search only if its behavior is genuinely
 * symbolic — skip `args` overrides (the Y-family: probed via finite tricks, no
 * plain open-term NF), `userDefined`, and `noProbe` laws (their `reference` is a
 * `$norec_…` sentinel, not a behavior). The bitcode is `IOTA_BITCODE` — the
 * current encoding the enumerator tries to beat.
 *
 *   npx tsx scripts/gen-minimal-birds.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { type Node, freeVar } from "../src/core/term";
import { CATALOG, IOTA_BITCODE, IOTA_STEPS } from "../src/core/catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../crates/minimal/src/birds.txt");

// Same alias table as gen-rules.ts — syms must be pipe/whitespace-safe atoms.
const TOKEN: Record<string, string> = {
  "(+)": "add",
  "(-)": "sub",
  "(*)": "mul",
  "(==)": "eqnat",
  "(/=)": "nenat",
  "(<)": "ltnat",
  "(<=)": "lenat",
  "<>": "append",
  "Φ": "Phi",
  "Ψ": "Psi",
};
const tok = (sym: string): string => TOKEN[sym] ?? sym;

/** Does the law's reference contain the `$norec_` sentinel (a `noProbe` law)? */
function isNoProbe(law: (typeof CATALOG)[number]): boolean {
  const vars = Array.from({ length: law.arity }, (_, i) => freeVar(String.fromCharCode(97 + i)));
  const seen: Node[] = [law.reference(vars)];
  while (seen.length) {
    const n = seen.pop()!;
    if (n.kind === "free" && n.name.startsWith("$norec_")) return true;
    if (n.kind === "app") seen.push(n.fn, n.arg);
  }
  return false;
}

const lines: string[] = [];
let skipped = 0;
for (const law of CATALOG) {
  if (law.fpc || law.userDefined || isNoProbe(law)) {
    skipped++;
    continue;
  }
  const bits = IOTA_BITCODE[law.sym];
  if (!bits) {
    skipped++;
    continue;
  }
  lines.push(`${tok(law.sym)}|${law.arity}|${bits}|${IOTA_STEPS[law.sym]?.[1] ?? ""}`); // col4: known fastest steps (seed bound)
}
writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(`wrote ${OUT}: ${lines.length} birds (${skipped} skipped: recursive/user-defined/noProbe)`);
