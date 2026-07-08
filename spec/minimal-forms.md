# Minimal ι-forms (generated — do not edit)

Produced by `npm run minimal-forms` (crates/minimal + this certifier; methodology in
ADR 27). Search bound: **≤ 13 ι** (290512 terms,
0 capped at signature time, all escalated during certification).
Every row below was re-proven against the app's own reducer (`normalize`, fast=false)
at the bird's declared arity; "proven" means the entire cheaper frontier normalized and
differed — a true minimality certificate within the bound.

| bird | arity | current ι | minimal ι | minimal bitcode | status |
|---|---|---|---|---|---|
| EQ | 3 | 8 | 8 | `001010110101011` | proven |
| GT | 3 | 10 | 7 | `0010101101011` | proven ← **3 ι smaller** |
| A | 2 | 3 | 3 | `01011` | proven |
| B | 3 | 18 | 10 | `0101001010101011011` | proven ← **8 ι smaller** |
| I | 1 | 2 | 2 | `011` | proven |
| K | 2 | 4 | 4 | `0101011` | proven |
| M | 1 | 9 | 9 | `00010101011011011` | proven |
| M2 | 2 | 12 | 12 | `00010101011010101011011` | proven |
| O | 2 | 7 | 7 | `0010101011011` | proven |
| S | 3 | 5 | 5 | `010101011` | proven |
| W | 2 | 16 | 13 | `0001010101101010101101011` | proven ← **3 ι smaller** |
| X | 2 | 14 | 6 | `01010101011` | proven ← **8 ι smaller** |
| Z | 3 | 13 | 13 | `0010101011001010110101011` | proven |

Birds not listed found no equal within the bound (`not-found-within-bound`) — their
current encodings may still be reducible at deeper bounds.

## Coincidences (equal arity-5 normal forms)

- **N ≡ Succ** — shared NF `(((vc va) vd) ve)`

## Certification

- 13 bird claims re-proven in TypeScript at declared arity.
- 300/300 reducer-parity samples byte-identical (Rust structKey ↔ TS structKey).
- **ALL CHECKS PASSED.**
