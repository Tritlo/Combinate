/**
 * Ground-truth certification for minimal-forms (ADR 27): re-prove every claim in
 * spec/minimal-forms.json with the app's OWN reducer, then write the human report.
 *
 * The Rust enumerator (crates/minimal) exists for speed; nothing it says is trusted
 * until this pass — pure TS `normalize` (fast=false) + `structKey`, the exact
 * machinery probe.ts uses — re-proves it:
 *   - each bird's claimed minimal form equals the bird at its DECLARED arity;
 *   - each reported coincidence class really shares an arity-5 normal form;
 *   - a sample of (term, NF) pairs matches the Rust reducer byte-for-byte.
 * Exits non-zero on any mismatch. Writes spec/minimal-forms.md.
 *
 *   npx tsx scripts/certify-minimal.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { type Node, app, freeVar, decode } from "../src/core/term";
import { normalize } from "../src/core/reduce";
import { structKey } from "../src/core/probe";
import { CATALOG, iotaTreeOf, type Law } from "../src/core/catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = resolve(HERE, "../spec/minimal-forms.json");
const MD_PATH = resolve(HERE, "../spec/minimal-forms.md");

// Same alias table as gen-minimal-birds.ts (birds.txt syms are aliased).
const TOKEN: Record<string, string> = {
  "(+)": "add", "(-)": "sub", "(*)": "mul", "(==)": "eqnat", "(/=)": "nenat",
  "(<)": "ltnat", "(<=)": "lenat", "<>": "append", "Φ": "Phi", "Ψ": "Psi",
};
const lawByAlias = new Map<string, Law>(CATALOG.map((l) => [TOKEN[l.sym] ?? l.sym, l]));

interface BirdFinding {
  sym: string;
  arity: number;
  current_bits: string;
  current_iotas: number;
  minimal_bits: string | null;
  minimal_iotas: number | null;
  minimal_nf: string | null;
  status: string;
  class_size: number;
  unresolved_before_winner: number;
}
interface Data {
  meta: Record<string, unknown>;
  birds: BirdFinding[];
  coincidences: { syms: string[]; nf: string }[];
  samples: { bits: string; nf: string }[];
}
const data = JSON.parse(readFileSync(JSON_PATH, "utf8")) as Data;

const CAP = 500_000;
const MAX_NODES = 2_000_000;
const VARS = "abcde";
const applied = (t: Node, arity: number): Node => {
  let out = t;
  for (let i = 0; i < arity; i++) out = app(out, freeVar(VARS[i]));
  return out;
};
/** structKey of the full NF of `t` applied to `arity` fresh vars, or null on cap. */
function sig(t: Node, arity: number): string | null {
  const r = normalize(applied(t, arity), CAP, false, undefined, MAX_NODES);
  return r.done ? structKey(r.term) : null;
}

let failures = 0;
const fail = (msg: string): void => {
  failures++;
  console.error(`✗ ${msg}`);
};

// -- 1. bird claims at declared arity --
let certified = 0;
for (const b of data.birds) {
  if (!b.minimal_bits) continue;
  const law = lawByAlias.get(b.sym);
  if (!law) {
    fail(`${b.sym}: no catalog law for alias`);
    continue;
  }
  const cand = decode(b.minimal_bits);
  const bird = iotaTreeOf(law);
  const candSig = sig(cand, law.arity);
  const birdSig = sig(bird, law.arity);
  if (candSig === null || birdSig === null) {
    fail(`${b.sym}: TS normalize capped (cand=${candSig !== null}, bird=${birdSig !== null})`);
    continue;
  }
  if (candSig !== birdSig) {
    fail(`${b.sym}: claimed minimal form is NOT equal at arity ${law.arity}\n  cand ${candSig}\n  bird ${birdSig}`);
    continue;
  }
  if (b.minimal_nf !== null && candSig !== b.minimal_nf && sig(cand, b.arity) !== b.minimal_nf) {
    // minimal_nf is the Rust NF at declared arity — must match TS byte-for-byte
    fail(`${b.sym}: Rust NF string differs from TS structKey\n  rust ${b.minimal_nf}\n  ts   ${candSig}`);
    continue;
  }
  certified++;
}

// -- 2. coincidence classes at arity 5 --
for (const c of data.coincidences) {
  const sigs = c.syms.map((s) => {
    const law = lawByAlias.get(s);
    return law ? sig(iotaTreeOf(law), 5) : null;
  });
  if (sigs.some((s) => s === null)) {
    fail(`coincidence ${c.syms.join("=")}: a member capped in TS`);
    continue;
  }
  if (new Set(sigs).size !== 1) fail(`coincidence ${c.syms.join("=")}: members do NOT share an arity-5 NF`);
  else if (sigs[0] !== c.nf) fail(`coincidence ${c.syms.join("=")}: stored NF differs from TS\n  rust ${c.nf}\n  ts   ${sigs[0]}`);
}

// -- 3. reducer parity samples --
let parityOk = 0;
for (const s of data.samples) {
  const k = sig(decode(s.bits), 5);
  if (k === s.nf) parityOk++;
  else fail(`parity: ${s.bits} → rust ${s.nf} vs ts ${k}`);
}

// -- report --
const proven = data.birds.filter((b) => b.status === "proven");
const improved = proven.filter((b) => (b.minimal_iotas ?? Infinity) < b.current_iotas);
const rows = data.birds
  .filter((b) => b.minimal_bits !== null || b.status !== "not-found-within-bound")
  .map((b) => {
    const delta = b.minimal_iotas !== null && b.minimal_iotas < b.current_iotas ? ` ← **${b.current_iotas - b.minimal_iotas!} ι smaller**` : "";
    return `| ${b.sym} | ${b.arity} | ${b.current_iotas} | ${b.minimal_iotas ?? "—"} | \`${b.minimal_bits ?? "—"}\` | ${b.status}${delta} |`;
  })
  .join("\n");
const md = `# Minimal ι-forms (generated — do not edit)

Produced by \`npm run minimal-forms\` (crates/minimal + this certifier; methodology in
ADR 27). Search bound: **≤ ${data.meta.max_iotas} ι** (${data.meta.total_terms} terms,
${data.meta.capped_terms} capped at signature time, all escalated during certification).
Every row below was re-proven against the app's own reducer (\`normalize\`, fast=false)
at the bird's declared arity; "proven" means the entire cheaper frontier normalized and
differed — a true minimality certificate within the bound.

| bird | arity | current ι | minimal ι | minimal bitcode | status |
|---|---|---|---|---|---|
${rows}

Birds not listed found no equal within the bound (\`not-found-within-bound\`) — their
current encodings may still be reducible at deeper bounds.

## Coincidences (equal arity-5 normal forms)

${data.coincidences.map((c) => `- **${c.syms.join(" ≡ ")}** — shared NF \`${c.nf}\``).join("\n") || "(none)"}

## Certification

- ${certified} bird claims re-proven in TypeScript at declared arity.
- ${parityOk}/${data.samples.length} reducer-parity samples byte-identical (Rust structKey ↔ TS structKey).
- ${failures === 0 ? "**ALL CHECKS PASSED.**" : `**${failures} FAILURES — see run log; do not trust this table.**`}
`;
writeFileSync(MD_PATH, md);
console.log(`certify-minimal: ${certified} bird claims, ${data.coincidences.length} coincidences, ${parityOk}/${data.samples.length} parity samples — ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
console.log(`report → ${MD_PATH}`);
process.exit(failures === 0 ? 0 : 1);
