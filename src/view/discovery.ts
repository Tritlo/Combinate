/**
 * The discovery card (ADR 17, plan 05): when you discover a combinator, a small card pops under the
 * tracked quest showing its catalog entry (glyph · bird · law · ι-count) beside a fast-rotating 3D
 * mini-view of its ι-tree. It appears, holds for at least one full rotation, then fades like a toast
 * — with a dismiss [×]. DOM (matches the quest tracker's System-1 chrome). Reuses the pooled
 * {@link spherePreview} (the card outranks the Zoo: acquiring it preempts the Zoo's preview). On a
 * no-WebGL device or under reduced motion it shows the static glyph instead of the spinning sphere.
 */
import { type Law, iotaTreeOf, countIotas, META } from "../core/catalog";
import { spherePreview, FAST_SPIN, CARD_PRIO } from "./spherePreview";
import { currentMode, theme, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";
import { withMotion } from "./motion";

const PREVIEW_PX = 92; // 3D mini-view size
const HOLD_MS = 3200; // hold long enough for ≥1 full fast rotation (~2.6s) before fading
const HOLD_STILL_MS = 2000; // reduced-motion: a shorter static hold
const FADE_MS = 500;

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: "#ffffff", ink: "#000000", shadow: "rgba(0,0,0,0.85)", gold: "#8a6300" },
  dark: { paper: "#07090d", ink: "#f0f3f6", shadow: "rgba(0,0,0,0.85)", gold: "#f0b72f" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let injected = false;
function inject(): void {
  if (injected) return;
  injected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.disco-root { position: fixed; top: 360px; right: 16px; width: 248px; z-index: 39; font-family: ${MONO};
  opacity: 0; transform: translateY(10px); transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease; }
.disco-root.disco-in { opacity: 1; transform: none; }
.disco-card { background: var(--dc-paper); color: var(--dc-ink); border: 1px solid var(--dc-ink); box-shadow: 2px 2px 0 var(--dc-shadow); }
.disco-head { display: flex; align-items: center; gap: 8px; padding: 3px 8px; background: var(--dc-ink); color: var(--dc-paper); }
.disco-head span { flex: 1; font-weight: 600; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
.disco-x { width: 16px; height: 15px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--dc-paper); font-size: 12px; line-height: 1; cursor: pointer; }
.disco-body { display: flex; gap: 11px; padding: 11px; }
.disco-3d { position: relative; width: ${PREVIEW_PX}px; height: ${PREVIEW_PX}px; flex: 0 0 auto; background: var(--dc-inset); border: 1px solid color-mix(in srgb, var(--dc-ink) 18%, transparent); overflow: hidden; }
.disco-glyph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 40px; color: var(--dc-gold); }
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

  /** Pop a discovery card for `law`, hold (≥1 rotation), then fade. A burst replaces the prior one. */
  show(law: Law): void {
    this.clear(); // bursts: the latest discovery replaces the previous card
    inject();
    const tree = iotaTreeOf(law);
    const p = PALETTE[currentMode()];

    const root = document.createElement("div");
    root.className = "disco-root";
    root.style.setProperty("--dc-paper", p.paper);
    root.style.setProperty("--dc-ink", p.ink);
    root.style.setProperty("--dc-shadow", p.shadow);
    root.style.setProperty("--dc-gold", p.gold);
    root.style.setProperty("--dc-inset", `#${theme.inset.toString(16).padStart(6, "0")}`); // match the 3D scene bg



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

    // The fast-rotating 3D mini-view over the static glyph — or just the glyph (no WebGL / reduced motion).
    if (withMotion()) {
      const box = root.querySelector(".disco-3d") as HTMLElement;
      void spherePreview.acquire("card", CARD_PRIO, tree, PREVIEW_PX, { onFrame: () => {}, spin: FAST_SPIN }).then((canvas) => {
        if (!canvas || this.root !== root) return; // no WebGL → keep the glyph; or already dismissed
        canvas.className = "disco-canvas";
        canvas.style.width = `${PREVIEW_PX}px`;
        canvas.style.height = `${PREVIEW_PX}px`;
        box.appendChild(canvas);
      });
    }

    requestAnimationFrame(() => root.classList.add("disco-in")); // fade/slide in
    this.holdTimer = window.setTimeout(() => this.fade(), withMotion() ? HOLD_MS : HOLD_STILL_MS);
  }

  private fade(): void {
    if (!this.root) return;
    this.root.classList.remove("disco-in");
    this.fadeTimer = window.setTimeout(() => this.clear(), FADE_MS);
  }

  /** Remove the card + release the shared preview immediately (dismiss / replace / teardown). */
  clear(): void {
    clearTimeout(this.holdTimer);
    clearTimeout(this.fadeTimer);
    spherePreview.release("card");
    // hand the shared canvas back clean (detach it + drop our inline sizing) before tearing down the card
    const canvas = this.root?.querySelector("canvas");
    if (canvas) {
      canvas.removeAttribute("style");
      canvas.className = "";
      canvas.remove();
    }
    this.root?.remove();
    this.root = null;
  }
}
