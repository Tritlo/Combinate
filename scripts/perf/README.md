# Combinate Performance Harness

Run the whole suite:

```sh
node scripts/perf/run.mjs
```

Useful variants:

```sh
node scripts/perf/run.mjs --scenario iota-iota
node scripts/perf/run.mjs --json perf.json
node scripts/perf/run.mjs --no-build
```

Each scenario runs three times and reports median/min/max. Browser scenarios boot Vite on a random local port and drive fresh Chromium pages through `globalThis.__combinate`; `bundle` runs `npm run build` unless `--no-build` is set.

## Scenarios

- `boot`: app navigation start to `__combinate` seam availability, plus first paint when Chromium exposes it.
- `iota-iota`: permalink boot of `ι ι`, then time from tree appearance to stable `I`; guards the first-five-minutes regression path.
- `cadence-medium`: rule-mode `8 + 8` Scott numeral reduction at fast-forward; guards time-to-normal-form and per-step cadence.
- `grind-large`: raw-mode `1 + 1` Scott addition at max transport; guards big expanded reduction wall time and max rAF frame gap.
- `record-pipeline`: page-local dynamic import of the recording driver for a 320x240@30 silent MP4; guards encoded-frame throughput.
- `bundle`: production build size; reports main chunk and total dist JS raw/gzip bytes.

## Baseline

Measured on `perf-and-polish` at commit `960462a` (`2026-07-07T18:39:25+02:00`):

```text
scenario         metric               median   min      max
boot             seam_ms              372.4    366.5    723.6
boot             first_paint_ms       28.00    24.00    96.00
iota-iota        nf_ms                2046     2038     2048
iota-iota        steps                3.000    3.000    3.000
cadence-medium   nf_ms                17484    17481    17534
cadence-medium   steps                50.00    50.00    50.00
cadence-medium   inter_step_ms        333.4    333.1    333.8
grind-large      wall_ms              1913     1911     1931
grind-large      steps                77.00    77.00    77.00
grind-large      max_raf_gap_ms       50.10    50.00    66.60
record-pipeline  wall_ms              276.4    266.0    279.1
record-pipeline  frames               15.00    15.00    15.00
record-pipeline  steps                2.000    2.000    2.000
record-pipeline  ms_per_frame         18.43    17.73    18.61
record-pipeline  bytes                14229    14229    14229
bundle           build_ms             6752     6740     6939
bundle           main_js_bytes        622749   622749   622749
bundle           main_js_gzip_bytes   198515   198515   198515
bundle           total_js_bytes       9309819  9309819  9309819
bundle           total_js_gzip_bytes  3226451  3226451  3226451
bundle           js_files             20.00    20.00    20.00
```
