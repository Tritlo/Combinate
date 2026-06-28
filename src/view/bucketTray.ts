/**
 * The bucket tray (ADR 17) — the game-mode HUD. A fixed row of bucket slot-chips near the
 * top, a "holding" badge for the hand, and a contextual key-hint line. This is the navigable
 * surface a d-pad/controller drives; each bucket's actual term is a world-space `TreeView`
 * (the tray just mirrors which slots are full + which is selected). Pure view: it renders the
 * {@link TrayState} the `GameInputController` hands it, and self-repaints on a theme change.
 */
import { Container, Graphics, Text } from "pixi.js";
import { currentMode, onThemeChange, theme } from "./theme";

function mono(): { paper: number; ink: number } {
  return currentMode() === "dark" ? { paper: 0x07090d, ink: 0xf0f3f6 } : { paper: 0xffffff, ink: 0x000000 };
}

/** What the tray shows. The controller owns this state and re-renders on every change. */
export interface TrayState {
  buckets: (string | null)[]; // short label per bucket (null = empty)
  selected: number; // the selected bucket index
  zone: "hotbar" | "buckets"; // which surface the cursor is on (buckets highlight only in their zone)
  hand: string | null; // the held term's label, or null
  hint: string; // a contextual key-hint line
}

const CHIP_W = 116;
const CHIP_H = 40;
const GAP = 10;

export class BucketTray {
  readonly container = new Container();
  private readonly chips = new Container();
  private readonly hand = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 13, fontWeight: "600", fill: theme.iota } });
  private readonly hint = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 12, fill: theme.textDim } });
  private last: TrayState | null = null;

  constructor() {
    this.hand.anchor.set(0.5, 0.5);
    this.hint.anchor.set(0.5, 0);
    this.container.addChild(this.chips, this.hand, this.hint);
    this.container.visible = false;
    onThemeChange(() => {
      if (this.last) this.render(this.last);
    });
  }

  show(): void {
    this.container.visible = true;
    if (this.last) this.render(this.last);
  }
  hide(): void {
    this.container.visible = false;
  }

  /** Lay out the chips + badges from `state` (top-centre). Rebuilt each change. */
  render(state: TrayState): void {
    this.last = state;
    const { paper, ink } = mono();
    for (const c of this.chips.removeChildren()) c.destroy({ children: true });

    const n = state.buckets.length;
    const totalW = n * CHIP_W + (n - 1) * GAP;
    const left = window.innerWidth / 2 - totalW / 2;
    const y = 84; // below the read-out line, above the canvas action

    state.buckets.forEach((label, i) => {
      const cx = left + i * (CHIP_W + GAP);
      const sel = state.zone === "buckets" && i === state.selected;
      const chip = new Container();
      const box = new Graphics()
        .rect(cx, y, CHIP_W, CHIP_H)
        .fill({ color: paper, alpha: 0.92 })
        .stroke({ width: 1, color: ink });
      if (sel) box.rect(cx - 3, y - 3, CHIP_W + 6, CHIP_H + 6).stroke({ width: 2.5, color: theme.iota });
      chip.addChild(box);
      const idx = new Text({ text: `${i + 1}`, style: { fontFamily: "monospace", fontSize: 10, fill: theme.textDim } });
      idx.position.set(cx + 4, y + 3);
      chip.addChild(idx);
      const term = new Text({
        text: label ?? "·",
        style: { fontFamily: "monospace", fontSize: 14, fill: label ? ink : theme.textDim },
      });
      term.anchor.set(0.5, 0.5);
      const maxW = CHIP_W - 16;
      if (term.width > maxW) term.scale.set(maxW / term.width);
      term.position.set(cx + CHIP_W / 2, y + CHIP_H / 2 + 2);
      chip.addChild(term);
      this.chips.addChild(chip);
    });

    this.hand.style.fill = theme.iota;
    this.hand.text = state.hand ? `✋ ${state.hand}` : "";
    this.hand.visible = !!state.hand;
    this.hand.position.set(window.innerWidth / 2, y - 16);

    this.hint.style.fill = theme.textDim;
    this.hint.text = state.hint;
    this.hint.position.set(window.innerWidth / 2, y + CHIP_H + 10);
  }
}
