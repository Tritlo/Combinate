# Minimal ι-forms (generated — do not edit)

Produced by `npm run minimal-forms` (crates/minimal + this certifier; methodology in
ADR 27). Search bound: **≤ 40 ι** (1132211568 terms,
26875211 capped at signature time, all escalated during certification).
Every row below was re-proven against the app's own reducer (`normalize`, fast=false)
at the bird's declared arity; "proven" means the entire cheaper frontier normalized and
differed — a true minimality certificate within the bound.

| bird | arity | current ι | minimal ι | minimal bitcode | status |
|---|---|---|---|---|---|
| LT | 3 | 17 | 17 | `000101010110010101101010110101011` | conditional | 42→42 steps |
| EQ | 3 | 8 | 8 | `001010110101011` | proven | 20→20 steps |
| GT | 3 | 7 | 7 | `0010101101011` | proven | 18→18 steps |
| 1 | 2 | 18 | 18 | `00101011000101010110010101110101011` | conditional | 43→43 steps |
| 2 | 2 | 70 | 34 | `0010101100010101011011001010110010101100010101011011001010110101011` | conditional ← **36 ι smaller** | 166→78 steps |
| A | 2 | 3 | 3 | `01011` | proven | 8→8 steps |
| B | 3 | 10 | 10 | `0101001010101011011` | proven | 32→32 steps |
| B1 | 4 | 22 | 22 | `0000101010110101010101110101001010101011011` | conditional | 126→104 steps (≠ minimal form) |
| B2 | 5 | 29 | 29 | `000010101011001000101010111010101011110101001010101011011` | conditional | 270→197 steps (≠ minimal form) |
| B3 | 4 | 27 | 27 | `00001010101100101010110101010101110101001010101011011` | conditional | 176→147 steps (≠ minimal form) |
| C | 3 | 29 | 29 | `001000010101011011000101010111100010101011101010110101011` | conditional | 345→93 steps (≠ minimal form) |
| D | 4 | 16 | 16 | `0000101010111101001010101011011` | conditional | 76→54 steps (≠ minimal form) |
| E | 5 | 28 | 28 | `0000101010111000101010110101010101110101001010101011011` | conditional | 173→148 steps (≠ minimal form) |
| H | 3 | 30 | 30 | `00010101011000010101011110001010101110101011001010110101011` | conditional | 122→105 steps (≠ minimal form) |
| I | 1 | 2 | 2 | `011` | proven | 5→5 steps |
| K | 2 | 4 | 4 | `0101011` | proven | 10→10 steps |
| L | 2 | 27 | 27 | `00101000101010110110101010110010101100010101011011011` | conditional | 71→71 steps |
| M | 1 | 9 | 9 | `00010101011011011` | proven | 22→22 steps |
| M2 | 2 | 12 | 12 | `00010101011010101011011` | proven | 29→29 steps |
| M3 | 1 | 13 | 13 | `0001010101101010101011011` | proven | 32→32 steps |
| N | 3 | 33 | 33 | `00010101011001010110001010101100101011010101100101010110110101011` | conditional | 81→81 steps (≠ minimal form) |
| O | 2 | 7 | 7 | `0010101011011` | proven | 17→17 steps |
| O2 | 2 | 11 | 11 | `001010101101010101011` | proven | 27→27 steps |
| Pe | 3 | 10 | 10 | `0010101011010101011` | proven | 24→24 steps |
| Pred | 1 | 26 | 25 | `0001010101100010101011001010111010101100101011011` | conditional ← **1 ι smaller** | 61→58 steps |
| Q | 3 | 25 | 25 | `0000010101011101010101101010010101010110110101011` | conditional | 101→79 steps (≠ minimal form) |
| Q3 | 3 | 28 | 28 | `0010101011010000101010111010101011001010110010101011011` | conditional | 134→81 steps (≠ minimal form) |
| R | 3 | 32 | 32 | `001010001010101101100010101011101000101010110110101010110101011` | conditional | 127→88 steps (≠ minimal form) |
| S | 3 | 5 | 5 | `010101011` | proven | 12→12 steps |
| Succ | 3 | 33 | 33 | `00010101011001010110001010101100101011010101100101010110110101011` | conditional | 81→81 steps (≠ minimal form) |
| T | 2 | 20 | 20 | `000101010110010101100101010110110101011` | conditional | 49→49 steps |
| U | 2 | 23 | 23 | `000101010110010101011001010110010101011011011` | conditional | 56→56 steps |
| W | 2 | 13 | 13 | `0100101010110001010101111` | proven | 33→32 steps (≠ minimal form) |
| X | 2 | 6 | 6 | `01010101011` | proven | 15→15 steps |
| not | 1 | 30 | 30 | `00010101011000101010110101010110010101110010101100101011011` | conditional | 70→70 steps (≠ minimal form) |
| and | 2 | 14 | 14 | `000101010110010101110101011` | proven | 33→33 steps |
| or | 2 | 24 | 24 | `00010101011010101011001010110010101100101011011` | conditional | 56→56 steps |
| head | 1 | 26 | 26 | `000100010101011101010101101100101011001010110101011` | conditional | 136→48 steps (≠ minimal form) |
| null | 1 | 38 | 36 | `00010101011000101010110110010101100101011011001010101011001010110101011` | conditional ← **2 ι smaller** | 88→88 steps (≠ minimal form) |
| tail | 1 | 30 | 29 | `000101010110001010101100101011101010110010101100101011011` | conditional ← **1 ι smaller** | 70→67 steps |
| Z | 3 | 13 | 13 | `0010101011001010110101011` | proven | 32→32 steps |
| Z2 | 4 | 22 | 22 | `0010101011001010110010101011001010110101011` | conditional | 54→54 steps |
| Phi | 4 | 26 | 26 | `000010101011010101011100101010101100101011010101011` | conditional | 144→103 steps (≠ minimal form) |

Birds not listed found no equal within the bound (`not-found-within-bound`) — their
current encodings may still be reducible at deeper bounds.

## Coincidences (equal arity-5 normal forms)

- **N ≡ Succ** — shared NF `(((vc va) vd) ve)`

## Certification

- 43 bird claims re-proven in TypeScript at declared arity.
- 0/0 reducer-parity samples byte-identical (Rust structKey ↔ TS structKey).
- **ALL CHECKS PASSED.**
