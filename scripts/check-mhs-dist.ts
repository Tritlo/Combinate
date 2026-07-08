/**
 * Cheap completeness check of the MicroHs dist under public/vendor/mhs — a real
 * wasm, every manifest entry present, and a gallery closure for every curated
 * example. No compiler run; in CI it gates both a fresh build and a cache
 * restore (a corrupt or partial restore must fail the deploy, not ship).
 *
 *   npx tsx scripts/check-mhs-dist.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { EXAMPLES } from "../src/view/mhs/examples";

const DIST = "public/vendor/mhs";

const magic = readFileSync(`${DIST}/microhs_runtime.wasm`).subarray(0, 4);
if (Buffer.compare(magic, Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== 0) {
  console.error("bad wasm magic");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, "utf8")) as {
  includeFiles: Record<string, string>;
  packages?: { dist: string }[];
};
const missing = [
  ...Object.keys(manifest.includeFiles),
  ...(manifest.packages ?? []).map((p) => p.dist),
  ...EXAMPLES.map((e) => `examples/${e.name}.json`),
].filter((p) => !existsSync(`${DIST}/${p}`));
if (missing.length > 0) {
  console.error(`missing from dist: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(
  `mhs dist ok: ${Object.keys(manifest.includeFiles).length} lib files, ` +
    `${(manifest.packages ?? []).length} packages, ${EXAMPLES.length} examples`,
);
