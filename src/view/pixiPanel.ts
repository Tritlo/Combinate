/**
 * Shared Pixi overlay chrome for the Zoo and Golf panels — the only two views that build a
 * full-screen modal *inside* Pixi rather than the DOM (see `modal.ts`'s doc comment for why the
 * DOM `Modal` doesn't fit them: they host a Pixi-drawn list/detail, not HTML). Both panels used to
 * hand-roll an identical backdrop-closes / card-stops-propagation / ✕ close-button / masked-list
 * wheel-scroll boilerplate; this factors that out. Each panel keeps its own title, card size, tabs,
 * and list/detail content — only the truly-identical chrome lives here.
 */
import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text } from "pixi.js";
import { theme } from "./theme";

/** The Pixi primitives a panel already owns, wired up by {@link wirePanelChrome}. */
export interface PanelParts {
  panel: Container;
  backdrop: Graphics;
  card: Graphics;
  closeBtn: Container;
  listView: Container;
  listMask: Graphics;
}

/** How a panel's scrolling list is read/written — {@link wirePanelChrome}'s wheel handler clamps
 *  through this instead of touching the list position itself (each panel repositions its own way). */
export interface ScrollState {
  get: () => number;
  set: (v: number) => void;
  listH: () => number;
  viewH: () => number;
}

/** Wire the backdrop-closes / card-stops-propagation / wheel-scroll handlers, build the ✕ close
 *  button (32×32 hit area), and mask the list. Call once, from the panel's own `buildPanel`. */
export function wirePanelChrome(p: PanelParts, close: () => void, scroll: ScrollState): void {
  p.backdrop.eventMode = "static";
  p.backdrop.on("pointerdown", close);
  p.card.eventMode = "static";
  p.card.on("pointerdown", (e: FederatedPointerEvent) => e.stopPropagation());
  // wheel anywhere on the panel scrolls the list
  p.panel.eventMode = "static";
  p.panel.on("wheel", (e: { deltaY: number }) => {
    const max = Math.max(0, scroll.listH() - scroll.viewH());
    scroll.set(Math.round(Math.min(max, Math.max(0, scroll.get() + e.deltaY)))); // whole-pixel scroll keeps text crisp
  });

  const x = new Text({ text: "✕", style: { fontFamily: "monospace", fontSize: 20, fill: theme.textDim } });
  x.anchor.set(0.5);
  p.closeBtn.addChild(x);
  p.closeBtn.eventMode = "static";
  p.closeBtn.cursor = "pointer";
  p.closeBtn.hitArea = new Rectangle(-16, -16, 32, 32);
  p.closeBtn.on("pointerdown", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    close();
  });

  p.listView.mask = p.listMask;
}

/** Centre a `w`×`h` card on the viewport (rounded to whole pixels, so text isn't rendered on a
 *  sub-pixel offset and goes blurry), draw the backdrop + card, and position the title + close
 *  button. Returns the card origin for the caller's own list/detail geometry. */
export function placeCard(parts: { backdrop: Graphics; card: Graphics; title: Text; closeBtn: Container }, w: number, h: number): { x: number; y: number } {
  const x = Math.round((window.innerWidth - w) / 2);
  const y = Math.round((window.innerHeight - h) / 2);
  parts.backdrop.clear().rect(0, 0, window.innerWidth, window.innerHeight).fill({ color: theme.backdrop, alpha: theme.backdropAlpha });
  parts.card.clear().roundRect(x, y, w, h, 14).fill({ color: theme.panel }).stroke({ width: 2, color: theme.border });
  parts.title.position.set(x + 24, y + 18);
  parts.closeBtn.position.set(x + w - 28, y + 28);
  return { x, y };
}
