/**
 * The shared System-1 modal chrome (ADR 12). `Modal` owns *only* the window — the
 * paper/ink card, titlebar + close box, backdrop + ESC close, the once-injected
 * `@font-face`/stylesheet, light/dark palette, and the scroll fix — exposing a protected
 * `body` for subclasses to fill and an `onOpen()` refresh hook. Subclasses (Help/About/
 * AddRule) keep their own content + store logic + body CSS (their own prefix) so a chrome
 * fix lands here once. Zoo/Golf (Pixi) and the GitHub-styled MhsPanel deliberately don't use this.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: "#ffffff", ink: "#000000", backdrop: "rgba(27,31,36,0.5)", shadow: "rgba(0,0,0,0.85)" },
  dark: { paper: "#07090d", ink: "#f0f3f6", backdrop: "rgba(1,4,9,0.6)", shadow: "rgba(0,0,0,0.85)" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let chromeInjected = false;
function injectChrome(): void {
  if (chromeInjected) return;
  chromeInjected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.md-root { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center;
  background: var(--md-backdrop); font-family: ${MONO}; }
.md-card { width: var(--md-width, min(460px, 92vw)); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--md-paper); color: var(--md-ink); border: 1px solid var(--md-ink); box-shadow: 2px 2px 0 var(--md-shadow); }
.md-title { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: var(--md-ink); color: var(--md-paper); }
.md-close { width: 12px; height: 12px; border: 1.5px solid var(--md-paper); cursor: pointer; flex: 0 0 auto; }
.md-title span { font-weight: 600; font-size: 14px; }
.md-body { overflow-y: auto; min-height: 0; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

export interface ModalOpts {
  title: string;
  /** Card width override, e.g. `"min(540px, 92vw)"` (default 460px). */
  width?: string;
}

/** A System-1 modal window: chrome only. Fill `body`; override `onOpen` to refresh. */
export class Modal {
  protected readonly root = document.createElement("div");
  protected readonly card = document.createElement("div");
  protected readonly body = document.createElement("div");
  private readonly titleLabel = document.createElement("span");

  constructor(opts: ModalOpts) {
    injectChrome();
    this.root.className = "md-root";
    this.card.className = "md-card";
    if (opts.width) this.root.style.setProperty("--md-width", opts.width);
    this.applyPalette();
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close(); // click the backdrop
    });
    this.card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "md-title";
    const close = document.createElement("div");
    close.className = "md-close";
    close.title = "Close";
    close.addEventListener("pointerdown", () => this.close());
    this.titleLabel.textContent = opts.title;
    title.append(close, this.titleLabel);

    this.body.className = "md-body";
    this.card.append(title, this.body);
    this.root.append(this.card);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) this.close();
    });
  }

  get isOpen(): boolean {
    return this.root.style.display === "flex";
  }
  open(): void {
    this.onOpen();
    this.root.style.display = "flex";
  }
  close(): void {
    this.root.style.display = "none";
  }
  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }
  /** Refresh hook, run just before the modal shows. */
  protected onOpen(): void {}

  private applyPalette(): void {
    const mode = currentMode();
    const set = (vars: Record<string, string>): void => {
      for (const [k, v] of Object.entries(vars)) this.root.style.setProperty(`--md-${k}`, v);
    };
    set(PALETTE[mode]);
  }
}

