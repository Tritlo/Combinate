# Release checklist

Born from v12's near-misses (blank META cards for new birds; adopted encodings that
couldn't recognize at game caps; stale generated egg rules). The mechanical half lives
in `npm run check:release` — run it first; the rest is eyes-on. Terse by design.

## Mechanical (`npm run check:release`)

- Every catalog law has META (Zoo blurb + discovery-card name).
- Every PAGES entry resolves to a law.
- `IOTA_FASTEST` ↔ `IOTA_CODE` ↔ `IOTA_STEPS` coherent.
- Every canonical/fastest code decodes → recognizes → its own sym at game probe caps.
- `IOTA_BITCODE` routes through `IOTA_CODE`; ι-counts and golf `iotaCost` agree.
- Generated artifacts fresh: `gen:rules` (egg re-folder) and `gen-minimal-birds`
  produce no diff.

## Eyes-on, by area

**Catalog / new birds** — new bird reachable in play: appears on a PAGES page, hotbar
after discovery, recognizes when built, quest parser has no identifier collision
(`skiq/data.ts` — the bare-`P` lesson), sound/tone works on its card.

**View / UI** — Playwright pass at desktop AND 375px: Zoo list/detail (no floating DOM
controls over the list — the narrow-toggle lesson), discovery card, theme switch while
modals are open, close/reopen leaks nothing. Expand-ι view on a changed bird.

**Golf / scores** — if encodings changed: costs shift is *intended*, note it in the
changelog; stored bests just look stale, that's fine.

**Specs / provenance** — committed spec matches what catalog comments claim (deep-hunt
certificates in `spec/minimal-forms-deep.md`, bound constants like `IOTA_FASTEST_BOUND`
match the report). CHANGELOG has version + date; `package.json` bumped.

**Deploy** — remember `src/core/**` changes bust the mhs-dist cache (one ~5min rebuild);
`npm run build` green locally; after deploy, prod smoke drives the DOM (the dev seam is
DEV-only).
