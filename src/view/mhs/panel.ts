/**
 * The Haskell → ι panel (ADR 0007): a DOM overlay (text editing is far nicer in
 * the DOM than in Pixi). It leads with curated examples — click one to compile it
 * (a pre-compiled, vendored dump) and drop the resulting combinator tree on the
 * canvas — and offers a free-type editor that compiles live through the stock
 * MicroHs blob (best-effort). The post-processing is the same `core/mhs.ts`.
 */
import type { Node } from "../../core/term";
import type { Ty } from "../../core/types";
import { EXAMPLES, type Example } from "./examples";
import { exampleDump, liveCompile, toTree } from "./compiler";

export class MhsPanel {
  private readonly root = document.createElement("div");
  private readonly editor = document.createElement("textarea");
  private readonly status = document.createElement("div");
  private current: Example = EXAMPLES[0];
  private open_ = false;

  /** @param onRun spawn a compiled tree, with the read-out lens to view it under.
   *  @param onToggle repaint the shell rail (so the button reflects open state). */
  constructor(
    private readonly onRun: (tree: Node, read: Ty | null) => void,
    private readonly onToggle: () => void,
  ) {
    this.build();
    document.body.appendChild(this.root);
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
    Object.assign(this.root.style, {
      display: "none",
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.55)",
      zIndex: "50",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "monospace",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    const card = el("div", {
      background: "#1a1d23",
      color: "#d8dee9",
      border: "1px solid #3b4252",
      borderRadius: "12px",
      width: "min(860px, 94vw)",
      height: "min(560px, 90vh)",
      display: "flex",
      flexDirection: "column",
      boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    });
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    // header
    const head = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid #2e3440" });
    head.appendChild(text("Haskell → ι", { fontSize: "18px", color: "#88c0d0" }));
    const x = text("✕", { cursor: "pointer", fontSize: "18px", color: "#6b7280", padding: "0 6px" });
    x.addEventListener("pointerdown", () => this.close());
    head.appendChild(x);
    card.appendChild(head);

    // body: examples | editor
    const body = el("div", { display: "flex", flex: "1", minHeight: "0" });
    const list = el("div", { width: "210px", borderRight: "1px solid #2e3440", overflowY: "auto", padding: "8px" });
    list.appendChild(text("EXAMPLES", { color: "#6b7280", fontSize: "11px", padding: "4px 6px 8px" }));
    for (const ex of EXAMPLES) {
      const row = el("div", { padding: "8px 10px", borderRadius: "8px", cursor: "pointer", marginBottom: "2px" });
      row.appendChild(text(ex.title, { color: "#e5e9f0", fontSize: "14px" }));
      row.appendChild(text(ex.blurb, { color: "#6b7280", fontSize: "11px", marginTop: "3px", lineHeight: "1.35" }));
      row.addEventListener("pointerenter", () => (row.style.background = "#252a33"));
      row.addEventListener("pointerleave", () => (row.style.background = "transparent"));
      row.addEventListener("pointerdown", () => this.loadExample(ex));
      list.appendChild(row);
    }
    body.appendChild(list);

    const right = el("div", { flex: "1", display: "flex", flexDirection: "column", padding: "12px", gap: "10px", minWidth: "0" });
    Object.assign(this.editor.style, {
      flex: "1",
      resize: "none",
      background: "#0f1115",
      color: "#d8dee9",
      border: "1px solid #2e3440",
      borderRadius: "8px",
      padding: "10px",
      fontFamily: "monospace",
      fontSize: "13px",
      lineHeight: "1.5",
      whiteSpace: "pre",
    } satisfies Partial<CSSStyleDeclaration>);
    this.editor.spellcheck = false;
    right.appendChild(this.editor);

    const bar = el("div", { display: "flex", alignItems: "center", gap: "12px" });
    const run = text("Compile & run ▶", {
      background: "#5e81ac",
      color: "#eceff4",
      padding: "8px 14px",
      borderRadius: "8px",
      cursor: "pointer",
      fontSize: "13px",
    });
    run.addEventListener("pointerdown", () => this.runEditor());
    bar.appendChild(run);
    Object.assign(this.status.style, { color: "#81a1c1", fontSize: "12px", flex: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    bar.appendChild(this.status);
    right.appendChild(bar);
    body.appendChild(right);

    card.appendChild(body);
    this.root.appendChild(card);
    this.loadExample(EXAMPLES[0], false);
  }

  /** Select an example: show its source and (unless suppressed) compile + run it
   *  from its pre-compiled dump — the reliable, wasm-free path. */
  private async loadExample(ex: Example, run = true): Promise<void> {
    this.current = ex;
    this.editor.value = ex.source.trimEnd();
    if (!run) return;
    this.setStatus(`compiling ${ex.title}…`, "#81a1c1");
    try {
      const dump = await exampleDump(ex.name);
      const res = toTree(dump, ex.root);
      if ("error" in res) {
        this.setStatus(res.error, "#bf616a");
        return;
      }
      this.onRun(res.tree, ex.read);
      this.setStatus(`compiled ${ex.title} — watch it reduce`, "#a3be8c");
      this.close();
    } catch (e) {
      this.setStatus((e as Error).message, "#bf616a");
    }
  }

  /** Compile whatever is in the editor. If it's the unchanged example source, use
   *  the fast pre-compiled dump; otherwise compile live through the stock blob. */
  private async runEditor(): Promise<void> {
    const src = this.editor.value;
    if (src.trim() === this.current.source.trim()) return this.loadExample(this.current);
    this.setStatus("compiling live (loading the MicroHs blob)…", "#81a1c1");
    try {
      const dump = await liveCompile(src);
      const res = toTree(dump, "Ex.out");
      if ("error" in res) {
        this.setStatus(res.error, "#bf616a");
        return;
      }
      this.onRun(res.tree, null);
      this.setStatus("compiled — watch it reduce", "#a3be8c");
      this.close();
    } catch (e) {
      this.setStatus(`live compile: ${(e as Error).message}. Pick an example to compile offline.`, "#bf616a");
    }
  }

  private setStatus(msg: string, color: string): void {
    this.status.textContent = msg;
    this.status.style.color = color;
  }
}

// ---- tiny DOM helpers ----
function el(tag: string, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  Object.assign(e.style, style);
  return e;
}
function text(t: string, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const e = el("div", style);
  e.textContent = t;
  return e;
}
