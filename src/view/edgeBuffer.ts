import { Container, Mesh, MeshGeometry, Rectangle, Texture } from "pixi.js";
import { edgeTierColor } from "./theme";

/**
 * A retained, incrementally-updatable geometry for tree edges (deeper-perf, ADR 18).
 *
 * The Graphics `drawEdges` path re-tessellates EVERY segment on each redraw — O(n) per reduction
 * step. This keeps the edges resident in two GPU line-list buffers (one per depth TIER — the
 * red/black alternation), with each edge pinned to a fixed 2-vertex SLOT keyed by
 * {@link edgeKey}. Updating one edge writes only its slot's four floats, so a step that touches K
 * nodes uploads O(K), not O(n). Removed edges collapse to a degenerate (zero-length → no fragments)
 * segment and their slots are recycled through a freelist; the buffer grows geometrically when it
 * runs out.
 *
 * Solid 1-px lines, no dashes or width — it is used only for the heavy incremental H-tree path,
 * where the tree is framed far out and sub-pixel arms dominate anyway. Small / animated trees keep
 * the Graphics renderer (dashes, width, sub-pixel LOD, viewport cull).
 */

/** A parent→child edge identity: `2·parentDisplayId + side` (0 = fn/left, 1 = arg/right). Injective
 *  over all integers incl. the negative ids of expanded ι-trees, so it is a safe `Map` key. */
export function edgeKey(parentId: number, side: 0 | 1): number {
  return parentId * 2 + side;
}

const FLOATS_PER_SLOT = 4; // two vertices × (x, y)
const MIN_CAP = 64;

interface Slot {
  tier: 0 | 1;
  idx: number;
}

/** One depth tier's resident line-list mesh + its CPU-side position mirror. */
interface Tier {
  geo: MeshGeometry;
  mesh: Mesh;
  pos: Float32Array; // FLOATS_PER_SLOT per slot
  cap: number; // slots
  high: number; // high-water slot (drawn range is [0, high))
  free: number[]; // recycled slot indices
  dirty: boolean;
}

export class EdgeBuffer {
  /** The layer to add under the node particles (mirrors the old `edges` Graphics). */
  readonly container = new Container();
  private readonly tiers: [Tier, Tier];
  private readonly slotOf = new Map<number, Slot>();

  constructor() {
    this.tiers = [this.makeTier(0, MIN_CAP), this.makeTier(1, MIN_CAP)];
    this.container.eventMode = "none";
    this.container.addChild(this.tiers[0].mesh, this.tiers[1].mesh);
  }

  private makeTier(tier: 0 | 1, cap: number): Tier {
    const pos = new Float32Array(cap * FLOATS_PER_SLOT);
    const geo = new MeshGeometry({ positions: pos, uvs: new Float32Array(cap * FLOATS_PER_SLOT), indices: identity(cap), topology: "line-list" });
    const mesh = new Mesh({ geometry: geo, texture: tierTexture(tier) });
    return { geo, mesh, pos, cap, high: 0, free: [], dirty: false };
  }

  /** Re-tint the tier lines after a light/dark theme flip (the tree rebuilds around this). */
  refreshTheme(): void {
    for (let t = 0 as 0 | 1; t < 2; t++) this.tiers[t].mesh.texture = tierTexture(t as 0 | 1);
  }

  /** Drop every edge (a full rebuild follows). Keeps the allocated buffers. */
  clear(): void {
    this.slotOf.clear();
    for (const t of this.tiers) {
      t.pos.fill(0);
      t.high = 0;
      t.free.length = 0;
      t.dirty = true;
    }
  }

  /** Upsert an edge's endpoints. Re-tiering (a preserved node that changed depth parity) frees the
   *  old slot and allocates in the new tier — so the same key can migrate between the two meshes. */
  set(key: number, tier: 0 | 1, x1: number, y1: number, x2: number, y2: number): void {
    let slot = this.slotOf.get(key);
    if (slot && slot.tier !== tier) {
      this.freeSlot(slot);
      slot = undefined;
    }
    if (!slot) {
      slot = { tier, idx: this.alloc(tier) };
      this.slotOf.set(key, slot);
    }
    const t = this.tiers[tier];
    const o = slot.idx * FLOATS_PER_SLOT;
    t.pos[o] = x1;
    t.pos[o + 1] = y1;
    t.pos[o + 2] = x2;
    t.pos[o + 3] = y2;
    t.dirty = true;
  }

  /** Remove an edge (its slot is collapsed and recycled). No-op if it isn't present. */
  remove(key: number): void {
    const slot = this.slotOf.get(key);
    if (!slot) return;
    this.freeSlot(slot);
    this.slotOf.delete(key);
  }

  /** Upload the tiers whose slots changed since the last commit. */
  commit(): void {
    for (const t of this.tiers) {
      if (!t.dirty) continue;
      t.geo.getBuffer("aPosition").update();
      t.dirty = false;
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private freeSlot(slot: Slot): void {
    const t = this.tiers[slot.tier];
    const o = slot.idx * FLOATS_PER_SLOT;
    t.pos[o] = t.pos[o + 1] = t.pos[o + 2] = t.pos[o + 3] = 0; // collapse → degenerate (no fragments)
    t.free.push(slot.idx);
    t.dirty = true;
  }

  private alloc(tier: 0 | 1): number {
    const t = this.tiers[tier];
    const idx = t.free.pop();
    if (idx !== undefined) return idx;
    if (t.high >= t.cap) this.grow(t);
    return t.high++;
  }

  // Double the tier's capacity, preserving the live slots.
  private grow(t: Tier): void {
    const cap = t.cap * 2;
    const pos = new Float32Array(cap * FLOATS_PER_SLOT);
    pos.set(t.pos);
    t.pos = pos;
    t.cap = cap;
    t.geo.positions = pos;
    t.geo.uvs = new Float32Array(cap * FLOATS_PER_SLOT);
    t.geo.indices = identity(cap);
  }
}

/** Identity line-list indices: segment `i` connects vertices `2i`, `2i+1` (i.e. slot `i`). */
function identity(cap: number): Uint32Array {
  const idx = new Uint32Array(cap * 2);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return idx;
}

// A 2×2 solid-color texture for a tier (line-list samples it at uv 0 → flat color, no per-mesh
// tint needed). Rebuilt on demand so a theme flip re-colors the lines.
function tierTexture(tier: 0 | 1): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const ctx = canvas.getContext("2d")!;
  const c = edgeTierColor(tier);
  ctx.fillStyle = `#${c.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, 2, 2);
  return new Texture({ source: Texture.from(canvas).source, frame: new Rectangle(0, 0, 2, 2) });
}
