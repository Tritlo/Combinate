/**
 * The Add Rule window (Edit menu): the player types a rewrite rule like
 * `W f x = f x x` and it becomes a real combinator with a one-step law. On the
 * shared System-1 {@link Modal} chrome (ADR 12) — so it is an `.md-root` overlay,
 * which the app's keydown guard treats as "an overlay is up", yielding the game
 * controls to this focused text field so physical typing works. Parsing +
 * registration live in the pure core ({@link parseRule}/{@link defineRule}); this
 * file is just the form + its body CSS.
 */
import { Modal } from "./modal";
import { parseRule, defineRule } from "../core/authoring";

let stylesInjected = false;
function injectAddRuleStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.ar-body { padding: 16px 18px 18px; font-size: 14px; display: flex; flex-direction: column; gap: 10px; }
.ar-hint { opacity: 0.6; font-size: 12.5px; line-height: 1.4; }
.ar-input { font-family: inherit; font-size: 15px; padding: 7px 9px; width: 100%; box-sizing: border-box;
  background: var(--md-paper); color: var(--md-ink); border: 1.5px solid var(--md-ink); outline: none; }
.ar-error { color: #d22; font-size: 12.5px; min-height: 1.2em; }
.ar-foot { display: flex; justify-content: flex-end; gap: 8px; }
.ar-btn { font-family: inherit; font-size: 13px; font-weight: 600; padding: 4px 16px; cursor: pointer; border: 1px solid var(--md-ink); }
.ar-add { color: var(--md-paper); background: var(--md-ink); }
.ar-cancel { color: var(--md-ink); background: var(--md-paper); }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** Hooks the Add Rule modal needs from the shell. */
export interface AddRuleOpts {
  /** Mark the new combinator discovered and refresh the hotbar/Zoo so it shows. */
  reveal: (name: string) => void;
  /** Surface a status message (the discovery toast). */
  toast: (msg: string) => void;
}

export class AddRule extends Modal {
  private readonly input = document.createElement("input");
  private readonly error = document.createElement("div");

  constructor(private readonly hooks: AddRuleOpts) {
    super({ title: "Add Rule" });
    injectAddRuleStyles();
    this.body.classList.add("ar-body");

    const hint = document.createElement("div");
    hint.className = "ar-hint";
    hint.innerHTML = "Write a rewrite rule <b>name args = body</b> — e.g. <b>W f x = f x x</b>.<br>It becomes a combinator that, when given its arguments, rewrites to the body.";

    this.input.className = "ar-input";
    this.input.placeholder = "W f x = f x x";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep keys off the game controls (overlay guard already blocks, belt-and-braces)
      if (e.key === "Enter") this.add();
      else if (e.key === "Escape") this.close();
    });
    this.input.addEventListener("input", () => { this.error.textContent = ""; }); // a fresh edit clears the last error

    this.error.className = "ar-error";

    const foot = document.createElement("div");
    foot.className = "ar-foot";
    const cancel = document.createElement("button");
    cancel.className = "ar-btn ar-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("pointerdown", () => this.close());
    const add = document.createElement("button");
    add.className = "ar-btn ar-add";
    add.textContent = "Add";
    add.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // keep focus on the input
      this.add();
    });
    foot.append(cancel, add);

    this.body.append(hint, this.input, this.error, foot);
  }

  /** Parse the field; on error show it and stay open, on success register the
   *  rule, reveal it, toast, and close. */
  private add(): void {
    const r = parseRule(this.input.value);
    if ("error" in r) {
      this.error.textContent = r.error;
      return;
    }
    defineRule(r.name, r.args, r.body, r.lawText);
    this.hooks.reveal(r.name);
    this.hooks.toast(`added rule ${r.name}`);
    this.close();
  }

  protected override onOpen(): void {
    this.error.textContent = "";
    this.input.value = "";
    // The card is display:none until open() flips it; focus after that lands.
    setTimeout(() => this.input.focus(), 0);
  }
}
