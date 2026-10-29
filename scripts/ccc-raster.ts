import type { Page } from "playwright-core";
import type { ExpandedStructureGrammar, RetainedLeaf } from "./ccc-structure";

/** Draw every H-tree occurrence without allocating a browser scene node for it. */
export async function rasterExpandedStructure(page: Page, grammar: ExpandedStructureGrammar, color: string, leafColors: Record<RetainedLeaf["category"], string>, background: string): Promise<number> {
  const expected = Number(grammar.stats.nodes);
  if (!Number.isSafeInteger(expected)) throw new Error("The occurrence count exceeds the exact raster counter range");
  const terminalColors = Object.fromEntries(grammar.retained.map((leaf) => [leaf.symbol, leafColors[leaf.category]]));
  return page.evaluate(async ({ nodes, root, bounds, expected, color, terminalColors, background }) => {
    document.body.innerHTML = "";
    document.body.style.margin = "0";
    const canvas = document.createElement("canvas");
    const width = 1600;
    const height = 900;
    const ratio = devicePixelRatio;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    document.body.append(canvas);
    const context = canvas.getContext("2d")!;
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const fit = Math.min((width - 48) / (bounds.maxX - bounds.minX), (height - 48) / (bounds.maxY - bounds.minY));
    const centerX = width / 2 - (bounds.minX + bounds.maxX) * fit / 2;
    const centerY = height / 2 - (bounds.minY + bounds.maxY) * fit / 2;
    context.setTransform(fit * ratio, 0, 0, fit * ratio, centerX * ratio, centerY * ratio);
    context.strokeStyle = color;
    context.lineCap = "round";
    const initialArm = 80 + 40 * Math.log2(expected + 2);
    const pending = [root, 0, 0, 1, 0];
    let visited = 0;
    const start = performance.now();
    while (pending.length > 0) {
      const depth = pending.pop()!;
      const arm = pending.pop()!;
      const y = pending.pop()!;
      const x = pending.pop()!;
      const index = pending.pop()!;
      const node = nodes[index]!;
      if (node.kind === "app") {
        const direction = depth % 4;
        const dx = direction === 0 ? arm : direction === 2 ? -arm : 0;
        const dy = direction === 1 ? arm : direction === 3 ? -arm : 0;
        const taper = Math.min(1, initialArm * arm / 42);
        context.lineWidth = 2 * Math.max(0.16, 1.45 * taper) / fit;
        context.globalAlpha = 0.86;
        context.setLineDash([]);
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x - dx, y - dy);
        context.stroke();
        context.globalAlpha = 0.57;
        context.setLineDash([Math.max(0.4, 4 * taper) / fit, Math.max(0.3, 2.6 * taper) / fit]);
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + dx, y + dy);
        context.stroke();
        context.globalAlpha = 0.65;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, y, 2 * Math.max(0.18, 1.15 * taper) / fit, 0, Math.PI * 2);
        context.fill();
        pending.push(node.arg, x + dx, y + dy, arm * 0.68, depth + 1);
        pending.push(node.fn, x - dx, y - dy, arm * 0.68, depth + 1);
      } else {
        context.globalAlpha = 1;
        if (node.kind === "iota") {
          context.fillStyle = color;
          context.beginPath();
          const taper = Math.min(1, initialArm * arm / 0.68 / 42);
          context.arc(x, y, 2 * Math.max(0.28, 2.6 * taper) / fit, 0, Math.PI * 2);
          context.fill();
        } else {
          context.fillStyle = terminalColors[node.symbol]!;
          const taper = Math.min(1, initialArm * arm / 0.68 / 42);
          const size = 2 * Math.max(0.7, 6 * taper) / fit;
          context.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
      visited++;
      if (visited % 250_000 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (visited !== expected) throw new Error(`Rendered ${visited} occurrences; expected ${expected}`);
    return performance.now() - start;
  }, { nodes: grammar.nodes, root: grammar.root, bounds: grammar.bounds, expected, color, terminalColors, background });
}
