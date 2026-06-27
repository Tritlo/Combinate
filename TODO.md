# TODO — UI / palette / perf batch

Tracking the current run of requests. Working with Codex; review + simplify with
Codex before pushing.

## Appearance
- [x] Move the **Dark mode** toggle into the View menu (was under the ι menu).
- [x] Light mode background must stay **white** (Colour mode `bg` → `#ffffff`,
      neutral panels — no warm cream).
- [x] **Per-combinator colours**: pin hues for the common birds (like sound's
      `FUNDAMENTAL`), hash the rest onto the wheel (like `pitchFor`). Colour mode
      only; mono keeps ink dots; glyph auto-contrasts.

## Camera
- [x] Allow **further zoom out** — min scale 0.2 → 0.04 so a fac-scale tree fits.

## Performance
- [x] **FPS counter** — View ▸ FPS counter, shown bottom-left.
- [ ] **Factorial is very slow** even with Optimize. Diagnose: render-bound or
      reduce-bound? Consider differential rendering (only update changed nodes
      instead of rebuilding the whole display each step).

## Wrap-up
- [ ] Codex review + simplify pass.
- [ ] Typecheck, verify in-browser, push.
