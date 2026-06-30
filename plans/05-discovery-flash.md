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

## User refinement (supersedes the "flash" framing above)
- It's a discovery **CARD**, not a flash: it shows the discovered combinator's **catalog entry**
  AND a small **3D rotating view** of it (reuse the [04] mini-3D auto-rotate widget). It must
  complete **at least one full rotation before fading**.
- Behaviour like a toast: **appears, holds, then fades after a while** — plus a **dismiss [x]**
  in the top-right corner of the card. Position under/left of the tracked quest (phone fallback
  per above).
- **Drop the existing discovery toast** (the card replaces it). Reduced-motion → static (no spin),
  brief hold.
- Shares the mini-3D-auto-rotate widget with [04] (Zoo 3D) — build it once, reuse in both.

## Completeness review fixes (council)
- **Rotation timing**: "≥1 rotation before fade" at a slow ~15°/s = ~24s — NOT toast-like. Fix:
  the card's mini-3D spins FAST (e.g. one full turn in ~2-3s), an explicit max lifetime, and
  dismiss / reduced-motion bypass the rotation (static).
- **No-WebGL fallback**: the card shows the 2D `renderPicture` if the 3D stack can't load —
  discovery must never depend on WebGL succeeding.
- Uses the POOLED `MiniSpherePreview` (shared with [04]) with card-takes-priority contention.
