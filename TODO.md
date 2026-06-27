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
- [x] **Factorial slowness** — diagnosed render-bound: `animateTo` redraws the
      whole edge path every tween frame (~6/step), and my new dashing multiplied
      that. Fix (Codex-reviewed): above `HEAVY=600` displayed nodes, jump-cut each
      step (settle instantly, no per-frame tween/redraw), draw argument edges
      solid, and pace steps at an 8ms gap. Validated: a bounded many-step
      reduction settles to the correct NF via the heavy path. (Exponential blow-up
      like `2 2 2 2` is still bounded by its 100k-node output — inherent, not a
      render bug.)

## Wrap-up
- [x] Codex review + simplify pass — found & fixed: heavy gap missing on the raw
      reduction path, glyphOn contrast mis-pick, hotbar text-on-white contrast;
      unified the dash threshold. Codex verdict: CONSENSUS, resolved.
- [x] Typecheck clean; in-browser smoke (colours, white bg, FPS, dashed ghost,
      heavy-path reduction) verified; pushed.
