# [08] Control-scheme redesign — device tracker + contexts + adaptive hints

Lands EARLY (before [01]'s gamepad-3D) so 3D input routes through the final system — else we get
duplicate input handling the redesign would have to untangle. Partially started on-branch
(inputDevice.ts, a rewritten keymap.ts).

## Findings
- app.ts still has SEPARATE `gameMode` vs `view3D` keydown paths + direct `orbitDrag`/`heldRot`
  3D handling; the gamepad is wired only to the build sink; the old static keybinds modal exists.

## Plan
- **Device tracker** (`inputDevice.ts`, done): `activeDevice ∈ {kbm, pad}`, last-input-wins on a
  detected ACTION (not the connect event); pad glyphs only when `active === "pad"`.
- **Context router**: `build | inspect | free`; the same directional input navigates in Build /
  orbits in Inspect. Replace the `gameMode`/`view3D` dual paths with one context state; keydown
  + gamepad route per context.
- **Per-context keymap** (`keymap.ts`, drafted): Build (Tab/Start toggle, Q/E apply, V/Y → 3D,
  …) + Inspect (rotate, zoom, recenter, exit). Gamepad button→intent per context; analog
  (stick/triggers) handled in the gamepad layer.
- **Adaptive hints**: a bottom action-bar for the current context + sparse floating "E to use"
  prompts at the primary local action (selected chip / focused tree), glyph chosen by the active
  device. **Replaces the static keybinds modal** (keep a minimal reference if useful).
- Gamepad-3D ([01]) plugs into the inspect sink here.

## Council note
- Sequence: do this before [01]. Keep mouse drag/drop + global menu shortcuts always available.
