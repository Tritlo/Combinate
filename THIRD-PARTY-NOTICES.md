# Third-party notices

Combinate is licensed under the MIT License (see [LICENSE](LICENSE)). It bundles,
compiles in, links, or loads the third-party components below, each under its own
license. Verbatim license texts are in the [`licenses/`](licenses/) directory.

## Bundled / distributed

These ship in the deployed app (or the `vendor-assets` release), so their licenses
travel with it.

### MicroHs — Apache License 2.0

Copyright 2023–2026 Lennart Augustsson.
<https://github.com/augustss/MicroHs>

Combinate distributes a WebAssembly build of a **fork** of MicroHs (the Rust
runtime `microhs_runtime.wasm` + `mhs.comb`) for the in-browser Haskell compiler,
and the reducer, the Scott-encoded primitive handling, and the custom Prelude are
adapted from it. Modifications: forked (the `vendor/microhs` submodule,
<https://github.com/Tritlo/MicroHs>), built to WebAssembly, and the compiler's
`toCombinators` output is post-processed into ι trees rather than the compiler
being changed. Full text:
[`licenses/MicroHs-Apache-2.0.txt`](licenses/MicroHs-Apache-2.0.txt).

### egg — MIT

Copyright 2019 Max Willsey. <https://github.com/egraphs-good/egg>

The re-folding lens (`crates/refold`) compiles `egg` into WebAssembly to re-sugar
SKI normal forms back into named combinators. Full text:
[`licenses/egg-MIT.txt`](licenses/egg-MIT.txt).

### Pixi.js — MIT

Copyright (c) 2013–2023 Mathew Groves, Chad Engler. <https://pixijs.com>

Bundled as the rendering engine. Full text:
[`licenses/Pixi.js-MIT.txt`](licenses/Pixi.js-MIT.txt).

### Three.js — MIT

Copyright © 2010–2026 three.js authors. <https://threejs.org>

Bundled (lazy-loaded on first 3D entry) as the renderer for the 3D "packed
sphere" view. Full text:
[`licenses/Three.js-MIT.txt`](licenses/Three.js-MIT.txt).

### IoskeleyMono — SIL Open Font License 1.1

Copyright (c) 2025 Ahmed Hatem. <https://github.com/ahatem/IoskeleyMono>

The webfont of the menu bar, tool palette, and Haskell editor (a build of
Iosevka). Distributed on the `vendor-assets` release. "IoskeleyMono" is a Reserved
Font Name under the OFL. Full text:
[`licenses/IoskeleyMono-OFL-1.1.txt`](licenses/IoskeleyMono-OFL-1.1.txt).

## Loaded at runtime (not redistributed)

### DuckDB-WASM — MIT

Copyright 2018–2025 Stichting DuckDB Foundation. <https://github.com/duckdb/duckdb-wasm>

The optional `?store=duckdb` backend is loaded from the public jsDelivr CDN at
runtime; Combinate does not redistribute it. Full text:
[`licenses/DuckDB-WASM-MIT.txt`](licenses/DuckDB-WASM-MIT.txt).

## Acknowledgements

- **Raymond Smullyan** — the combinator "bird" names (Mockingbird, Kestrel,
  Starling, …) are from *To Mock a Mockingbird* (1985).
- **Lennart Augustsson / MicroHs** — the inspiration (and the working machinery)
  for compiling real Haskell down to a combinator tree in the browser.
