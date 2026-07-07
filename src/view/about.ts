/**
 * The About window (opened from the ι menu): who made it, what's clever about it, and the
 * credits / licenses. On the shared System-1 {@link Modal} chrome (ADR 12); this file is
 * just the content + its body CSS.
 */
import { Modal } from "./modal";

let stylesInjected = false;
function injectAboutStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.ab-body { padding: 18px 22px 22px; font-size: 14px; line-height: 1.5; }
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
      <li>Combinators are discovered <em>behaviorally</em> — (ι ι) is recognized as I by what it does, not how it's spelled.</li>
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

export class About extends Modal {
  constructor() {
    super({ title: "About Combinate", width: "min(540px, 92vw)" });
    injectAboutStyles();
    this.body.classList.add("ab-body");
    this.body.innerHTML = BODY;
  }
}
