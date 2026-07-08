/**
 * The Help window — the basics for a new player. Opened automatically on first launch and from the
 * menu. On the shared System-1 {@link Modal} chrome (ADR 12). Mouse basics + how to read a tree only
 * — no keyboard / gamepad controls here (those live in the on-screen hint bar).
 */
import { Modal } from "./modal";

let stylesInjected = false;
function injectHelpStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.hp-body { padding: 18px 22px 22px; font-size: 14px; line-height: 1.55; }
.hp-h1 { font-size: 24px; font-weight: 600; letter-spacing: 0.02em; }
.hp-dim { opacity: 0.6; }
.hp-sec { margin-top: 16px; }
.hp-sec h2 { font-size: 11px; letter-spacing: 0.08em; opacity: 0.5; margin: 0 0 5px; font-weight: 600; }
.hp-body ul { margin: 4px 0 0; padding-left: 18px; }
.hp-body li { margin: 4px 0; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

const BODY = `
  <div class="hp-h1">Welcome to Combinate</div>
  <div class="hp-dim">a sandbox where everything is built from one generator, ι (iota)</div>

  <div class="hp-sec">
    <h2>THE BASICS</h2>
    <ul>
      <li>Drag <b>ι</b> from the toolbar at the bottom onto the canvas.</li>
      <li>Drag one tree onto another to <b>snap</b> them together into a bigger term.</li>
      <li>Terms <b>reduce on their own</b> — watch them simplify, step by step.</li>
      <li><b>Right-click</b> a node to delete it.</li>
      <li>Build things that <em>behave</em> like a known combinator and you'll <b>discover</b> it (a named bird).</li>
    </ul>
  </div>

  <div class="hp-sec">
    <h2>READING A TREE</h2>
    <ul>
      <li>Every node applies a <b>function</b> to an <b>argument</b> (snap two trees: the left one becomes the function).</li>
      <li><b>Solid</b> edge = function; <b>dashed</b> edge = argument.</li>
      <li>Edge <b>color</b> alternates red / black by depth, so a node's parent edge is a different color from its child edges — handy for tracing direction.</li>
      <li>ι is a gray dot; named combinators are colored and lettered.</li>
    </ul>
  </div>

  <div class="hp-sec hp-dim">You can reopen this any time from the ι menu ▸ How to play.</div>
`;

export class Help extends Modal {
  constructor() {
    super({ title: "How to play", width: "min(520px, 92vw)" });
    injectHelpStyles();
    this.body.classList.add("hp-body");
    this.body.innerHTML = BODY;
  }
}
