# CCC graphics and full H-tree expansion

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

The output contains eight paired comparison cards and the eight compact/model
cards. Each comparison has a 3200 × 1800 PNG and an SVG poster. Each operation
also has separate compact and expanded H-tree PNGs. Compact trees keep their
three vector layouts. Expanded trees have a full SVG source and an indexed
H-tree grammar. `closure.json` stores the actual rooted compiler definitions.
`data.json` stores both inventories and exact occurrence counts.

Comparison SVG posters embed the full-tree raster image. The separate expanded
SVG stores the complete vector tree with shared graphical definitions. Use the
PNG previews in the browser. Large full SVGs can exceed browser DOM capacity.
The full-tree PNG renderer visits every occurrence and checks its count. It does
not omit deep subtrees. `expanded-render-check.json` records these visit counts.

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

Dots mark iota leaves. Squares mark named terminal leaves. In compact views,
the colors identify these categories:

- Teal: numeric method references and integer conversion functions.
- Blue: array-function references, such as `map`, `zipWith`, `sum`, and `maximum`.
- Gold: concrete typeclass dictionaries, such as `Num Float`.
- Violet: literal values, such as `1.0`.

Expanded views use teal for runtime operations and foreign calls. They use violet
for typed literals. They have no named Haskell function or dictionary leaves.

The compact pictures expand the combinator basis. They retain other function
references, dictionary references, and literal values. Their implementation
bodies are outside the compact picture.

The expanded H-trees include every reachable compiled Haskell body and dictionary.
They include array traversal, method selectors, dictionary fields, and error
paths. Unused dictionary methods remain visible because the full view shows the
complete definition, not an execution trace. Recursive groups use the same finite
`Y` and tuple construction as the pinned MicroHs compiler. Constructor and tuple
machinery also expands into iota. No Haskell definition remains a named leaf.

Runtime primitives, foreign calls, and typed literal values remain named in the
expanded view. Native Float and machine Int operations retain their original
semantics. They are not replaced with Scott natural-number arithmetic. The full
view has no unresolved-reference or truncation fallback. Missing definitions
and unlowered cycles cause an error.

The indexed grammar reuses identical subtrees in storage. Every reference denotes
an occurrence in the full H-tree. Canvas walks all occurrences without creating
millions of browser DOM nodes. At overview scale, deep nodes overlap or become
smaller than one pixel. The raster uses minimum mark sizes for visibility. The
full SVG retains the exact nested H-tree transforms. It has no three-decimal
coordinate rounding. These counts describe program syntax, not GPU instructions.

The compact GPU compiler behavior is unchanged. During CCC lowering, supported
method-plus-dictionary applications become numeric graph operations. Array
references become array graph operations. Dictionaries do not become WGSL values.

Counts measure leaf occurrences. They do not measure distinct symbols or GPU
instructions. Compact softmax has ten retained occurrences: `map` twice, `sum`, `maximum`,
`/`, `exp`, `-`, and the `Fractional Float`, `Floating Float`, and `Num Float`
dictionaries. The scalar example has eight: `*`, `+`, `-`, three `Num Float`
dictionary references, and two occurrences of `1.0`.

The compact leaf-key card explains every compact softmax square. Each function
in the preview has a table with the exact symbol, meaning, category, and occurrence count. Standalone
SVGs include the same symbol and meaning in square tooltips. Unknown references
retain their names and use the reference category. The `structure.primitives`
field remains in `data.json` for compatibility. It counts the terminal leaf
occurrences at the selected expansion level.

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
  scripts/ccc-graphics.ts scripts/ccc-structure.ts scripts/ccc-preview.ts \
  scripts/ccc-raster.ts scripts/ccc-page.ts scripts/ccc-package.ts
```

The 2026-10-28 check on Apple M4 used a physical `apple metal-3` adapter.
The scalar shader returned 8, 15, -1, and 63 for inputs 3, -4, 0, and 8.
The check found no page errors, missing output links, or text outside a card.
An independent packed-data count matched all three weight totals.

The full `npm run typecheck` also needs the generated Rust modules described
in `CLAUDE.md`. A clean clone without those modules reports missing imports
for `crates/refold/pkg/refold.js` and `crates/reduce/pkg/reduce.js`.

The expanded export passed a stock-runtime witness for all eight operations.
Outputs before and after recursive-group normalization were byte-identical.
The witness includes mutual-recursion groups of up to 51 definitions. Constructor
encodings match the pinned runtime equations. Grammar counts and bounds match
materialized small trees. Full rasters visit every counted occurrence. The
expanded trees contain only runtime/foreign operations and typed literal leaves.

The 2026-10-29 check also round-tripped the actual TypeScript iota grammar through
the stock evaluator. Each iota was encoded as `S (S I (K S)) (K K)`. Runtime and
literal tokens retained their stock encodings. All eight operations produced
byte-identical output. The comparison gallery and its six-stage GPU tour passed
on a physical Apple Metal adapter.

## Package the public research demo

The landing page starts with the paired softmax image. It contains the eight
operation pairs, exact leaf inventories, compiler outputs, and a small WebGPU
example. The tabs support the arrow keys, Home, and End. Images reserve their
layout space. The gallery does not fetch remote resources.

Build the optional model runtime first. It uses an explicit start button and
pins the model and tokenizer to the checked Hugging Face snapshot. The small
example does not load that model.

```sh
npm --prefix ../microhsbitnet-ccc-review/spike/ccc/web ci
make -C ../microhsbitnet-ccc-review/spike/ccc web-demo
npm run demo:ccc -- \
  ../microhsbitnet-ccc-review/bin/ccc-expanded-graphics \
  ../microhsbitnet-ccc-review \
  ../microhsbitnet-ccc-review/bin/ccc-public-demo
```

The destination must be empty. The package includes `ccc-demo.zip`, a scoped
`source.zip`, exact source revisions, and license notices. It includes the model
runtime when all its assets are available. It never includes model weights.
The source archive records the selected files and their SHA-256 hashes. It
references the pinned MicroHs checkout instead of copying that full repository.

Extract the demo archive and serve that directory with Python's HTTP server.
No build or dependency install is required to view it. Public hosting must use
HTTPS for WebGPU. Packaging does not publish anything.

The compiler is a research implementation for a defined subset. The physical
M4 model check matched 52/52 reference tokens, but its 1% numerical error target
still fails. The five-prompt showcase completed on 2026-10-29 with a 24-token
limit per prompt. It generated 76 tokens across 216 positions on the physical
M4 GPU. That run used the local verified checkpoint and pinned remote tokenizer.
It did not compare reference outputs. Do not describe the package as a
production compiler or full numerical parity.

## Published gallery

The reviewed static bundle is published at
[github.mpg.is/microhsbitnet](https://github.mpg.is/microhsbitnet/).
GitHub Pages serves `codex/ccc-demo-pages` in `Tritlo/microhsbitnet` with HTTPS.
The compiler and renderer source branches are named `codex/ccc-public-demo`.
The bundle records the exact revisions used to build it.

The 2026-10-29 public check passed on a physical M4 GPU. It checked four scalar
inputs, 81 linked files, mobile layout, keyboard tabs, and the model download
gate. The public HTML and demo ZIP match the reviewed local files byte for byte.
