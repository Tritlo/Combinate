/**
 * The discovery card (ADR 17, plan 05): when you discover a combinator, a small card pops under the
 * tracked quest showing its catalog entry (glyph · bird · law · ι-count) beside a 2D picture of its
 * ι-tree. It appears, holds, then fades like a toast — with a dismiss [×]. DOM (matches the quest
 * tracker's System-1 chrome). The picture is a plain 2D canvas drawing (reliable everywhere) — an
 * earlier 3D mini-view didn't render dependably inside a DOM card, so it's 2D only.
 */
import { type Law, iotaTreeOf, countIotas, META } from "../core/catalog";
import { type Node } from "../core/term";
import { layoutHTree } from "../core/layout";
import { currentMode, type Mode, MONO, PAPER, INK, ensureFont } from "./theme";

/** Draw a term's ι-tree onto a 2D canvas (the discovery card's picture — reliable everywhere, no
 *  WebGL). Colors come from the per-mode {@link Viewport} palette so the picture tracks light/dark
 *  like the rest of the card; fit + centered. */
function draw2DTree(canvas: HTMLCanvasElement, node: Node, px: number, v: Viewport): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = px * dpr;
  canvas.height = px * dpr;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = v.bg; // opaque viewport (covers the fallback glyph underneath)
  ctx.fillRect(0, 0, px, px);
  const lay = layoutHTree(node);
  const pad = 12;
  const s = Math.min((px - 2 * pad) / Math.max(lay.width, 1), (px - 2 * pad) / Math.max(lay.height, 1));
  const ox = px / 2 - (lay.minX + lay.width / 2) * s;
  const oy = px / 2 - (lay.minY + lay.height / 2) * s;
  const X = (x: number): number => x * s + ox;
  const Y = (y: number): number => y * s + oy;
  ctx.strokeStyle = v.edge;
  ctx.lineWidth = 1.4;
  const edges = (n: Node): void => {
    if (n.kind !== "app") return;
    const p = lay.pos.get(n.id);
    const l = lay.pos.get(n.fn.id);
    const r = lay.pos.get(n.arg.id);
    if (p && l) ctx.beginPath(), ctx.moveTo(X(p.x), Y(p.y)), ctx.lineTo(X(l.x), Y(l.y)), ctx.stroke();
    if (p && r) ctx.beginPath(), ctx.moveTo(X(p.x), Y(p.y)), ctx.lineTo(X(r.x), Y(r.y)), ctx.stroke();
    edges(n.fn);
    edges(n.arg);
  };
  edges(node);
  const seen = new Set<number>();
  const nodes = (n: Node): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const p = lay.pos.get(n.id);
    if (p) {
      ctx.fillStyle = n.kind === "iota" ? v.iota : n.kind === "app" ? v.app : v.leaf;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), n.kind === "iota" ? 3.5 : n.kind === "app" ? 2.5 : 5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (n.kind === "app") nodes(n.fn), nodes(n.arg);
  };
  nodes(node);
}

const PREVIEW_PX = 110; // the picture size (px)
const HOLD_MS = 3000; // how long the card holds before fading (toast-like)
const FADE_MS = 500;

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: PAPER.light, ink: INK.light, shadow: "rgba(0,0,0,0.85)", gold: "#8a6300" },
  dark: { paper: PAPER.dark, ink: INK.dark, shadow: "rgba(0,0,0,0.85)", gold: "#f0b72f" },
};

// The ι-tree picture viewport (the .disco-3d box) — its own per-mode palette so the picture tracks
// light/dark with the card, instead of a fixed dark screen. The viewport sits just off the card
// paper (lighter than paper on dark, darker than paper on light); the leaf nodes carry the most
// contrast against it, ι stays gold, application dots are muted.
type Viewport = { bg: string; edge: string; iota: string; app: string; leaf: string };
const VIEWPORT: Record<Mode, Viewport> = {
  light: { bg: "#eef0f2", edge: "#5a5a5a", iota: "#8a6300", app: "#a0a6ae", leaf: "#1a1d22" },
  dark: { bg: "#12141c", edge: "#9aa3b2", iota: "#f0b72f", app: "#5b6270", leaf: "#cdd2dc" },
};
let injected = false;
function inject(): void {
  if (injected) return;
  injected = true;
  ensureFont();
  const css = `
.disco-root { position: fixed; top: 360px; right: 16px; width: 248px; z-index: 39; font-family: ${MONO};
  opacity: 0; transform: translateY(10px); transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease; }
.disco-root.disco-in { opacity: 1; transform: none; }
.disco-card { background: var(--dc-paper); color: var(--dc-ink); border: 1px solid var(--dc-ink); box-shadow: 2px 2px 0 var(--dc-shadow); }
.disco-head { display: flex; align-items: center; gap: 8px; padding: 3px 8px; background: var(--dc-ink); color: var(--dc-paper); }
.disco-head span { flex: 1; font-weight: 600; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
.disco-x { width: 16px; height: 15px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--dc-paper); font-size: 12px; line-height: 1; cursor: pointer; }
.disco-body { display: flex; gap: 11px; padding: 11px; }
.disco-3d { position: relative; width: ${PREVIEW_PX}px; height: ${PREVIEW_PX}px; flex: 0 0 auto; background: var(--dc-view); border: 1px solid color-mix(in srgb, var(--dc-ink) 18%, transparent); overflow: hidden; }
.disco-glyph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 48px; color: var(--dc-gold); }
.disco-canvas { position: absolute; inset: 0; display: block; }
.disco-info { flex: 1; min-width: 0; }
.disco-name { font-weight: 700; font-size: 15px; }
.disco-law { font-size: 12.5px; line-height: 1.4; margin-top: 4px; color: color-mix(in srgb, var(--dc-ink) 80%, var(--dc-gold)); word-break: break-word; }
.disco-iotas { font-size: 11px; opacity: 0.6; margin-top: 6px; }
@media (max-width: 560px) { .disco-root { top: 50px; left: 12px; right: 12px; width: auto; } .disco-body { justify-content: center; } }
@media (prefers-reduced-motion: reduce) { .disco-root { transition: opacity 200ms ease; transform: none; } }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

export class DiscoveryCard {
  private root: HTMLElement | null = null;
  private holdTimer = 0;
  private fadeTimer = 0;

  /** Pop a discovery card for `law` (catalog entry + a 2D ι-tree picture), hold, then fade. A burst replaces the prior one. */
  show(law: Law): void {
    this.clear(); // bursts: the latest discovery replaces the previous card
    inject();
    const tree = iotaTreeOf(law);
    const mode = currentMode();
    const p = PALETTE[mode];
    const v = VIEWPORT[mode];

    const root = document.createElement("div");
    root.className = "disco-root";
    root.style.setProperty("--dc-paper", p.paper);
    root.style.setProperty("--dc-ink", p.ink);
    root.style.setProperty("--dc-shadow", p.shadow);
    root.style.setProperty("--dc-gold", p.gold);
    root.style.setProperty("--dc-view", v.bg);


    const bird = META[law.sym]?.bird;
    root.innerHTML = `
      <div class="disco-card">
        <div class="disco-head"><span>Discovered</span><div class="disco-x" role="button" aria-label="dismiss">×</div></div>
        <div class="disco-body">
          <div class="disco-3d"><div class="disco-glyph">${law.sym}</div></div>
          <div class="disco-info">
            <div class="disco-name">${bird ? `${law.sym} · ${bird}` : law.sym}</div>
            <div class="disco-law">${law.lawText}</div>
            <div class="disco-iotas">${countIotas(tree)} iotas</div>
          </div>
        </div>
      </div>`;
    (root.querySelector(".disco-x") as HTMLElement).addEventListener("pointerdown", () => this.clear());
    document.body.appendChild(root);
    this.root = root;

    // A 2D ι-tree picture on the dark viewport (3D doesn't render reliably in a DOM card, so 2D only).
    // The static glyph stays underneath as the fallback if the 2D canvas can't draw.
    const box = root.querySelector(".disco-3d") as HTMLElement;
    const canvas = document.createElement("canvas");
    canvas.className = "disco-canvas";
    draw2DTree(canvas, tree, PREVIEW_PX, v);
    box.appendChild(canvas);

    requestAnimationFrame(() => root.classList.add("disco-in")); // fade/slide in
    this.holdTimer = window.setTimeout(() => this.fade(), HOLD_MS);
  }

  private fade(): void {
    if (!this.root) return;
    this.root.classList.remove("disco-in");
    this.fadeTimer = window.setTimeout(() => this.clear(), FADE_MS);
  }

  /** Remove the card immediately (dismiss / replace / teardown). */
  clear(): void {
    clearTimeout(this.holdTimer);
    clearTimeout(this.fadeTimer);
    this.root?.remove();
    this.root = null;
  }
}
