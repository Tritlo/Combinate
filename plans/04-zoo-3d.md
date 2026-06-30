# [04] Zoo creature picture: [2D|3D] toggle + slow auto-rotate

## Findings
- `zoo.ts` `renderPicture(tree, size)` returns a Pixi `Container` (the creature's 2D ι-tree
  picture); there's already a top-right "play tone" button on the picture box.

## Plan
- Add a small **[2D|3D] toggle** at the **bottom-right** of the picture box.
- **3D** = the creature's term rendered as the packed sphere, **continuously + slowly auto-
  rotating, NON-interactive** (no input) — pure wow.
- Reuse the Three layout/renderer (layout3d + a small sphere3d variant) sized to the picture box.

## Council questions (the embedding is the crux)
- The zoo picture is a Pixi Container; the 3D is a Three canvas. Embed how? — a small Three
  canvas drawn as a Pixi texture (compositing "A", proven) sized to the box, OR a positioned DOM
  canvas overlaid on the box. Reuse `Sphere3D` (full-screen oriented) vs a lightweight
  `MiniSphere3D` widget (own tiny renderer + auto-spin ticker)?
- One shared Three context/renderer for the zoo + the main 3D view, or separate? (Lazy-load three
  either way.)
- Auto-rotate cadence (deg/sec); pause when the zoo is closed (no wasted rAF).

## Council verdict (consensus)
- Embed via **compositing-A inside the Pixi picture Container**: an off-DOM Three canvas →
  `Texture` → `Sprite` child sized/positioned to the picture box (same `onFrame → source.update`
  pattern as the main view — no new upload surprises). Keeps clipping/layout with the Pixi Zoo.
- **A separate, reusable lightweight preview `Sphere3D` instance — do NOT share the main view's
  WebGLRenderer** (both advisors, firmly: sharing means threading an external renderer + switching
  targets/cameras + managing two states — more work + brittle; two tiny independent renderers are
  fine, GL context limits aren't a concern for a static scene). One `previewSphere`: created on
  first 3D-tab open, `.resize(box)`, `.update(node)`, a slow azimuth spin ticker ONLY while the
  zoo + 3D tab are visible, paused on close / 2D. DPR-capped. Reduced-motion → static (no spin).
- The [2D|3D] toggle lives in the detail box next to the ♪ button — don't touch `renderPicture`.

## Completeness review (council)
- Use the shared **pooled `MiniSpherePreview`** (one renderer for Zoo + discovery card, contention:
  active widget wins, card > zoo). Define its lifecycle: acquire/release, DPR cap, pause on closed
  Zoo / `document.hidden` / `withMotion` false, dispose on teardown, no-WebGL → 2D fallback,
  headless smoke screenshot.
