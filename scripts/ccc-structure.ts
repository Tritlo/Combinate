import { IOTA_CODE } from "../src/core/catalog";
import { layoutBotanical, layoutHTree, layoutRadial } from "../src/core/layouts";
import { combinatorsToTree } from "../src/core/mhs";
import { parseComb } from "../src/core/refold";
import { app, decode, freeVar, iota, type Node } from "../src/core/term";

const BASIS = new Set(["S", "K", "I", "B", "C", "A", "U", "Z", "P", "R", "O", "S'", "B'", "C'", "C'B", "K2", "K3", "K4", "J", "Y"]);

/** Expand a converted MicroHs basis node. Keep every output node independent. */
function expandBasis(node: Node): Node {
  if (node.kind === "app") return app(expandBasis(node.fn), expandBasis(node.arg));
  if (node.kind === "iota") return iota();
  if (node.kind === "comb") {
    const code = IOTA_CODE[node.sym];
    if (code) return decode(code);
    if (node.def) return expandBasis(node.def);
  }
  throw new Error("A MicroHs basis node has no complete iota expansion");
}

/** Expand the MicroHs control structure. Keep all other leaves opaque. */
export function buildStructure(termText: string): Node {
  const convert = (node: Node): Node => {
    if (node.kind === "app") return app(convert(node.fn), convert(node.arg));
    if (node.kind === "iota") return iota();
    const symbol = node.kind === "comb" ? node.sym : node.name;
    if (!BASIS.has(symbol)) return freeVar(symbol);
    const result = combinatorsToTree([{ name: "basis", body: { prim: symbol } }], "basis");
    if ("error" in result) throw new Error(result.error);
    return expandBasis(result.tree);
  };
  return convert(parseComb(termText));
}

/** Describe one unexpanded symbol and count its distinct leaf nodes. */
export interface RetainedLeaf {
  symbol: string;
  label: string;
  category: "operation" | "array" | "dictionary" | "constant" | "reference";
  count: number;
  description: string;
}

const OPERATIONS: Record<string, [string, string]> = {
  "Data.Num.+": ["+", "Num a => a -> a -> a. Add two values with the selected numeric instance."],
  "Data.Num.-": ["−", "Num a => a -> a -> a. Subtract the second value from the first."],
  "Data.Num.*": ["×", "Num a => a -> a -> a. Multiply two values with the selected numeric instance."],
  "Data.Fractional./": ["÷", "Fractional a => a -> a -> a. Divide the first value by the second."],
  "Data.Floating.exp": ["exp", "Floating a => a -> a. Compute e raised to the given value."],
  "Data.Floating.sqrt": ["sqrt", "Floating a => a -> a. Compute the square root of a value."],
  "Data.Floating.**": ["pow", "Floating a => a -> a -> a. Raise the first argument to the power given by the second argument."],
  "Data.Ord.max": ["max", "Ord a => a -> a -> a. Select the larger value with the selected ordering instance."],
  "Data.Num.fromInteger": ["fromInteger", "Num a => Integer -> a. Convert an Integer with the selected numeric instance."],
  "Data.Integer_Type._intToInteger": ["intToInteger", "Int -> Integer. Convert a machine-sized Int to an Integer."],
  "Data.Num.negate": ["negate", "Num a => a -> a. Return the additive inverse with the selected numeric instance."],
  "Data.Eq.==": ["==", "Eq a => a -> a -> Bool. Test equality with the selected equality instance."],
};

const ARRAYS: Record<string, [string, string]> = {
  "SourceArray.map": ["map", "Apply a Float -> Float function to each element of a Vector Float."],
  "SourceArray.zipWith": ["zipWith", "Combine corresponding Vector Float elements with a Float -> Float -> Float function. The CCC graph requires equal lengths."],
  "SourceArray.sum": ["sum", "Vector Float -> Float. Add elements from left to right, starting at zero."],
  "SourceArray.maximum": ["maximum", "Vector Float -> Float. Select the maximum of a nonempty vector in input order."],
  "SourceArray.count": ["count", "Vector Float -> Float. Return the vector length as a Float."],
};

const DICTIONARIES: Record<string, string> = {
  "inst$Data.Num.Num@Primitives.Float": "Num Float",
  "inst$Data.Num.Num@Data.Int.Int32.Int32": "Num Int32",
  "inst$Data.Fractional.Fractional@Primitives.Float": "Fractional Float",
  "inst$Data.Floating.Floating@Primitives.Float": "Floating Float",
  "inst$Data.Ord.Ord@Primitives.Float": "Ord Float",
  "inst$Data.Eq.Eq@Data.Int.Int32.Int32": "Eq Int32",
};

/** Classify verified local symbols. Leave other references without assigned behavior. */
function describeLeaf(symbol: string): Omit<RetainedLeaf, "count"> {
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(symbol)) {
    return { symbol, label: symbol, category: "constant", description: `Numeric literal ${symbol}. Its value stays unexpanded in this view.` };
  }
  const dictionary = Object.prototype.hasOwnProperty.call(DICTIONARIES, symbol) ? DICTIONARIES[symbol] : undefined;
  if (dictionary) return { symbol, label: dictionary, category: "dictionary", description: `Type-class instance ${dictionary}. It selects the implementation of overloaded methods. Its body stays unexpanded.` };
  const array = Object.prototype.hasOwnProperty.call(ARRAYS, symbol) ? ARRAYS[symbol] : undefined;
  if (array) return { symbol, label: array[0], category: "array", description: array[1] };
  const operation = Object.prototype.hasOwnProperty.call(OPERATIONS, symbol) ? OPERATIONS[symbol] : undefined;
  if (operation) return { symbol, label: operation[0], category: "operation", description: operation[1] };
  return { symbol, label: symbol, category: "reference", description: "Unexpanded reference. This view assigns no behavior to this symbol." };
}

/** Group distinct retained leaf nodes by their original symbol in first-use order. */
export function retainedLeaves(root: Node): RetainedLeaf[] {
  const seen = new Set<number>();
  const inventory = new Map<string, RetainedLeaf>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.kind === "app") pending.push(node.arg, node.fn);
    else if (node.kind !== "iota") {
      const symbol = node.kind === "free" ? node.name : node.sym;
      const previous = inventory.get(symbol);
      if (previous) previous.count++;
      else inventory.set(symbol, { ...describeLeaf(symbol), count: 1 });
    }
  }
  return [...inventory.values()];
}

/** Count distinct nodes and opaque leaf occurrences. Depth counts edges from the root. */
export interface StructureStats {
  nodes: number;
  iotas: number;
  primitives: number;
  depth: number;
}

/** Measure a structure once per node. Shared subtrees do not add duplicate counts. */
export function structureStats(root: Node): StructureStats {
  const depths = new Map<number, number>();
  let iotas = 0;
  let primitives = 0;
  const visit = (node: Node): number => {
    const previous = depths.get(node.id);
    if (previous !== undefined) return previous;
    let depth = 0;
    if (node.kind === "app") depth = 1 + Math.max(visit(node.fn), visit(node.arg));
    else if (node.kind === "iota") iotas++;
    else primitives++;
    depths.set(node.id, depth);
    return depth;
  };
  const depth = visit(root);
  return { nodes: depths.size, iotas, primitives, depth };
}

/** Select the output size, layout, and colors of a standalone SVG. */
export interface StructureOptions {
  width: number;
  height: number;
  layout: "htree" | "radial" | "botanical";
  color: string;
  primitiveColor?: string;
  leafColors?: Partial<Record<RetainedLeaf["category"], string>>;
  id?: string;
}

/** Escape text before it enters an SVG attribute or title. */
function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

/** Limit SVG coordinate precision without changing the layout calculations. */
function coordinate(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** Draw a structure with tapered edges, iota dots, and named unexpanded tips. */
export function renderStructure(root: Node, options: StructureOptions): string {
  const { width, height } = options;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("SVG dimensions must be positive and finite");
  const layouts = { htree: layoutHTree, radial: layoutRadial, botanical: layoutBotanical };
  const layout = layouts[options.layout](root);
  const padding = Math.min(24, width * 0.06, height * 0.06);
  const fit = Math.min((width - 2 * padding) / Math.max(layout.width, 1), (height - 2 * padding) / Math.max(layout.height, 1));
  const position = (node: Node): { x: number; y: number } => {
    const point = layout.pos.get(node.id)!;
    return {
      x: (point.x - layout.minX - layout.width / 2) * fit + width / 2,
      y: (point.y - layout.minY - layout.height / 2) * fit + height / 2,
    };
  };
  const color = escapeXml(options.color);
  const primitiveColor = escapeXml(options.primitiveColor ?? options.color);
  const seen = new Set<number>();
  const edges: string[] = [];
  const nodes: string[] = [];
  const tips: string[] = [];
  const walk = (node: Node): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const point = position(node);
    const x = coordinate(point.x);
    const y = coordinate(point.y);
    const taper = layout.scale?.get(node.id) ?? 1;
    if (node.kind === "app") {
      const stroke = coordinate(Math.max(0.16, 1.45 * taper));
      for (const [child, argument] of [[node.fn, false], [node.arg, true]] as const) {
        const endpoint = position(child);
        const dash = argument ? ` stroke-dasharray="${coordinate(Math.max(0.4, 4 * taper))} ${coordinate(Math.max(0.3, 2.6 * taper))}"` : "";
        edges.push(`<line x1="${x}" y1="${y}" x2="${coordinate(endpoint.x)}" y2="${coordinate(endpoint.y)}" stroke-width="${stroke}" stroke-opacity="${argument ? 0.57 : 0.86}"${dash}/>`);
      }
      nodes.push(`<circle cx="${x}" cy="${y}" r="${coordinate(Math.max(0.18, 1.15 * taper))}" fill-opacity="0.65"/>`);
      walk(node.fn);
      walk(node.arg);
    } else if (node.kind === "iota") {
      nodes.push(`<circle cx="${x}" cy="${y}" r="${coordinate(Math.max(0.28, 2.6 * taper))}"/>`);
    } else {
      const symbol = node.kind === "free" ? node.name : node.sym;
      const leaf = describeLeaf(symbol);
      const leafColor = options.leafColors?.[leaf.category];
      const fill = leafColor === undefined ? primitiveColor : escapeXml(leafColor);
      const title = `${leaf.label}: ${leaf.description} Original symbol: ${symbol}`;
      tips.push(`<rect x="${coordinate(point.x - 3)}" y="${coordinate(point.y - 3)}" width="6" height="6" rx="1" fill="${fill}" stroke="${color}" stroke-width="0.7"><title>${escapeXml(title)}</title></rect>`);
    }
  };
  walk(root);
  const id = options.id === undefined ? "" : ` id="${escapeXml(options.id)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg"${id} width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Iota structure with named unexpanded leaves"><title>Iota structure with named unexpanded leaves</title><g fill="none" stroke="${color}" stroke-linecap="round">${edges.join("")}</g><g fill="${color}">${nodes.join("")}</g><g>${tips.join("")}</g></svg>`;
}
