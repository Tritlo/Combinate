/**
 * The Haskell panel (ADR 0007, §B3): a DOM overlay with a code editor that
 * compiles a primitive-free Haskell program to a combinator tree and drops it on
 * the canvas. Leads with curated examples; shows an honest rejection for IO/FFI/
 * Float programs (no ι form).
 *
 * DOM (not Pixi) so a real `<textarea>` editor is available — allowed in the
 * view/shell layer (the purity rule is on `core/` only). Lazy: the compiler is
 * created on first compile, never on first paint.
 */

import type { Node } from "../../core/term";
import { theme } from "../theme";
import { type Compiler, makeCompiler } from "./compiler";
import { EXAMPLES } from "./examples";

const hex = (n: number): string => "#" + n.toString(16).padStart(6, "0");

/**
 * The toggled Haskell→ι panel. Construct once with a spawn callback; `toggle()`
 * shows/hides it. The compiler is built lazily on the first compile.
 */
export class MhsPanel {
  private readonly root: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly message: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly examplesRow: HTMLDivElement;
  private readonly compileBtn: HTMLButtonElement;
  private compiler?: Compiler;
  private open = false;

  /**
   * @param onSpawn called with the compiled tree to drop on the canvas.
   * @param onVisibilityChange called after the panel opens/closes (e.g. to
   *        repaint the rail button's active state when closed via the backdrop).
   */
  constructor(
    private readonly onSpawn: (tree: Node) => void,
    private readonly onVisibilityChange: () => void = () => {},
  ) {
    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:fixed;inset:0;display:none;z-index:50;font-family:monospace;";
    // Backdrop dims the canvas; clicking it closes the panel.
    const backdrop = document.createElement("div");
    backdrop.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.45);";
    backdrop.addEventListener("pointerdown", () => this.close());

    this.card = document.createElement("div");
    this.card.style.cssText =
      "position:absolute;top:0;right:0;height:100%;width:min(460px,92vw);box-sizing:border-box;" +
      "padding:18px;display:flex;flex-direction:column;gap:12px;overflow:auto;box-shadow:-8px 0 24px rgba(0,0,0,0.3);";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
    this.title = document.createElement("div");
    this.title.textContent = "Haskell → ι";
    this.title.style.cssText = "font-size:20px;font-weight:bold;";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText = "border:none;background:none;cursor:pointer;font-size:18px;";
    close.addEventListener("pointerdown", () => this.close());
    header.append(this.title, close);

    const blurb = document.createElement("div");
    blurb.textContent =
      "Compile a closed, primitive-free program (Scott/Peano data) into a Barker-ι tree. IO, FFI, Float and machine literals have no ι form.";
    blurb.style.cssText = "font-size:12px;line-height:1.4;opacity:0.8;";

    const examplesLabel = document.createElement("div");
    examplesLabel.textContent = "examples";
    examplesLabel.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.6;";
    this.examplesRow = document.createElement("div");
    this.examplesRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";

    this.textarea = document.createElement("textarea");
    this.textarea.spellcheck = false;
    this.textarea.style.cssText =
      "width:100%;box-sizing:border-box;min-height:200px;resize:vertical;font-family:monospace;" +
      "font-size:13px;line-height:1.45;padding:10px;border-radius:8px;tab-size:2;";
    // Keep app hotkeys (r=clear, t=layout, …) from firing while typing.
    this.textarea.addEventListener("keydown", (e) => e.stopPropagation());

    this.compileBtn = document.createElement("button");
    this.compileBtn.textContent = "compile & drop";
    this.compileBtn.style.cssText =
      "padding:10px 14px;border-radius:8px;cursor:pointer;font-family:monospace;font-size:14px;font-weight:bold;border:none;";
    this.compileBtn.addEventListener("pointerdown", () => void this.run());

    this.message = document.createElement("div");
    this.message.style.cssText = "font-size:12px;line-height:1.45;min-height:18px;white-space:pre-wrap;";

    this.card.append(header, blurb, examplesLabel, this.examplesRow, this.textarea, this.compileBtn, this.message);
    this.root.append(backdrop, this.card);
    // The card swallows pointer events so backdrop-close only fires outside it.
    this.card.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(this.root);

    this.buildExamples();
    if (EXAMPLES[0]) this.textarea.value = EXAMPLES[0].source;
  }

  private buildExamples(): void {
    for (const ex of EXAMPLES) {
      const b = document.createElement("button");
      b.textContent = ex.name;
      b.title = ex.note;
      b.style.cssText = "padding:5px 9px;border-radius:6px;cursor:pointer;font-family:monospace;font-size:12px;";
      b.dataset.kind = "example";
      b.addEventListener("pointerdown", () => {
        this.textarea.value = ex.source;
        this.setMessage(ex.note, "dim");
      });
      this.examplesRow.appendChild(b);
    }
  }

  private setMessage(text: string, kind: "dim" | "error" | "ok"): void {
    this.message.textContent = text;
    this.message.style.color = kind === "error" ? hex(theme.fnEdge) : kind === "ok" ? hex(theme.root) : hex(theme.textDim);
  }

  private async run(): Promise<void> {
    this.compiler ??= makeCompiler(); // lazy: only on first compile
    this.setMessage("compiling…", "dim");
    const result = await this.compiler.compile(this.textarea.value);
    if ("error" in result) {
      this.setMessage(result.error, "error");
      return;
    }
    this.onSpawn(result.tree);
    this.setMessage(`dropped — ${result.bitcode.length} ι symbols`, "ok");
    this.close();
  }

  /** Re-read the live theme into the panel's colours (called on open). */
  private restyle(): void {
    this.card.style.background = hex(theme.panel);
    this.card.style.color = hex(theme.text);
    this.card.style.border = `1px solid ${hex(theme.border)}`;
    this.title.style.color = hex(theme.iota);
    this.textarea.style.background = hex(theme.inset);
    this.textarea.style.color = hex(theme.text);
    this.textarea.style.border = `1px solid ${hex(theme.border)}`;
    this.compileBtn.style.background = hex(theme.node);
    this.compileBtn.style.color = "#ffffff";
    for (const b of Array.from(this.examplesRow.children) as HTMLButtonElement[]) {
      b.style.background = hex(theme.inset);
      b.style.color = hex(theme.text);
      b.style.border = `1px solid ${hex(theme.border)}`;
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  open_(): void {
    this.open = true;
    this.restyle();
    this.root.style.display = "block";
    this.textarea.focus();
    this.onVisibilityChange();
  }

  close(): void {
    this.open = false;
    this.root.style.display = "none";
    this.onVisibilityChange();
  }

  toggle(): void {
    if (this.open) this.close();
    else this.open_();
  }
}
