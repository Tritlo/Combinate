import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { chromium } from "playwright-core";
import { buildStructure, renderStructure, structureStats } from "./ccc-structure";

/** Compiler records exported by the CCC graphics driver. */
interface Entry {
  id: string;
  label: string;
  source: string;
  sourceFile: string;
  combinators: string;
  graph: string;
  wgsl: string;
  path: string;
}

/** One tensor in the safetensors header. */
interface Tensor {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
}

const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw new Error("Usage: node --import tsx scripts/ccc-graphics.ts GRAPHICS_JSON OUTPUT_DIRECTORY");
const output = resolve(destination);
const root = resolve(dirname(input), "../..");
const data = JSON.parse(await readFile(input, "utf8")) as { entries: Entry[]; scalarShader: string };
const { entries } = data;
if (!data.scalarShader) throw new Error("Export graphics-data again to include the scalar shader");
const terms = new Map(entries.map((entry) => [entry.id, buildStructure(entry.combinators)]));
const colors = { ink: "#1d2528", red: "#d84132", muted: "#697375", line: "#dbded9", paper: "#f7f7f2", teal: "#087f83", blue: "#355fc1", gold: "#ad7720", violet: "#8055a7" };
await mkdir(output, { recursive: true });

/** Escape text used in SVG and HTML. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Place one text line. */
function text(value: string, x: number, y: number, size = 24, color = colors.ink, extra = ""): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(value)}</text>`;
}

/** Place exact source lines without changing their spelling. */
function code(value: string, x: number, y: number, size = 20, line = 30, color = colors.ink): string {
  return value.split("\n").map((part, i) => text(part, x, y + i * line, size, color, 'font-family="Menlo,Consolas,monospace" xml:space="preserve"')).join("");
}

/** Draw a label and a value in one column. */
function metric(value: string, label: string, x: number, y: number, color = colors.ink): string {
  return text(value, x, y, 52, color, 'font-weight="650" letter-spacing="-1.5"') + text(label, x, y + 34, 19, colors.muted);
}

/** Place an SVG tree in a composition. */
function tree(id: string, x: number, y: number, width: number, height: number, color = colors.red, layout: "htree" | "radial" | "botanical" = "htree"): string {
  const node = terms.get(id);
  if (!node) throw new Error(`Missing term ${id}`);
  return `<g transform="translate(${x} ${y})">${renderStructure(node, { width, height, color, primitiveColor: colors.teal, layout })}</g>`;
}

/** Provide common typography, dimensions, and provenance for one tweet image. */
function frame(body: string, name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${esc(name)}"><style>text{font-family:Arial,Helvetica,sans-serif} text[font-family]{font-family:Menlo,Consolas,monospace}</style><rect width="1600" height="900" fill="${colors.paper}"/>${body}<line x1="64" y1="849" x2="1536" y2="849" stroke="${colors.line}"/>${text("BITNETCOMB  /  MICROHS  /  COMBINATE", 64, 878, 14, colors.muted, 'letter-spacing="1.4"')}${text("Actual model data · actual compiled terms", 1140, 878, 14, colors.muted)}</svg>`;
}

/** Read model dimensions and count the values represented by packed bytes. */
async function modelStats(): Promise<Record<string, unknown>> {
  const path = resolve(root, "models/bitnet-b1.58-2B-4T/model.safetensors");
  const file = await open(path);
  try {
    const prefix = Buffer.alloc(8);
    await file.read(prefix, 0, 8, 0);
    const headerBytes = Number(prefix.readBigUInt64LE());
    const headerData = Buffer.alloc(headerBytes);
    await file.read(headerData, 0, headerBytes, 8);
    const header = JSON.parse(headerData.toString("utf8")) as Record<string, Tensor>;
    const tensors = Object.entries(header).filter(([key]) => key !== "__metadata__");
    const matrices = tensors.filter(([, tensor]) => tensor.dtype === "U8");
    const histogram = new Float64Array(256);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let logicalWeights = 0;
    for (const [name, tensor] of tensors) {
      if (name.endsWith(".weight")) logicalWeights += tensor.shape.reduce((a, b) => a * b, 1) * (tensor.dtype === "U8" ? 4 : 1);
    }
    for (const [, tensor] of matrices) {
      let offset = tensor.data_offsets[0];
      while (offset < tensor.data_offsets[1]) {
        const count = Math.min(chunk.length, tensor.data_offsets[1] - offset);
        const { bytesRead } = await file.read(chunk, 0, count, 8 + headerBytes + offset);
        if (bytesRead !== count) throw new Error("Incomplete model read");
        for (let i = 0; i < count; i++) histogram[chunk[i]!]!++;
        offset += count;
      }
    }
    const trits = [0, 0, 0, 0];
    for (let byte = 0; byte < 256; byte++) {
      for (let shift = 0; shift < 8; shift += 2) trits[(byte >> shift) & 3]! += histogram[byte]!;
    }
    if (trits[3] !== 0) throw new Error("Invalid packed trits in model");
    const q = header["model.layers.0.self_attn.q_proj.weight"]!;
    const sample = Buffer.alloc(16);
    await file.read(sample, 0, 16, 8 + headerBytes + q.data_offsets[0]);
    return { name: "BitNet b1.58 2B4T", logicalWeights, ternaryWeights: trits[0]! + trits[1]! + trits[2]!, negative: trits[0], zero: trits[1], positive: trits[2], matrices: matrices.length, layers: matrices.length / 7, hidden: q.shape[1], intermediate: header["model.layers.0.mlp.up_proj.weight"]!.shape[0]! * 4, vocabulary: header["model.embed_tokens.weight"]!.shape[0], fileBytes: (await stat(path)).size, tensors: tensors.length, sampleWeights: [...sample].map((value) => (value & 3) - 1), source: "local Microsoft model.safetensors header and packed tensor data" };
  } finally { await file.close(); }
}

const model = await modelStats();
const scalar = entries.find((entry) => entry.id === "scalar")!;
const softmax = entries.find((entry) => entry.id === "softmax")!;
const b = (value: unknown): string => (Number(value) / 1e9).toFixed(2);
const hero = frame(
  text("A NUMERICAL PROGRAM, FOUR WAYS", 64, 70, 17, colors.red, 'font-weight="600" letter-spacing="2.8"') +
  text("Haskell in.", 64, 163, 80, colors.ink, 'font-weight="700" letter-spacing="-3"') +
  text("GPU code out.", 64, 251, 80, colors.ink, 'font-weight="700" letter-spacing="-3"') +
  text("Functions become combinators. Structure becomes a picture.", 68, 301, 23, colors.muted) +
  `<rect x="64" y="355" width="570" height="204" rx="9" fill="#fff" stroke="${colors.line}"/>` +
  text("01 / HASKELL SOURCE", 88, 391, 15, colors.red, 'letter-spacing="1.7"') +
  code(scalar.source, 88, 434, 19, 34) +
  text("The picture is this function’s compiled structure.", 88, 530, 18, colors.muted) +
  tree("scalar", 661, 120, 865, 551) +
  text("02 / EXPANDED INTO ι", 1020, 119, 15, colors.red, 'letter-spacing="1.7"') +
  text("ι structure", 997, 652, 19, colors.red) + text("■ primitive leaves", 1139, 652, 18, colors.teal) +
  text("BITNET b1.58 2B4T / MODEL STATISTICS", 68, 616, 15, colors.muted, 'letter-spacing="1.4"') +
  metric(b(model.logicalWeights) + "B", "weight values", 68, 683) + metric(String(model.layers), "decoder layers", 300, 683) + metric(b(model.fileBytes) + " GB", "packed checkpoint", 506, 683) +
  `<line x1="64" y1="754" x2="1536" y2="754" stroke="${colors.line}"/>` +
  text("Haskell", 66, 805, 25, colors.ink, 'font-weight="600"') + text("→", 270, 805, 29, colors.red) +
  text("MicroHs combinators", 338, 805, 25, colors.ink, 'font-weight="600"') + text("→", 695, 805, 29, colors.red) +
  text("CCC / array graph", 763, 805, 25, colors.ink, 'font-weight="600"') + text("→", 1098, 805, 29, colors.red) +
  text("WGSL / WebGPU", 1166, 805, 25, colors.ink, 'font-weight="600"'), "Haskell to combinators to GPU");

const subjects = [
  ["softmax", "Softmax", colors.red], ["rmsNorm", "RMSNorm", colors.teal], ["gated", "Squared-ReLU gate", colors.blue],
  ["rotateFirst", "Rotary embedding", colors.gold], ["contribution", "Trit contribution", colors.violet], ["scalar", "Scalar arithmetic", colors.ink],
] as const;
const atlas = frame(
  text("THE SHAPES OF THE PROGRAM", 64, 65, 17, colors.red, 'letter-spacing="2.8" font-weight="600"') +
  text("Different functions. The same ι.", 64, 135, 60, colors.ink, 'letter-spacing="-2" font-weight="700"') +
  text("Real MicroHs terms, expanded with Combinate’s layouts.", 66, 176, 23, colors.muted) +
  subjects.map(([id, title, color], i) => {
    const x = 64 + (i % 3) * 500;
    const y = 214 + Math.floor(i / 3) * 290;
    const stats = structureStats(terms.get(id)!);
    return `<rect x="${x}" y="${y}" width="472" height="268" rx="7" fill="#fff" stroke="${colors.line}"/>` +
      tree(id, x + 12, y + 15, 448, 197, color) + text(title, x + 22, y + 234, 24, color, 'font-weight="600"') +
      text(`${stats.iotas} ι  ·  ${stats.primitives} primitive leaves`, x + 22, y + 257, 14, colors.muted);
  }).join("") +
  text("Dots are ι. Squares retain numeric operations, dictionaries, literals, and array intrinsics.", 66, 827, 18, colors.muted), "Iota atlas of model program parts");

const ops = [
  { term: "C P", value: "−1", action: "NEGATE", color: colors.red, count: Number(model.negative), note: "(P x 0) (C P) = P 0 x" },
  { term: "K", value: "0", action: "DROP", color: colors.teal, count: Number(model.zero), note: "No contribution is emitted." },
  { term: "I", value: "+1", action: "KEEP", color: colors.blue, count: Number(model.positive), note: "I (P x 0) = P x 0" },
];
const total = Number(model.ternaryWeights);
const weights = frame(
  text("BITNET b1.58 2B4T / THE LIST-OP INTERPRETATION", 64, 65, 17, colors.red, 'letter-spacing="2.2" font-weight="600"') +
  text("2.08B weights. Three operations.", 64, 143, 60, colors.ink, 'letter-spacing="-2.4" font-weight="700"') +
  text("A ternary weight chooses a function instead of a multiplication.", 66, 188, 25, colors.muted) +
  ops.map((op, i) => {
    const x = 64 + i * 500;
    const node = buildStructure(op.term);
    const svg = renderStructure(node, { width: 420, height: 240, color: op.color, layout: "htree" });
    return `<rect x="${x}" y="241" width="472" height="435" rx="8" fill="#fff" stroke="${colors.line}"/>` +
      text(op.value, x + 26, 307, 54, op.color, 'font-weight="650"') + text(op.action, x + 125, 295, 17, op.color, 'letter-spacing="2"') +
      text(op.term, x + 125, 325, 24, colors.ink, 'font-family="Menlo,monospace"') +
      `<g transform="translate(${x + 26} 346)">${svg}</g>` +
      text(op.note, x + 26, 611, 20, colors.ink) + text(`${(op.count / total * 100).toFixed(2)}% of ternary weights`, x + 26, 649, 22, op.color, 'font-weight="600"');
  }).join("") +
  ops.map((op, i) => {
    const prior = ops.slice(0, i).reduce((n, o) => n + o.count, 0);
    return `<rect x="${64 + prior / total * 1472}" y="720" width="${op.count / total * 1472}" height="24" fill="${op.color}"/>`;
  }).join("") +
  text("210 BitLinear matrices  ·  four ternary weights per packed byte", 66, 786, 25, colors.ink, 'font-weight="600"') +
  text("Negation uses the repository’s difference-pair encoding. Trees show compact equivalent ι forms.", 66, 825, 17, colors.muted), "Ternary weights as three combinators");

const softTree = terms.get("softmax")!;
const softStats = structureStats(softTree);
const softmaxCard = frame(
  text("A CLOSER LOOK / SOFTMAX", 64, 65, 17, colors.red, 'font-weight="600" letter-spacing="2.8"') +
  text("A few lines. A whole structure.", 64, 141, 64, colors.ink, 'font-weight="700" letter-spacing="-2.3"') +
  text("The same source defines the array program and the generated GPU work.", 66, 187, 24, colors.muted) +
  `<rect x="64" y="239" width="700" height="420" rx="8" fill="#fff" stroke="${colors.line}"/>` +
  text("HASKELL / EXACT SOURCE", 90, 277, 15, colors.red, 'letter-spacing="1.7"') +
  code(softmax.source, 90, 324, 16.5, 35) +
  tree("softmax", 792, 212, 744, 505, colors.red, "htree") +
  metric(String(softStats.iotas), "ι leaves in this structure", 800, 769, colors.red) +
  metric(String(softStats.primitives), "primitive leaves retained", 1176, 769, colors.teal) +
  text("maximum → map exp → ordered sum → map divide", 66, 716, 22, colors.ink, 'font-family="Menlo,monospace"') +
  text("MicroHs emits the term.", 66, 763, 22, colors.muted) +
  text("The CCC backend derives its workgroup plan.", 66, 797, 22, colors.muted) +
  text("The picture retains numeric and array primitives.", 66, 827, 17, colors.muted), "Softmax source and its actual iota structure");

const rms = terms.get("rmsNorm")!;
const rmsStats = structureStats(rms);
const views = frame(
  text("COMBINATE / THREE LAYOUTS OF THE SAME TERM", 64, 65, 17, colors.red, 'letter-spacing="2.2" font-weight="600"') +
  text("One function. Three ways to see it.", 64, 143, 60, colors.ink, 'letter-spacing="-2.2" font-weight="700"') +
  text(`RMSNorm  ·  ${rmsStats.iotas} ι leaves  ·  ${rmsStats.primitives} primitive leaves  ·  no changes to the program`, 66, 191, 23, colors.muted) +
  (["htree", "radial", "botanical"] as const).map((layout, i) => {
    const x = 64 + i * 500;
    const color = [colors.red, colors.teal, colors.blue][i]!;
    const title = ["H-tree", "Radial", "Botanical"][i]!;
    return `<rect x="${x}" y="247" width="472" height="492" rx="8" fill="#fff" stroke="${colors.line}"/>` +
      tree("rmsNorm", x + 12, 260, 448, 403, color, layout) + text(title, x + 24, 708, 27, color, 'font-weight="600"');
  }).join("") + text("The layout changes. The application tree and its leaves stay the same.", 66, 801, 24, colors.muted), "Three Combinate layouts of RMSNorm");

const modelCard = frame(
  text("THE MODEL / COUNTS FROM THE ACTUAL CHECKPOINT", 64, 65, 17, colors.red, 'letter-spacing="2.2" font-weight="600"') +
  text(String(model.name), 64, 144, 68, colors.ink, 'letter-spacing="-2.4" font-weight="700"') +
  text("30 decoder layers. Seven ternary projections per layer.", 66, 192, 25, colors.muted) +
  metric(b(model.logicalWeights) + "B", "total weight values", 68, 301) +
  metric(b(model.ternaryWeights) + "B", "ternary weight values", 592, 301, colors.red) +
  metric(b(model.fileBytes) + " GB", "checkpoint on disk", 1130, 301, colors.teal) +
  text("210 BITLINEAR MATRICES", 66, 389, 16, colors.muted, 'letter-spacing="1.6"') +
  Array.from({ length: Number(model.layers) }, (_, i) => {
    const x = 64 + (i % 6) * 168;
    const y = 409 + Math.floor(i / 6) * 66;
    return `<rect x="${x}" y="${y}" width="156" height="56" rx="5" fill="#fff" stroke="${colors.line}"/>` +
      text(`LAYER ${String(i).padStart(2, "0")}`, x + 12, y + 18, 11, colors.muted, 'letter-spacing="1"') +
      Array.from({ length: 7 }, (_, j) => `<rect x="${x + 12 + j * 19}" y="${y + 29}" width="13" height="14" rx="2" fill="${j < 4 ? colors.red : colors.teal}"/>`).join("");
  }).join("") +
  metric(Number(model.hidden).toLocaleString("en-US"), "hidden width", 1130, 446) +
  metric(Number(model.intermediate).toLocaleString("en-US"), "feed-forward width", 1130, 578) +
  metric(Number(model.vocabulary).toLocaleString("en-US"), "vocabulary size", 1130, 710) +
  text("■ Q / K / V / O", 66, 790, 21, colors.red, 'font-weight="600"') +
  text("■ gate / up / down", 322, 790, 21, colors.teal, 'font-weight="600"') +
  text("Ternary projections: 86.37% of weight values. Embeddings and norms retain their stored precision.", 66, 827, 18, colors.muted), "BitNet model statistics and its 210 ternary matrices");

/** Apply the dark palette without changing the drawing geometry. */
function night(svg: string): string {
  return [[colors.paper, "#0b1117"], [colors.ink, "#f1f2e9"], [colors.muted, "#a7b3b8"], [colors.line, "#2b3942"], [colors.red, "#ff8970"], [colors.teal, "#63dbc3"], ["#fff\"", "#101c25\""]].reduce((result, [from, to]) => result.split(from!).join(to!), svg);
}

const cards = [
  { id: "01-haskell-to-gpu", title: "Haskell → combinators → GPU", svg: hero },
  { id: "02-program-atlas", title: "An atlas of the program", svg: atlas },
  { id: "03-three-weight-operations", title: "2.08B ternary weights, three operations", svg: weights },
  { id: "04-softmax", title: "Softmax, expanded", svg: softmaxCard },
  { id: "05-three-layouts", title: "One function, three views", svg: views },
  { id: "06-haskell-to-gpu-night", title: "Source to GPU, dark variant", svg: night(hero) },
  { id: "07-model-statistics", title: "The model in numbers", svg: modelCard },
];
for (const entry of entries) {
  for (const layout of ["htree", "radial", "botanical"] as const) await writeFile(resolve(output, `tree-${entry.id}-${layout}.svg`), renderStructure(terms.get(entry.id)!, { width: 1200, height: 1200, color: colors.red, primitiveColor: colors.teal, layout }));
}
for (const card of cards) await writeFile(resolve(output, `${card.id}.svg`), card.svg);
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  for (const card of cards) {
    await page.setContent(`<!doctype html><html><body style="margin:0">${card.svg}</body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: resolve(output, `${card.id}.png`), clip: { x: 0, y: 0, width: 1600, height: 900 } });
  }
} finally { await browser.close(); }
const provenance = { model, entries: entries.map((entry) => ({ ...entry, structure: structureStats(terms.get(entry.id)!) })), note: "Iota expands combinator structure. Numeric operations, dictionaries, literals, and array intrinsics remain opaque leaves. The weight-operation card uses equivalent compact pure-iota forms of I, K, and MicroHs C P." };
await writeFile(resolve(output, "data.json"), JSON.stringify(provenance, null, 2) + "\n");
const previewScript = transpileModule(await readFile(fileURLToPath(new URL("./ccc-preview.ts", import.meta.url)), "utf8"), { compilerOptions: { target: ScriptTarget.ES2020, module: ModuleKind.ESNext } }).outputText;
const live = `<section id="live-demo"><h2>Follow one function to the GPU</h2><p>These compiler outputs come from the source below. The generated shader runs here on your GPU.</p><nav role="tablist" aria-label="Compiler outputs">${["source", "combinators", "tree", "graph", "wgsl"].map((stage, i) => `<button type="button" role="tab" data-view="${stage}" aria-selected="${i === 0}">${i + 1} / ${["Haskell", "Combinators", "Iota", "CCC", "WGSL"][i]}</button>`).join("")}</nav><div class="representations"><pre data-stage="source">${esc(scalar.source)}</pre><pre data-stage="combinators" hidden>${esc(scalar.combinators)}</pre><div data-stage="tree" hidden>${renderStructure(terms.get("scalar")!, { width: 850, height: 340, color: colors.red, primitiveColor: colors.teal, layout: "htree" })}</div><pre data-stage="graph" hidden>${esc(scalar.graph)}</pre><pre data-stage="wgsl" hidden>${esc(scalar.wgsl)}</pre></div><div class="run"><label for="gpu-input">Input <output id="input-value">3</output></label><input id="gpu-input" type="range" min="-8" max="8" step="0.5" value="3"><button id="gpu-tour" type="button">Follow source to GPU</button><button id="gpu-run" type="button">Run on GPU</button><span class="result">GPU result <output id="gpu-result" aria-live="polite">—</output></span></div><p id="gpu-status" role="status">Run the generated shader with this input.</p><p class="note">Compilation runs when the graphics data is exported. This preview executes the exported shader. The model weights do not load in this small example.</p></section>`;
await writeFile(resolve(output, "scalar.wgsl"), data.scalarShader);
await writeFile(resolve(output, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CCC · source to GPU</title><style>body{margin:0;padding:40px;background:${colors.paper};color:${colors.ink};font:18px/1.5 system-ui}main{max-width:1300px;margin:auto}h1{font-size:42px;letter-spacing:-1.5px}nav{display:flex;gap:12px;flex-wrap:wrap}a{color:${colors.red}}figure{margin:40px 0}img{width:100%;border:1px solid ${colors.line};border-radius:8px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 Menlo,monospace;padding:20px;background:white;border:1px solid ${colors.line}}article{margin:32px 0}footer{margin-top:48px;color:${colors.muted}}#live-demo{margin:40px 0;padding:28px;border:1px solid ${colors.line};border-radius:12px;background:white}button{font:inherit;border:1px solid ${colors.line};border-radius:6px;padding:8px 14px;background:${colors.paper};color:${colors.ink};cursor:pointer}button[aria-selected="true"],#gpu-tour{background:${colors.red};color:white;border-color:${colors.red}}button:disabled{opacity:.5;cursor:wait}.representations{height:350px;overflow:auto;margin:20px 0}.representations pre{margin:0;border:0;font-size:18px}.representations svg{width:100%;height:340px}.run{display:flex;align-items:center;gap:16px;flex-wrap:wrap}#input-value{font-weight:700;font-variant-numeric:tabular-nums}#gpu-input{accent-color:${colors.red};width:180px}.result{margin-left:auto}#gpu-result{font-size:48px;font-weight:700;color:${colors.red};padding-left:15px}.note{font-size:14px;color:${colors.muted}}[hidden]{display:none!important}@media(max-width:700px){body{padding:18px}h1{font-size:32px}#live-demo{padding:18px}.representations{height:300px}.result{margin-left:0}}</style><main><h1>Haskell → combinators → GPU</h1><p>Tweet images drawn from actual MicroHs terms with Combinate’s layouts. PNGs are 3200 × 1800. SVGs retain vector detail.</p>${live}<nav>${cards.map((card) => `<a href="#${card.id}">${esc(card.title)}</a>`).join("")}</nav>${cards.map((card) => `<figure id="${card.id}"><img src="${card.id}.png" alt="${esc(card.title)}" loading="lazy"><figcaption><a href="${card.id}.png">PNG</a> · <a href="${card.id}.svg">SVG</a></figcaption></figure>`).join("")}<h2>Inspect the actual compilation</h2><p>Expand a function to read its source, emitted combinators, categorical graph, and generated WGSL. Green squares in the tree retain primitive operations.</p>${entries.map((entry) => `<article><details><summary>${esc(entry.label)} · ${esc(entry.path)} path</summary><img src="tree-${entry.id}-htree.svg" alt="${esc(entry.label)} iota structure" style="max-width:650px" loading="lazy"><p>${["htree", "radial", "botanical"].map((layout) => `<a href="tree-${entry.id}-${layout}.svg">${layout} SVG</a>`).join(" · ")}</p><h3>Haskell</h3><pre>${esc(entry.source)}</pre><h3>MicroHs combinators</h3><pre>${esc(entry.combinators)}</pre><h3>CCC / array graph</h3><pre>${esc(entry.graph)}</pre><h3>Generated WGSL expression or body</h3><pre>${esc(entry.wgsl)}</pre></details></article>`).join("")}<footer><a href="data.json">Source data and exact counts</a> · <a href="scalar.wgsl">Runnable scalar shader</a> · <a href="https://github.com/Tritlo/Combinate">Combinate renderer</a><p>Float operations remain primitive leaves. Ternary weight operators have pure ι forms. Weights remain model data; the atlas shows program functions.</p></footer></main><script type="application/json" id="scalar-shader">${JSON.stringify(data.scalarShader).replace(/</g, "\\u003c")}</script><script type="module">${previewScript}</script></html>`);
console.log(JSON.stringify({ output, model, cards: cards.map((card) => card.id), terms: provenance.entries.map(({ id, structure }) => ({ id, ...structure })) }, null, 2));
