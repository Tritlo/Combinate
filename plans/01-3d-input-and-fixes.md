# [01] 3D input + fixes (color, expand-ι, mouse, gamepad, touch)

Do first — it settles the camera/input model the gamepad + touch reuse.

## Findings (current code)
- `sphere3d.ts` colors nodes via `combinatorColor(n.sym)` on a `MeshLambertMaterial` + per-
  instance `setColorAt`; lit by ambient 0.65 + one directional 0.9. In MONO mode combinatorColor
  is ink (black in light theme) — so "all black" is partly *mono default*, and Lambert shading
  further mutes hues.
- 3D renders `focus.node` (the LOGICAL term) — it does NOT use the "Expand ι-trees" display the
  2D `TreeView` builds (`expand()`), so the Expand view has no effect in 3D.
- The orbit camera is orbit-only (azimuth/polar/radius around the origin) — **no pan**. Mouse
  orbit is LEFT-drag (app stage pointer when `view3D`).

## Fixes + additions
1. **Color** — diagnose "leaves all black": (a) make 3D react to the Color (4096) toggle (verify
   the `retheme()` path fires on `toggleColor`); (b) render hues VIVID like the 2D view — switch
   node material to unlit (`MeshBasicMaterial`) or add emissive, so per-combinator colors pop
   instead of being darkened by Lambert. Keep ι gold, free grey.
2. **Expand ι-trees in 3D** — render the EXPANDED display node when `expandAll` is on (reuse the
   2D expansion: undiscovered S/K/I → their ι-tree, and all combinators when Expand is on). Pass
   the display node (not the logical node) to `sphere3d.show/update`.
3. **Mouse: left-drag = PAN, right-drag = ORBIT** — add **pan** to the orbit camera (translate the
   look-at target in the camera's screen plane). Re-route the app's 3D pointer handlers: left
   button → pan, right button → orbit (suppress the context menu in 3D).
4. **Finish gamepad-3D** — orbit = L-stick (+ d-pad stepped), zoom = triggers, **pan = right-stick**,
   recenter = R3, exit = B. (Was keyboard/mouse only.)
5. **Touch** — pinch = zoom; one-finger / two-finger per the council (see Q). Needs the new pan.

## Council questions
- Mouse: left=pan / right=orbit (the user's ask) vs the more common left=orbit — confirm.
- Touch: (a) 1-finger orbit + 2-finger roll (no pan), (b) 1-finger pan + 2-finger orbit (needs
  pan — matches the user's "move around / rotate"), (c) 1-finger orbit + 2-finger pan (standard).
- Coloring: unlit `MeshBasic` (flat, vivid, matches 2D) vs keep Lambert (3D shading) with emissive.
- Gamepad pan on the right stick while orbit is on the left stick + d-pad — ergonomic?

## Council verdict (consensus)
- Ship 01 FIRST (it unblocks 06 + the gamepad/touch scheme).
- **Color**: "all black" is partly the MONO default — `combinatorColor` is intentionally ink in
  mono, so vivid hues require Color (4096) mode. Fix = (1) ensure the Color toggle re-renders 3D
  (retheme path already exists — verify it fires while `view3D`), (2) switch nodes to **unlit
  `MeshBasicMaterial`** (drop the lights) so Color-mode hues match the 2D palette exactly.
- **Camera pan**: add a `target: Vec3`; `place()` = `pos = target + sphericalOffset`, `lookAt(target)`;
  `pan(dx,dy)` translates `target` along the camera right/up vectors; `frame()` resets target=origin.
  Momentum stays on ORBIT only, not pan.
- **Mouse left=pan / right=orbit**: honor it (the user's ask; not a mistake — conventions vary,
  and 2D already treats left as primary). Suppress the context menu in 3D. (Optional later:
  Shift+left = orbit as a compatibility escape hatch.)
- **Gamepad**: L-stick orbit · right-stick pan · LT/RT zoom · R3 recenter (extend the gamepad
  sink/poll for the inspect context). **Touch**: 1-finger pan · 2-finger orbit · pinch zoom
  (consistent with mouse left=pan + the user's "move around / rotate").

## User refinement
- The 3D ι-tree rendering FOLLOWS the "Expand ι-trees" setting, and the 3D view **re-renders
  when settings change** (expand toggle, color mode, theme, native/optimize toggles that change
  the displayed term) — hook the existing settings-change events to `sphere3d.update`.
