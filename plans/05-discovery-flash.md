# [05] Discovery flash — flash a card under the tracked quest, fade out

## Findings
- `discover(law)` (app.ts ~277) reveals a combinator (hotbar + zoo). The tracked-quest card is a
  DOM element `.qt-root` (fixed, top:72 right:16, z-index 40; on phones it narrows / may relocate).

## Plan
- On discovery, show a **flash card to the left of / under the tracked quest** announcing the new
  combinator (its glyph + name + "discovered"), **flash bright then fade out** over ~1.5s.
- **Phones**: the tracked quest narrows on small screens; position the flash so it doesn't
  collide (e.g. centered-top banner under the menu bar on narrow widths, or below the quest card).
- Likely a DOM element (matches the quest tracker's DOM card + easy fade via CSS transition);
  reduced-motion → show without the flash (instant + brief hold).
- Optionally play the discovery tone here (see [03]).

## Council questions
- What exactly the flash shows ("the page to the left under the tracked quest" — a combinator
  card? the hotbar page that gained it?) — confirm the content + anchor.
- DOM vs Pixi for the flash (DOM = easy fade + phone layout; Pixi = in-canvas). Lean DOM.
- Phone placement rule.

## Council verdict (consensus)
- **DOM card** (reuse `.qt-root`'s paper/ink/font), absolutely positioned under/left of the quest
  card; on phones (where the quest card narrows to `calc(100vw-32px)`) fall back to a full-width
  banner just under the menu bar. CSS flash → fade (~1.5s), `pointer-events:none`, z below modals,
  above the canvas. Listen to the same layout/resize events as questTracker (avoid resize races).
- **Reduced-motion** → a short static show/hold, no flash.
- **Fold the discovery tone here** (moved out of `discover()` per [03]). Handle burst discoveries
  with replace-or-queue. Don't fire for authored-only names or during a progress reset.
