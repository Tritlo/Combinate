import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { buildStructure, expandedStructureGrammar, renderExpandedStructure, renderStructure, retainedLeaves, structureStats, type RetainedLeaf } from "./ccc-structure";

import type { CombDef } from "../src/core/mhs";
import { rasterExpandedStructure } from "./ccc-raster";
import { writeDemoPage } from "./ccc-page";

/** Compiler records exported by the CCC graphics driver. */
interface Entry {
  id: string;
  root: string;
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
const data = JSON.parse(await readFile(input, "utf8")) as { entries: Entry[]; scalarShader: string; closure: CombDef[] };
const { entries } = data;
if (!data.scalarShader || !data.closure || entries.some((entry) => !entry.root)) throw new Error("Export graphics-data again to include the complete compiler closure");
const terms = new Map(entries.map((entry) => [entry.id, buildStructure(entry.combinators)]));
const colors = { ink: "#1d2528", red: "#d84132", muted: "#697375", line: "#dbded9", paper: "#f7f7f2", teal: "#087f83", blue: "#355fc1", gold: "#ad7720", violet: "#8055a7" };
const leafColors = { operation: colors.teal, array: colors.blue, dictionary: colors.gold, constant: colors.violet, reference: colors.muted };
const inventories = new Map(entries.map((entry) => [entry.id, retainedLeaves(terms.get(entry.id)!)]));
const expandedRecords = new Map<string, { structure: ReturnType<typeof structureStats>; retainedLeaves: RetainedLeaf[] }>();
const rasterChecks: { id: string; visited: number; milliseconds: number }[] = [];
const comparisonCards: { id: string; title: string }[] = [];
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
  return `<g transform="translate(${x} ${y})">${renderStructure(node, { width, height, color, primitiveColor: colors.teal, leafColors, layout })}</g>`;
}

/** Count retained occurrences in one category. */
function leafCount(id: string, category: RetainedLeaf["category"]): number {
  return inventories.get(id)!.filter((leaf) => leaf.category === category).reduce((sum, leaf) => sum + leaf.count, 0);
}

/** List the exact retained names and their repeated occurrences. */
function leafNames(id: string, category: RetainedLeaf["category"]): string {
  return inventories.get(id)!.filter((leaf) => leaf.category === category).map((leaf) => leaf.label + (leaf.count > 1 ? ` (${leaf.count})` : "")).join(" · ");
}

/** Show the four retained leaf categories with concrete examples. */
function leafLegend(y: number): string {
  return text("■ numeric: +, exp", 66, y, 16, leafColors.operation) +
    text("■ array functions: map, sum", 410, y, 16, leafColors.array) +
    text("■ dictionaries: Num Float", 847, y, 16, leafColors.dictionary) +
    text("■ literals: 1.0", 1260, y, 16, leafColors.constant);
}

/** Provide common typography, dimensions, and provenance for one tweet image. */
function frame(body: string, name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${esc(name)}"><style>text{font-family:Arial,Helvetica,sans-serif} text[font-family]{font-family:Menlo,Consolas,monospace}</style><rect width="1600" height="900" fill="${colors.paper}"/>${body}<line x1="64" y1="849" x2="1536" y2="849" stroke="${colors.line}"/>${text("BITNETCOMB  /  MICROHS  /  COMBINATE", 64, 878, 14, colors.muted, 'letter-spacing="1.4"')}${text("Actual model data · actual compiled terms", 1140, 878, 14, colors.muted)}</svg>`;
}

/** Compare the original term with its complete reachable Haskell expansion. */
function comparison(entry: Entry, fullImage: string): string {
  const compact = structureStats(terms.get(entry.id)!);
  const full = expandedRecords.get(entry.id)!.structure;
  const number = (value: number): string => value.toLocaleString("en-US");
  return frame(
    text("ONE SOURCE / TWO LEVELS OF EXPANSION", 64, 65, 17, colors.red, 'letter-spacing="2.2" font-weight="600"') +
    text(entry.label, 64, 145, 66, colors.ink, 'letter-spacing="-2.2" font-weight="700"') +
    text("Actual MicroHs definitions. Function bodies and dictionaries expand into the right-hand tree.", 66, 192, 24, colors.muted) +
    `<rect x="64" y="235" width="716" height="510" rx="8" fill="#fff" stroke="${colors.line}"/><rect x="820" y="235" width="716" height="510" rx="8" fill="#fff" stroke="${colors.line}"/>` +
    text("WITH NAMED FUNCTIONS AND DICTIONARIES", 88, 273, 15, colors.teal, 'letter-spacing="1.2" font-weight="600"') +
    text("FULL HASKELL EXPANSION", 844, 273, 15, colors.red, 'letter-spacing="1.2" font-weight="600"') +
    tree(entry.id, 76, 294, 692, 392, colors.teal) +
    `<image x="832" y="294" width="692" height="392" href="data:image/png;base64,${fullImage}"/>` +
    text(`${number(compact.iotas)} ι · ${number(compact.primitives)} unexpanded leaves`, 88, 716, 23, colors.teal, 'font-weight="600"') +
    text(`${number(full.iotas)} ι · ${number(full.primitives)} runtime / literal leaves`, 844, 716, 23, colors.red, 'font-weight="600"') +
    text("Full expansion includes dictionary methods and error paths that this expression may never call.", 66, 790, 20, colors.muted) +
    text("Runtime primitives, foreign calls, and literals stay named. Counts describe syntax, not executed GPU work.", 66, 827, 18, colors.muted), `${entry.label}: compact and fully expanded H-trees`);
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
const scalarStats = structureStats(terms.get("scalar")!);
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
  text("02 / ι + NAMED UNEXPANDED LEAVES", 970, 119, 15, colors.red, 'letter-spacing="1.7"') +
  text(`${scalarStats.iotas} ι dots + ${scalarStats.primitives} unexpanded leaf occurrences`, 848, 678, 19, colors.ink) +
  text(`■ methods: ${leafNames("scalar", "operation")}`, 848, 707, 18, leafColors.operation) + text(`■ literals: ${leafNames("scalar", "constant")}`, 1210, 707, 18, leafColors.constant) +
  text(`■ dictionary: ${leafNames("scalar", "dictionary")}`, 848, 736, 18, leafColors.dictionary) +
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
  text("ι structure. Named leaves.", 64, 135, 60, colors.ink, 'letter-spacing="-2" font-weight="700"') +
  text("The combinator structure is expanded. Function references, dictionaries, and literals remain as leaves.", 66, 176, 23, colors.muted) +
  subjects.map(([id, title, color], i) => {
    const x = 64 + (i % 3) * 500;
    const y = 214 + Math.floor(i / 3) * 290;
    const stats = structureStats(terms.get(id)!);
    return `<rect x="${x}" y="${y}" width="472" height="268" rx="7" fill="#fff" stroke="${colors.line}"/>` +
      tree(id, x + 12, y + 15, 448, 177, color) + text(title, x + 22, y + 214, 24, color, 'font-weight="600"') +
      text(`${stats.iotas} ι  ·  ${stats.primitives} unexpanded leaf occurrences`, x + 22, y + 236, 14, colors.muted) +
      text((["array", "operation", "dictionary", "constant", "reference"] as const).filter((category) => leafCount(id, category) > 0).map((category) => `${leafCount(id, category)} ${ { array: "array", operation: "numeric", dictionary: "dictionary", constant: "literal", reference: "reference" }[category]}`).join(" · "), x + 22, y + 257, 12.5, colors.muted);
  }).join("") +
  text("Squares are named, unexpanded leaves. Counts include repeated occurrences.", 66, 800, 17, colors.muted) + leafLegend(829), "Iota atlas of model program parts");

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
  tree("softmax", 792, 212, 744, 440, colors.red, "htree") +
  text(`${leafCount("softmax", "array")} array leaves: ${leafNames("softmax", "array")}`, 800, 693, 19, leafColors.array) +
  text(`${leafCount("softmax", "operation")} method leaves: ${leafNames("softmax", "operation")}`, 800, 730, 19, leafColors.operation) +
  text(`${leafCount("softmax", "dictionary")} dictionaries: Fractional / Floating / Num Float`, 800, 767, 17.5, leafColors.dictionary) +
  text(`${softStats.iotas} ι dots + ${softStats.primitives} unexpanded leaf occurrences`, 800, 808, 20, colors.ink) +
  text("maximum → map exp → ordered sum → map divide", 66, 716, 22, colors.ink, 'font-family="Menlo,monospace"') +
  text("Array functions and Float arithmetic", 66, 763, 22, colors.muted) +
  text("are lowered separately to GPU operations.", 66, 797, 22, colors.muted) +
  text("Their implementations are not expanded into ι.", 66, 827, 17, colors.muted), "Softmax source and its actual iota structure");

const rms = terms.get("rmsNorm")!;
const rmsStats = structureStats(rms);
const views = frame(
  text("COMBINATE / THREE LAYOUTS OF THE SAME TERM", 64, 65, 17, colors.red, 'letter-spacing="2.2" font-weight="600"') +
  text("One function. Three ways to see it.", 64, 143, 60, colors.ink, 'letter-spacing="-2.2" font-weight="700"') +
  text(`RMSNorm  ·  ${rmsStats.iotas} ι leaves  ·  ${rmsStats.primitives} unexpanded leaf occurrences  ·  no changes to the program`, 66, 191, 23, colors.muted) +
  (["htree", "radial", "botanical"] as const).map((layout, i) => {
    const x = 64 + i * 500;
    const color = [colors.red, colors.teal, colors.blue][i]!;
    const title = ["H-tree", "Radial", "Botanical"][i]!;
    return `<rect x="${x}" y="247" width="472" height="492" rx="8" fill="#fff" stroke="${colors.line}"/>` +
      tree("rmsNorm", x + 12, 260, 448, 403, color, layout) + text(title, x + 24, 708, 27, color, 'font-weight="600"');
  }).join("") + text("Same application tree. Same leaf inventory. The layout changes.", 66, 790, 23, colors.muted) + leafLegend(829), "Three Combinate layouts of RMSNorm");

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

const leafKey = frame(
  text("READING THE STRUCTURE / SOFTMAX", 64, 65, 17, colors.red, 'letter-spacing="2.2" font-weight="600"') +
  text("The squares are named leaves.", 64, 144, 66, colors.ink, 'letter-spacing="-2.2" font-weight="700"') +
  text(`${softStats.iotas} ι leaves + ${softStats.primitives} unexpanded leaves. Counts include repeated occurrences.`, 66, 192, 24, colors.muted) +
  tree("softmax", 64, 245, 700, 465) +
  text(`${leafCount("softmax", "array")} ARRAY-FUNCTION REFERENCES`, 820, 280, 17, leafColors.array, 'letter-spacing="1.2" font-weight="600"') +
  text(leafNames("softmax", "array"), 820, 327, 29, leafColors.array, 'font-weight="600"') +
  text("Function bodies and traversal are not expanded.", 820, 366, 19, colors.muted) +
  text(`${leafCount("softmax", "operation")} NUMERIC METHOD REFERENCES`, 820, 444, 17, leafColors.operation, 'letter-spacing="1.2" font-weight="600"') +
  text(leafNames("softmax", "operation"), 820, 491, 35, leafColors.operation, 'font-weight="600"') +
  text("Arithmetic implementations are not expanded.", 820, 530, 19, colors.muted) +
  text(`${leafCount("softmax", "dictionary")} TYPECLASS DICTIONARY REFERENCES`, 820, 608, 17, leafColors.dictionary, 'letter-spacing="1.2" font-weight="600"') +
  text(leafNames("softmax", "dictionary"), 820, 652, 20, leafColors.dictionary, 'font-weight="600"') +
  text("They select the Float implementation of each method.", 820, 691, 19, colors.muted) +
  text("Other functions also retain literals such as 1.0 and 1.0e-5.", 66, 772, 22, leafColors.constant) +
  text("CCC lowering resolves the supported symbols into GPU arithmetic and array operations.", 66, 816, 21, colors.muted), "Exact meaning of every retained leaf in softmax");

/** Apply the dark palette without changing the drawing geometry. */
function night(svg: string): string {
  return [[colors.paper, "#0b1117"], [colors.ink, "#f1f2e9"], [colors.muted, "#a7b3b8"], [colors.line, "#2b3942"], [colors.red, "#ff8970"], [colors.teal, "#63dbc3"], [colors.blue, "#80a7ff"], [colors.gold, "#e8b961"], [colors.violet, "#bd98f0"], ["#fff\"", "#101c25\""]].reduce((result, [from, to]) => result.split(from!).join(to!), svg);
}

const cards = [
  { id: "01-haskell-to-gpu", title: "Haskell → combinators → GPU", svg: hero },
  { id: "02-program-atlas", title: "An atlas of the program", svg: atlas },
  { id: "03-three-weight-operations", title: "2.08B ternary weights, three operations", svg: weights },
  { id: "04-softmax", title: "Softmax: compact structure", svg: softmaxCard },
  { id: "05-three-layouts", title: "One function, three views", svg: views },
  { id: "06-haskell-to-gpu-night", title: "Source to GPU, dark variant", svg: night(hero) },
  { id: "07-model-statistics", title: "The model in numbers", svg: modelCard },
  { id: "08-what-the-leaves-mean", title: "What the squares mean", svg: leafKey },
];
for (const entry of entries) {
  for (const layout of ["htree", "radial", "botanical"] as const) await writeFile(resolve(output, `tree-${entry.id}-${layout}.svg`), renderStructure(terms.get(entry.id)!, { width: 1200, height: 1200, color: colors.red, primitiveColor: colors.teal, leafColors, layout }));
}
for (const card of cards) await writeFile(resolve(output, `${card.id}.svg`), card.svg);
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  for (const card of cards) {
    await page.setContent(`<!doctype html><html><body style="margin:0">${card.svg}</body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: resolve(output, `${card.id}.png`), clip: { x: 0, y: 0, width: 1600, height: 900 } });
  }
  const treePage = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  for (const entry of entries) {
    const grammar = expandedStructureGrammar(data.closure, entry.root);
    const structure = { nodes: Number(grammar.stats.nodes), iotas: Number(grammar.stats.iotas), primitives: Number(grammar.stats.primitives), depth: grammar.stats.depth };
    if (Object.values(structure).some((value) => !Number.isSafeInteger(value))) throw new Error("Expanded counts exceed the exact JSON number range");
    const inventory = grammar.retained.map((leaf) => ({ ...leaf, count: Number(leaf.count) }));
    expandedRecords.set(entry.id, { structure, retainedLeaves: inventory });
    console.log(`Drawing ${entry.root}: ${structure.nodes.toLocaleString("en-US")} occurrences`);
    await writeFile(resolve(output, `tree-${entry.id}-expanded-htree.svg`), renderExpandedStructure(data.closure, entry.root, { width: 1200, height: 1200, color: colors.red, leafColors, layout: "htree", id: `expanded-${entry.id}` }));
    await writeFile(resolve(output, `tree-${entry.id}-grammar.json`), JSON.stringify({ root: grammar.root, nodes: grammar.nodes, bounds: grammar.bounds }) + "\n");
    const milliseconds = await rasterExpandedStructure(treePage, grammar, colors.red, leafColors, "#fff");
    rasterChecks.push({ id: entry.id, visited: structure.nodes, milliseconds });
    console.log(`Drew every ${entry.id} occurrence in ${(milliseconds / 1000).toFixed(1)} seconds`);
    await treePage.screenshot({ path: resolve(output, `tree-${entry.id}-expanded-htree.png`), clip: { x: 0, y: 0, width: 1600, height: 900 } });
    const compact = await readFile(resolve(output, `tree-${entry.id}-htree.svg`), "utf8");
    await treePage.setContent(`<!doctype html><html><body style="margin:0;background:${colors.paper}">${compact}</body></html>`, { waitUntil: "load" });
    await treePage.screenshot({ path: resolve(output, `tree-${entry.id}-compact-htree.png`), clip: { x: 0, y: 0, width: 1200, height: 1200 } });
    const id = `compare-${entry.id}`;
    const svg = comparison(entry, (await readFile(resolve(output, `tree-${entry.id}-expanded-htree.png`))).toString("base64"));
    await writeFile(resolve(output, `${id}.svg`), svg);
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: resolve(output, `${id}.png`), clip: { x: 0, y: 0, width: 1600, height: 900 } });
    comparisonCards.push({ id, title: `${entry.label}: both versions` });
  }
  await writeFile(resolve(output, "expanded-render-check.json"), JSON.stringify(rasterChecks, null, 2) + "\n");
} finally { await browser.close(); }
const provenance = { model, entries: entries.map((entry) => ({ ...entry, structure: structureStats(terms.get(entry.id)!), retainedLeaves: inventories.get(entry.id)!, expanded: expandedRecords.get(entry.id)! })), note: "Compact views expand the combinator basis and retain other Haskell references. Expanded views inline every reachable Haskell body and dictionary from the actual compiler closure. Runtime primitives, foreign calls, and literal values remain named. Counts are occurrences, not distinct symbols or GPU instructions. The legacy structure.primitives field counts these retained occurrences. Implementations and transitive dependencies are included in expanded views. The weight-operation card uses equivalent compact pure-iota forms of I, K, and MicroHs C P." };
await writeFile(resolve(output, "data.json"), JSON.stringify(provenance, null, 2) + "\n");
await writeFile(resolve(output, "closure.json"), JSON.stringify(data.closure) + "\n");
const allCards = [...comparisonCards, ...cards.map(({ id, title }) => ({ id, title }))];
await writeFile(resolve(output, "scalar.wgsl"), data.scalarShader);
await writeDemoPage(output);
console.log(JSON.stringify({ output, model, cards: allCards.map((card) => card.id), terms: provenance.entries.map(({ id, structure }) => ({ id, ...structure })) }, null, 2));
