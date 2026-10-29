import { IOTA_CODE } from "../src/core/catalog";
import { bracket } from "../src/core/church";
import { HTREE_SHRINK, layoutBotanical, layoutHTree, layoutRadial } from "../src/core/layouts";
import { combinatorsToTree, type CombDef } from "../src/core/mhs";
import { parseComb } from "../src/core/refold";
import { app, cloneTermDeep, decode, freeVar, freshId, iota, type Node } from "../src/core/term";

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

/** Expand generated SKI while preserving typed literal leaves. */
function expandGenerated(node: Node): Node {
  if (node.kind === "app") return app(expandGenerated(node.fn), expandGenerated(node.arg));
  return node.kind === "free" ? freeVar(node.name) : expandBasis(node);
}

/** Expand Scott constructors verified against the pinned MicroHs evaluator. */
function constructorStructure(symbol: string): Node | undefined {
  let names: string[];
  let body: Node;
  const variable = (index: number): Node => freeVar(`$cccConstructor${index}`);
  if (symbol === "L" || symbol === "KK" || symbol === "KA") {
    names = [0, 1, 2].map((index) => `$cccConstructor${index}`);
    body = symbol === "L" ? app(variable(1), variable(0)) : variable(symbol === "KK" ? 1 : 2);
  } else if (/^T(?:[3-9]|1[0-6])$/.test(symbol)) {
    const arity = Number(symbol.slice(1));
    names = Array.from({ length: arity + 1 }, (_, index) => `$cccConstructor${index}`);
    body = variable(arity);
    for (let index = 0; index < arity; index++) body = app(body, variable(index));
  } else if (/^TAG(?:[0-9]|[12][0-9]|3[0-2])$/.test(symbol)) {
    names = ["$cccConstructor0", "$cccConstructor1"];
    body = app(app(variable(1), freeVar(`literal:int:${Number(symbol.slice(3))}`)), variable(0));
  } else return undefined;
  for (let index = names.length - 1; index >= 0; index--) body = bracket(names[index]!, body);
  return expandGenerated(body);
}

/** Resolve complete definitions into a shared graph without changing runtime values. */
function expandedGraph(definitions: readonly CombDef[], root: string): Node {
  const bodies = new Map(definitions.map((definition) => [definition.name, definition.body]));
  if (bodies.size !== definitions.length) throw new Error("The combinator closure contains duplicate definition names");
  const resolved = new Map<string, Node>();
  const primitives = new Map<string, Node>();
  const active = new Set<string>();
  const primitive = (symbol: string): Node => {
    const previous = primitives.get(symbol);
    if (previous) return previous;
    let node = constructorStructure(symbol);
    if (!node && BASIS.has(symbol)) {
      const converted = combinatorsToTree([{ name: "basis", body: { prim: symbol } }], "basis");
      if ("error" in converted) throw new Error(converted.error);
      node = expandBasis(converted.tree);
    }
    node ??= freeVar(`runtime:${symbol}`);
    primitives.set(symbol, node);
    return node;
  };
  const convert = (expression: CombDef["body"]): Node => {
    if ("app" in expression) return app(convert(expression.app[0]), convert(expression.app[1]));
    if ("var" in expression) return resolve(expression.var);
    if ("prim" in expression) return primitive(expression.prim);
    if ("lam" in expression) throw new Error("A lambda survived compilation of the rooted closure");
    if ("forimp" in expression) return freeVar(`forimp:${expression.forimp}`);
    const [kind, value] = Object.entries(expression)[0]!;
    const text = typeof value === "string" ? JSON.stringify(value) : Object.is(value, -0) ? "-0" : String(value);
    return freeVar(`${kind === "exn" || kind === "tick" ? "runtime" : "literal"}:${kind}:${text}`);
  };
  const resolve = (name: string): Node => {
    const previous = resolved.get(name);
    if (previous) return previous;
    const body = bodies.get(name);
    if (!body) throw new Error(`Missing definition in the rooted combinator closure: ${name}`);
    if (active.has(name)) throw new Error(`Recursive global definition was not lowered to a finite Y term: ${name}`);
    active.add(name);
    const node = convert(body);
    active.delete(name);
    resolved.set(name, node);
    return node;
  };
  return resolve(root);
}

/** Counts include every occurrence, even when the temporary graph shares definitions. */
export interface ExpandedStructureStats {
  nodes: bigint;
  iotas: bigint;
  primitives: bigint;
  depth: number;
}

/** Measure all occurrences in a shared graph. */
function measureExpandedGraph(root: Node): ExpandedStructureStats {
  const memo = new Map<number, ExpandedStructureStats>();
  const visit = (node: Node): ExpandedStructureStats => {
    const previous = memo.get(node.id);
    if (previous) return previous;
    const result: ExpandedStructureStats = node.kind === "app"
      ? (() => {
          const left = visit(node.fn);
          const right = visit(node.arg);
          return { nodes: 1n + left.nodes + right.nodes, iotas: left.iotas + right.iotas, primitives: left.primitives + right.primitives, depth: 1 + Math.max(left.depth, right.depth) };
        })()
      : { nodes: 1n, iotas: node.kind === "iota" ? 1n : 0n, primitives: node.kind === "iota" ? 0n : 1n, depth: 0 };
    memo.set(node.id, result);
    return result;
  };
  return visit(root);
}

/** Measure every occurrence without allocating the complete occurrence tree. */
export function expandedStructureStats(definitions: readonly CombDef[], root: string): ExpandedStructureStats {
  return measureExpandedGraph(expandedGraph(definitions, root));
}

/** Return the exact node count before allocating a complete occurrence tree. */
export function expandedStructureSize(definitions: readonly CombDef[], root: string): bigint {
  return expandedStructureStats(definitions, root).nodes;
}

/** Inline all bodies and expand structural combinators with fresh occurrence ids. */
export function buildExpandedStructure(definitions: readonly CombDef[], root: string): Node {
  return cloneTermDeep(expandedGraph(definitions, root));
}

/** A shared visual subtree. Child indices precede their parent index. */
export type ExpandedGrammarNode =
  | { kind: "app"; fn: number; arg: number }
  | { kind: "iota" }
  | { kind: "terminal"; symbol: string };

/** Exact bounds in an H-tree whose initial arm has length one. */
export interface ExpandedBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Count a retained symbol across the complete occurrence tree. */
export type ExpandedRetainedLeaf = Omit<RetainedLeaf, "count"> & { count: bigint };

/** Store every visual subtree once. References still display every occurrence. */
export interface ExpandedStructureGrammar {
  root: number;
  nodes: ExpandedGrammarNode[];
  stats: ExpandedStructureStats;
  bounds: ExpandedBounds;
  retained: ExpandedRetainedLeaf[];
}

/** Build a complete indexed H-tree grammar without allocating duplicate subtrees. */
export function expandedStructureGrammar(definitions: readonly CombDef[], root: string): ExpandedStructureGrammar {
  const graph = expandedGraph(definitions, root);
  const nodes: ExpandedGrammarNode[] = [];
  const bounds: ExpandedBounds[] = [];
  const seen = new Map<number, number>();
  const visit = (node: Node): number => {
    const previous = seen.get(node.id);
    if (previous !== undefined) return previous;
    let descriptor: ExpandedGrammarNode;
    let extent = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    if (node.kind === "app") {
      const fn = visit(node.fn);
      const arg = visit(node.arg);
      descriptor = { kind: "app", fn, arg };
      for (const [child, offset] of [[fn, -1], [arg, 1]]) {
        const box = bounds[child!]!;
        extent = {
          minX: Math.min(extent.minX, offset! - HTREE_SHRINK * box.maxY),
          maxX: Math.max(extent.maxX, offset! - HTREE_SHRINK * box.minY),
          minY: Math.min(extent.minY, HTREE_SHRINK * box.minX),
          maxY: Math.max(extent.maxY, HTREE_SHRINK * box.maxX),
        };
      }
    } else descriptor = node.kind === "iota" ? { kind: "iota" } : { kind: "terminal", symbol: node.kind === "free" ? node.name : node.sym };
    const index = nodes.length;
    nodes.push(descriptor);
    bounds.push(extent);
    seen.set(node.id, index);
    return index;
  };
  const index = visit(graph);
  const occurrences = Array<bigint>(nodes.length).fill(0n);
  occurrences[index] = 1n;
  const inventory = new Map<string, ExpandedRetainedLeaf>();
  for (let nodeIndex = index; nodeIndex >= 0; nodeIndex--) {
    const node = nodes[nodeIndex]!;
    const count = occurrences[nodeIndex]!;
    if (node.kind === "app") {
      occurrences[node.fn] = occurrences[node.fn]! + count;
      occurrences[node.arg] = occurrences[node.arg]! + count;
    } else if (node.kind === "terminal") {
      const previous = inventory.get(node.symbol);
      if (previous) previous.count += count;
      else inventory.set(node.symbol, { ...describeLeaf(node.symbol), count });
    }
  }
  return { root: index, nodes, stats: measureExpandedGraph(graph), bounds: bounds[index]!, retained: [...inventory.values()] };
}

/** Export every occurrence through exact H-tree transforms and shared SVG definitions. */
export function renderExpandedStructure(definitions: readonly CombDef[], root: string, options: StructureOptions): string {
  if (options.layout !== "htree") throw new Error("Expanded closure SVG export requires the H-tree layout");
  const { width, height } = options;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("SVG dimensions must be positive and finite");
  const grammar = expandedStructureGrammar(definitions, root);
  const box = grammar.bounds;
  const padding = Math.min(24, width * 0.06, height * 0.06);
  const fit = Math.min((width - 2 * padding) / Math.max(box.maxX - box.minX, Number.EPSILON), (height - 2 * padding) / Math.max(box.maxY - box.minY, Number.EPSILON));
  const x = width / 2 - (box.minX + box.maxX) * fit / 2;
  const y = height / 2 - (box.minY + box.maxY) * fit / 2;
  const prefix = (options.id ?? `ccc-expanded-${freshId()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  const color = escapeXml(options.color);
  const terminalColor = escapeXml(options.primitiveColor ?? options.color);
  const definitionsSvg = grammar.nodes.map((node, index) => {
    let contents: string;
    if (node.kind === "app") {
      contents = `<path d="M0 0H-1" fill="none" stroke="${color}" stroke-width="${1.45 / fit}" stroke-opacity="0.86"/><path d="M0 0H1" fill="none" stroke="${color}" stroke-width="${1.45 / fit}" stroke-opacity="0.57" stroke-dasharray="${4 / fit} ${2.6 / fit}"/><circle r="${1.15 / fit}" fill="${color}" fill-opacity="0.65"/><use href="#${prefix}-${node.fn}" transform="translate(-1 0) rotate(90) scale(${HTREE_SHRINK})"/><use href="#${prefix}-${node.arg}" transform="translate(1 0) rotate(90) scale(${HTREE_SHRINK})"/>`;
    } else if (node.kind === "iota") contents = `<circle r="${2.6 / fit}" fill="${color}"/>`;
    else {
      const leaf = describeLeaf(node.symbol);
      const fill = options.leafColors?.[leaf.category];
      contents = `<rect x="${-3 / fit}" y="${-3 / fit}" width="${6 / fit}" height="${6 / fit}" rx="${1 / fit}" fill="${fill === undefined ? terminalColor : escapeXml(fill)}"><title>${escapeXml(`${leaf.label}: ${leaf.description} Original symbol: ${leaf.symbol}`)}</title></rect>`;
    }
    return `<g id="${prefix}-${index}">${contents}</g>`;
  }).join("");
  const metadata = JSON.stringify(grammar.stats, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Expanded iota H-tree with runtime, foreign, and literal leaves"><title>Complete occurrence H-tree. SVG definitions reuse identical graphical subtrees.</title><metadata>${escapeXml(metadata)}</metadata><defs>${definitionsSvg}</defs><use href="#${prefix}-${grammar.root}" transform="translate(${x} ${y}) scale(${fit})"/></svg>`;
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
  if (symbol.startsWith("literal:")) {
    const separator = symbol.indexOf(":", 8);
    const kind = symbol.slice(8, separator);
    const value = symbol.slice(separator + 1);
    return { symbol, label: `${kind} ${value}`, category: "constant", description: `MicroHs ${kind} literal ${value}. The runtime value keeps its original representation. It is not replaced with a Scott numeral.` };
  }
  if (symbol.startsWith("runtime:")) {
    const token = symbol.slice(8);
    return { symbol, label: token, category: "operation", description: `MicroHs runtime primitive ${token}. Its implementation remains outside the combinator tree.` };
  }
  if (symbol.startsWith("forimp:")) {
    const name = symbol.slice(7);
    return { symbol, label: `FFI ${name}`, category: "operation", description: `MicroHs foreign import ${name}. The native implementation remains outside the combinator tree.` };
  }
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

/** Preserve the available floating-point coordinate precision in SVG. */
function coordinate(value: number): string {
  return String(value);
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
