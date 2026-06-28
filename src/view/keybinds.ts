/**
 * The keybinds reference page (ADR 17) — a System-1 modal listing the game-mode control
 * scheme, grouped, rendered straight from {@link keybindGroups} so it can't drift from the
 * real bindings. Read-only for now (rebinding is a later addition); also names the gamepad
 * button each action maps to, so the scheme reads as controller-first.
 */
import { Modal } from "./modal";
import { keybindGroups, keyGlyph } from "./keymap";

let injected = false;
function injectStyle(): void {
  if (injected) return;
  injected = true;
  const css = `
.kb-body { padding: 12px 18px 18px; font-size: 13px; }
.kb-intro { opacity: 0.7; font-size: 12.5px; margin-bottom: 12px; line-height: 1.4; }
.kb-group { font-weight: 700; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  opacity: 0.55; margin: 14px 0 5px; }
.kb-group:first-child { margin-top: 0; }
.kb-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px; padding: 4px 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--md-ink) 10%, transparent); }
.kb-label { }
.kb-keys { display: flex; gap: 4px; justify-content: flex-end; }
.kb-key { border: 1px solid var(--md-ink); border-radius: 3px; padding: 1px 6px; font-size: 12px; min-width: 16px;
  text-align: center; box-shadow: 1px 1px 0 color-mix(in srgb, var(--md-ink) 40%, transparent); }
.kb-pad { opacity: 0.5; font-size: 11.5px; min-width: 70px; text-align: right; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** Reduce ▸ Controls… — the control-scheme reference. */
export class KeybindsModal extends Modal {
  constructor() {
    super({ title: "Controls", width: "min(520px, 94vw)" });
    injectStyle();
    this.body.classList.add("kb-body");

    const intro = document.createElement("div");
    intro.className = "kb-intro";
    intro.textContent =
      "Turn on Game mode (Special ▸ Game mode) to play by keyboard or controller. Pick a combinator from the toolbar, drop it in a bucket, and apply terms together — they reduce on their own.";
    this.body.append(intro);

    for (const { group, binds } of keybindGroups()) {
      const h = document.createElement("div");
      h.className = "kb-group";
      h.textContent = group;
      this.body.append(h);
      for (const b of binds) {
        const row = document.createElement("div");
        row.className = "kb-row";
        const label = document.createElement("div");
        label.className = "kb-label";
        label.textContent = b.label;
        const keys = document.createElement("div");
        keys.className = "kb-keys";
        for (const k of b.keys) {
          const kb = document.createElement("span");
          kb.className = "kb-key";
          kb.textContent = keyGlyph(k);
          keys.append(kb);
        }
        const pad = document.createElement("div");
        pad.className = "kb-pad";
        pad.textContent = b.pad;
        row.append(label, keys, pad);
        this.body.append(row);
      }
    }
  }
}
