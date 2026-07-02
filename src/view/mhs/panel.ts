/**
 * The Haskell → ι panel (ADR 0007): a DOM overlay (text editing is far nicer in
 * the DOM than in Pixi). It leads with curated examples — click one to compile it
 * (a pre-compiled, vendored dump) and drop the resulting combinator tree on the
 * canvas — and offers a free-type editor that compiles live through the stock
 * MicroHs blob (best-effort). The post-processing is the same `core/mhs.ts`.
 *
 * The editor is syntax-highlighted: a transparent `<textarea>` over a coloured
 * `<pre>` (the standard overlay trick), tokenized by `highlight.ts` and painted in
 * GitHub's high-contrast palette, set in IoskeleyMono. The whole panel follows the
 * app's light/dark mode via CSS variables (re-themed on `onThemeChange`).
 */
import type { Node } from "../../core/term";
import type { Ty } from "../../core/types";
import { EXAMPLES, type Example } from "./examples";
import { exampleDump, liveCompile, toTree } from "./compiler";
import { highlightHaskell, HL_DARK, HL_LIGHT } from "./highlight";
import { currentMode, onThemeChange, type Mode, ensureFont } from "../theme";

/** GitHub-flavoured panel palette (chrome + the code surface), per mode. */
const PALETTE: Record<Mode, Record<string, string>> = {
  light: {
    backdrop: "rgba(27,31,36,0.5)", card: "#ffffff", fg: "#1f2328", border: "#d0d7de",
    muted: "#59636e", accent: "#0969da", accentFg: "#ffffff",
    editorBg: "#f6f8fa", editorFg: "#0e1116", rowHover: "#eaeef2",
  },
  dark: {
    backdrop: "rgba(1,4,9,0.6)", card: "#0d1117", fg: "#e6edf3", border: "#30363d",
    muted: "#9198a1", accent: "#4493f8", accentFg: "#0d1117",
    editorBg: "#0a0c10", editorFg: "#f0f3f6", rowHover: "#161b22",
  },
};

const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Inject the panel stylesheet once (the IoskeleyMono @font-face is shared, via {@link ensureFont}). */
let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  ensureFont();
  const css = `
.mhs-root { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center;
  background: var(--mhs-backdrop); font-family: ${MONO}; }
.mhs-card { display: flex; flex-direction: column; width: min(880px, 94vw); height: min(580px, 90vh);
  background: var(--mhs-card); color: var(--mhs-fg); border: 1px solid var(--mhs-border); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5); overflow: hidden; }
.mhs-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px;
  border-bottom: 1px solid var(--mhs-border); }
.mhs-title { font-size: 18px; color: var(--mhs-accent); font-weight: 600; }
.mhs-x { cursor: pointer; font-size: 18px; color: var(--mhs-muted); padding: 0 6px; }
.mhs-x:hover { color: var(--mhs-fg); }
.mhs-body { display: flex; flex: 1; min-height: 0; }
.mhs-list { width: 220px; border-right: 1px solid var(--mhs-border); overflow-y: auto; padding: 8px; }
.mhs-list-label { color: var(--mhs-muted); font-size: 11px; padding: 4px 6px 8px; letter-spacing: 0.06em; }
.mhs-row { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 2px; }
.mhs-row:hover { background: var(--mhs-rowHover); }
.mhs-row-title { color: var(--mhs-fg); font-size: 14px; }
.mhs-row-blurb { color: var(--mhs-muted); font-size: 11px; margin-top: 3px; line-height: 1.35; }
.mhs-right { flex: 1; display: flex; flex-direction: column; padding: 12px; gap: 10px; min-width: 0; }
.mhs-editorwrap { position: relative; flex: 1; min-height: 0; border: 1px solid var(--mhs-border); border-radius: 8px;
  background: var(--mhs-editorBg); overflow: hidden; }
.mhs-pre, .mhs-ta { position: absolute; inset: 0; margin: 0; padding: 10px; border: 0;
  font-family: ${MONO}; font-size: 13px; line-height: 1.5; tab-size: 2; white-space: pre;
  box-sizing: border-box; overflow: auto;
  font-variant-ligatures: contextual; font-feature-settings: "calt" 1, "liga" 1; }
.mhs-pre { color: var(--mhs-editorFg); overflow: hidden; pointer-events: none; }
.mhs-ta { background: transparent; color: transparent; caret-color: var(--mhs-editorFg); resize: none; outline: none; }
.mhs-bar { display: flex; align-items: center; gap: 12px; }
.mhs-run { background: var(--mhs-accent); color: var(--mhs-accentFg); padding: 8px 14px; border-radius: 8px;
  cursor: pointer; font-size: 13px; }
.mhs-status { color: var(--mhs-muted); font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mhs-status.mhs-busy::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 7px; vertical-align: -1px;
  border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: mhs-spin 0.7s linear infinite; }
@keyframes mhs-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mhs-status.mhs-busy::before { animation: none; } }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

export class MhsPanel {
  private readonly root = document.createElement("div");
  private readonly editor = document.createElement("textarea");
  private readonly pre = document.createElement("pre");
  private readonly status = document.createElement("div");
  private current: Example = EXAMPLES[0];
  private open_ = false;

  /** @param onRun spawn a compiled tree, with the read-out lens to view it under.
   *  @param onToggle repaint the shell rail (so the button reflects open state). */
  constructor(
    private readonly onRun: (tree: Node, read: Ty | null) => void,
    private readonly onToggle: () => void,
  ) {
    injectStyles();
    this.build();
    document.body.appendChild(this.root);
    onThemeChange(() => {
      this.applyPalette();
      this.updateHighlight();
    });
  }

  get isOpen(): boolean {
    return this.open_;
  }
  /** Example ids, for the E2E seam. */
  get examples(): string[] {
    return EXAMPLES.map((e) => e.name);
  }
  /** Compile + spawn an example by name (E2E seam). */
  run(name: string): void {
    const ex = EXAMPLES.find((e) => e.name === name);
    if (ex) void this.loadExample(ex);
  }
  /** Live-compile source through the blob and report the outcome (E2E seam). */
  async compileLive(source: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const dump = await liveCompile(source);
      const res = toTree(dump, "Ex.out");
      return "error" in res ? { ok: false, detail: res.error } : { ok: true, detail: "tree" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
  toggle(): void {
    this.open_ ? this.close() : this.open();
  }
  open(): void {
    this.open_ = true;
    this.root.style.display = "flex";
    this.onToggle();
  }
  close(): void {
    this.open_ = false;
    this.root.style.display = "none";
    this.onToggle();
  }

  // ---- UI ----
  private build(): void {
    this.root.className = "mhs-root";
    this.applyPalette();
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    const card = div("mhs-card");
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const head = div("mhs-head");
    head.appendChild(divText("mhs-title", "Haskell → ι"));
    const x = divText("mhs-x", "✕");
    x.addEventListener("pointerdown", () => this.close());
    head.appendChild(x);
    card.appendChild(head);

    const body = div("mhs-body");
    const list = div("mhs-list");
    list.appendChild(divText("mhs-list-label", "EXAMPLES"));
    for (const ex of EXAMPLES) {
      const row = div("mhs-row");
      row.appendChild(divText("mhs-row-title", ex.title));
      row.appendChild(divText("mhs-row-blurb", ex.blurb));
      row.addEventListener("pointerdown", () => this.loadExample(ex));
      list.appendChild(row);
    }
    body.appendChild(list);

    const right = div("mhs-right");
    const wrap = div("mhs-editorwrap");
    this.pre.className = "mhs-pre";
    this.pre.setAttribute("aria-hidden", "true");
    this.editor.className = "mhs-ta";
    this.editor.spellcheck = false;
    this.editor.autocapitalize = "off";
    this.editor.setAttribute("autocomplete", "off");
    this.editor.addEventListener("input", () => this.updateHighlight());
    this.editor.addEventListener("scroll", () => {
      this.pre.scrollTop = this.editor.scrollTop;
      this.pre.scrollLeft = this.editor.scrollLeft;
    });
    wrap.appendChild(this.pre);
    wrap.appendChild(this.editor);
    right.appendChild(wrap);

    const bar = div("mhs-bar");
    const run = divText("mhs-run", "Compile & run ▶︎"); // trailing U+FE0E — ▶ is emoji-eligible, forces text presentation
    run.addEventListener("pointerdown", () => this.runEditor());
    bar.appendChild(run);
    this.status.className = "mhs-status";
    bar.appendChild(this.status);
    right.appendChild(bar);
    body.appendChild(right);

    card.appendChild(body);
    this.root.appendChild(card);
    this.loadExample(EXAMPLES[0], false);
    this.setStatus("pick an example — instant · free-typing compiles live in-browser (~30s)", "muted");
  }

  /** Push the current mode's palette onto the root as CSS variables. */
  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--mhs-${k}`, v);
  }

  /** Re-paint the highlight layer from the editor's current text + mode. */
  private updateHighlight(): void {
    this.pre.innerHTML = highlightHaskell(this.editor.value, currentMode() === "dark" ? HL_DARK : HL_LIGHT);
    this.pre.scrollTop = this.editor.scrollTop;
    this.pre.scrollLeft = this.editor.scrollLeft;
  }

  /** Select an example: show its source and (unless suppressed) compile + run it
   *  from its pre-compiled dump — the reliable, wasm-free path. */
  private async loadExample(ex: Example, run = true): Promise<void> {
    this.current = ex;
    this.editor.value = ex.source.trimEnd();
    this.updateHighlight();
    if (!run) return;
    this.setStatus(`compiling ${ex.title}…`, "accent", true);
    try {
      // Fast path: the vendored pre-compiled dump. If it isn't vendored (e.g. a newer example on
      // the deployed site), fall back to compiling it live in-browser through the stock blob.
      let dump: string;
      try {
        dump = await exampleDump(ex.name);
      } catch {
        this.setStatus(`compiling ${ex.title} live in-browser — this takes ~30s…`, "accent", true);
        dump = await liveCompile(ex.source);
      }
      const res = toTree(dump, ex.root);
      if ("error" in res) {
        this.setStatus(res.error, "#cf222e");
        return;
      }
      this.onRun(res.tree, ex.read);
      this.setStatus(`compiled ${ex.title} — watch it reduce`, "#1a7f37");
      this.close();
    } catch (e) {
      this.setStatus((e as Error).message, "#cf222e");
    }
  }

  /** Compile whatever is in the editor. If it's the unchanged example source, use
   *  the fast pre-compiled dump; otherwise compile live through the stock blob. */
  private async runEditor(): Promise<void> {
    const src = this.editor.value;
    if (src.trim() === this.current.source.trim()) return this.loadExample(this.current);
    this.setStatus("compiling live in-browser — this takes ~30s…", "accent", true);
    try {
      const dump = await liveCompile(src);
      const res = toTree(dump, "Ex.out");
      if ("error" in res) {
        this.setStatus(res.error, "#cf222e");
        return;
      }
      this.onRun(res.tree, null);
      this.setStatus("compiled — watch it reduce", "#1a7f37");
      this.close();
    } catch (e) {
      this.setStatus(`live compile: ${(e as Error).message}. Pick an example to compile offline.`, "#cf222e");
    }
  }

  /** Set the status line. `color` is a literal hex, or a palette key (muted/accent). */
  private setStatus(msg: string, color: string, busy = false): void {
    this.status.textContent = msg;
    this.status.style.color = color === "muted" || color === "accent" ? `var(--mhs-${color})` : color;
    this.status.classList.toggle("mhs-busy", busy); // an animated spinner while a compile is running
  }
}

// ---- tiny DOM helpers ----
function div(cls: string): HTMLDivElement {
  const e = document.createElement("div");
  e.className = cls;
  return e;
}
function divText(cls: string, t: string): HTMLDivElement {
  const e = div(cls);
  e.textContent = t;
  return e;
}
