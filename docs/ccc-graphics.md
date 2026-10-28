# CCC graphics

Generate tweet images from the MicroHs CCC export and the local BitNet checkpoint.
The renderer uses Combinate's H-tree, radial, and botanical layout functions.
It does not need the main app or the Rust WASM modules.

## Generate

Prepare the adjacent `microhsbitnet-ccc-review` checkout and its pinned MicroHs
compiler. Place the BitNet b1.58 2B4T checkpoint at
`models/bitnet-b1.58-2B-4T/model.safetensors` in that checkout. A symlink works.
Then run these commands from this Combinate checkout:

```sh
npm ci
make -C ../microhsbitnet-ccc-review/spike/ccc graphics-data
npm run graphics:ccc -- \
  ../microhsbitnet-ccc-review/bin/ccc-spike/graphics-data.json \
  ../microhsbitnet-ccc-review/bin/ccc-tweet-graphics
```

PNG generation uses an installed Chrome browser. Set `CHROME` to its executable
path if Chrome is not at the macOS default path. The script reads the checkpoint
from the repository that contains `bin/ccc-spike/graphics-data.json`.
It counts each packed weight field. It does not estimate the distribution.

The output contains eight 3200 × 1800 PNGs, eight vector SVG cards, and three
transparent SVG layouts for each of eight functions. `data.json` contains exact
counts, the complete retained-leaf inventory, and the source, combinators, graph,
and WGSL for each function.

Open `index.html` to inspect the images and compiler outputs. For the WebGPU run,
serve the output directory on localhost and open it in a WebGPU browser:

```sh
python3 -m http.server 8879 --bind 127.0.0.1 \
  --directory ../microhsbitnet-ccc-review/bin/ccc-tweet-graphics
```

The preview shows compiler outputs that were generated at export time. Its input
control runs the exported scalar shader on the GPU. It does not compile edited
source in the browser. The small scalar example does not load the model weights.

## Read the graphics

Dots mark iota leaves. Colored squares mark named, unexpanded leaves:

- Teal: numeric method references and integer conversion functions.
- Blue: array-function references, such as `map`, `zipWith`, `sum`, and `maximum`.
- Gold: concrete typeclass dictionaries, such as `Num Float`.
- Violet: literal values, such as `1.0`.

The pictures expand the combinator basis. They do not expand the implementations
or transitive dependencies of the retained references. Array traversal, numeric
implementations, and dictionary contents are outside these pictures. Supported
method-plus-dictionary applications become numeric graph operations during CCC
lowering. Array-function references become array graph operations. Dictionaries
do not become WGSL values. Literal leaves retain their actual values.

Counts measure leaf occurrences. They do not measure distinct symbols or GPU
instructions. Softmax has ten retained occurrences: `map` twice, `sum`, `maximum`,
`/`, `exp`, `-`, and the `Fractional Float`, `Floating Float`, and `Num Float`
dictionaries. The scalar example has eight: `*`, `+`, `-`, three `Num Float`
dictionary references, and two occurrences of `1.0`.

The eighth card explains every softmax square. Each function in the preview has
a table with the exact symbol, meaning, category, and occurrence count. Standalone
SVGs include the same symbol and meaning in square tooltips. Unknown references
retain their names and use the reference category. The `structure.primitives`
field remains in `data.json` for compatibility. It counts these retained leaves.

Solid edges select the function. Dashed edges select the argument. The atlas
shows program functions. Model weights remain data.

The MicroHs basis passes through `combinatorsToTree` before iota expansion.
This preserves the MicroHs meanings of `O`, `U`, and `J`. Those names have
other meanings in the Combinate catalog. The leaf counts describe these
specific equivalent encodings. They are not minimum-size proofs.

The weight card uses the repository's difference-pair interpretation:
`I (P x 0) = P x 0` keeps the value, `(P x 0) (C P) = P 0 x` negates it,
and a zero weight emits no contribution. Its pure-iota trees use compact
catalog encodings. They differ from the explicit SKI expansion in `Showcase.hs`.

## Verification

Run the strict check for these scripts without the main app's generated modules:

```sh
node_modules/.bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters \
  --target ES2022 --module ESNext --moduleResolution bundler \
  --lib ES2022,DOM,DOM.Iterable --skipLibCheck \
  scripts/ccc-graphics.ts scripts/ccc-structure.ts scripts/ccc-preview.ts
```

The 2026-10-28 check on Apple M4 used a physical `apple metal-3` adapter.
The scalar shader returned 8, 15, -1, and 63 for inputs 3, -4, 0, and 8.
The check found no page errors, missing output links, or text outside a card.
An independent packed-data count matched all three weight totals.

The full `npm run typecheck` also needs the generated Rust modules described
in `CLAUDE.md`. A clean clone without those modules reports missing imports
for `crates/refold/pkg/refold.js` and `crates/reduce/pkg/reduce.js`.
