/**
 * The About window (opened from the ι menu): who made it, what's clever about it,
 * and the credits / licenses. A System-1 Macintosh-styled DOM modal — black-and-
 * white chrome that inverts for dark mode, set in IoskeleyMono, like the menu bar.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: "#ffffff", ink: "#000000", backdrop: "rgba(27,31,36,0.5)", shadow: "rgba(0,0,0,0.85)" },
  dark: { paper: "#07090d", ink: "#f0f3f6", backdrop: "rgba(1,4,9,0.6)", shadow: "rgba(0,0,0,0.85)" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.ab-root { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center;
  background: var(--ab-backdrop); font-family: ${MONO}; }
.ab-card { width: min(540px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--ab-paper); color: var(--ab-ink); border: 1px solid var(--ab-ink); box-shadow: 2px 2px 0 var(--ab-shadow); }
.ab-title { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: var(--ab-ink); color: var(--ab-paper); }
.ab-close { width: 12px; height: 12px; border: 1.5px solid var(--ab-paper); cursor: pointer; flex: 0 0 auto; }
.ab-title span { font-weight: 600; font-size: 14px; }
.ab-body { padding: 18px 22px 22px; overflow-y: auto; font-size: 14px; line-height: 1.5; }
.ab-h1 { font-size: 28px; font-weight: 600; letter-spacing: 0.02em; }
.ab-dim { opacity: 0.6; }
.ab-sec { margin-top: 16px; }
.ab-sec h2 { font-size: 11px; letter-spacing: 0.08em; opacity: 0.5; margin: 0 0 5px; font-weight: 600; }
.ab-body ul { margin: 4px 0 0; padding-left: 18px; }
.ab-body li { margin: 3px 0; }
.ab-body a { color: inherit; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

const BODY = `
  <div class="ab-h1">Combinate</div>
  <div class="ab-dim">an interactive ι / SKI combinator-calculus sandbox</div>
  <div class="ab-dim">by Matthias Pall Gissurarson &lt;mpg@mpg.is&gt;</div>
  <div class="ab-dim">source: <a href="https://github.com/Tritlo/Combinate" target="_blank" rel="noopener">github.com/Tritlo/Combinate</a></div>

  <div class="ab-sec">
    <h2>UNDER THE HOOD</h2>
    <ul>
      <li>Everything is built from one generator, ι&nbsp;&nbsp;(ι x = x S K).</li>
      <li>Combinators are discovered <em>behaviourally</em> — (ι ι) is recognised as I by what it does, not how it's spelled.</li>
      <li>Call-by-need <em>graph</em> reduction shares subterms (drawn as a DAG), so even fac-scale terms terminate.</li>
      <li>The re-fold lens re-sugars SKI normal forms back into named birds with <em>egg</em> (e-graph rewriting), compiled to WebAssembly.</li>
      <li>Real Haskell compiles to combinator trees in the browser by post-processing <em>MicroHs</em>'s Scott-encoded dump, then reading the result back to Int / Bool / List / Char with Hindley–Milner types.</li>
      <li>A thousand nodes stay one batched draw — instanced particles, glyph LOD, and id-keyed tweening (persisting subtrees glide, fresh ones grow, dropped ones fade).</li>
    </ul>
  </div>

  <div class="ab-sec">
    <h2>CREDITS</h2>
    <ul>
      <li><b>Combinator birds</b> — Raymond Smullyan, <em>To Mock a Mockingbird</em> (1985).</li>
      <li><b>Quest</b> — adapted from the <a href="https://dallaylaen.github.io/ski-interpreter/quest.html" target="_blank" rel="noopener">SKI Quest</a> by Konstantin S. Uvarin (with permission).</li>
      <li><b>Haskell compiler &amp; inspiration</b> — MicroHs, by Lennart Augustsson.</li>
      <li><b>Re-folding</b> — egg (Max Willsey) · <b>Rendering</b> — Pixi.js · <b>Storage</b> — DuckDB · <b>Font</b> — IoskeleyMono (Ahmed Hatem).</li>
    </ul>
  </div>

  <div class="ab-sec ab-dim">
    Combinate is MIT-licensed. Third-party licenses (MicroHs Apache-2.0; egg / Pixi.js / DuckDB MIT; IoskeleyMono OFL-1.1) are in THIRD-PARTY-NOTICES.md.
  </div>
`;

export class About {
  private readonly root = document.createElement("div");

  constructor() {
    injectStyles();
    this.root.className = "ab-root";
    this.applyPalette();
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close(); // click the backdrop
    });

    const card = document.createElement("div");
    card.className = "ab-card";
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "ab-title";
    const close = document.createElement("div");
    close.className = "ab-close";
    close.title = "Close";
    close.addEventListener("pointerdown", () => this.close());
    const label = document.createElement("span");
    label.textContent = "About Combinate";
    title.append(close, label);

    const body = document.createElement("div");
    body.className = "ab-body";
    body.innerHTML = BODY;

    card.append(title, body);
    this.root.appendChild(card);
    document.body.appendChild(this.root);
    onThemeChange(() => this.applyPalette());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  open(): void {
    this.root.style.display = "flex";
  }
  close(): void {
    this.root.style.display = "none";
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--ab-${k}`, v);
  }
}
