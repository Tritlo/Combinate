# Plan overview — 3D polish, progress bar, fluff cleanup, zoo 3D, discovery flash, 3D reduction

A batch of features/fixes, each with its own plan file. **Process directive (the user's):
every step is done in collaboration with the council** — these plans are council-debated before
sign-off, and the execution goal consults the council (`brainstorm`/`review_plan`/`review_diff`)
at each step.

## Workstreams (suggested order — dependencies noted)
1. **[01] 3D input + fixes** — color, expand-ι, mouse (left-pan / right-orbit + camera pan),
   then finish gamepad-3D + touch. *Do first: it informs the gamepad/touch scheme.*
2. **[03] Drop fluff** — remove the fluff system; zoo tones default-on. *Cleanup; unblocks 04/05.*
3. **[07] Haskell examples** — add `2 < 3` and `quicksort [3,1,2]` compile examples. *Cheap; gives
   bigger trees for 02/06's wow.*
4. **[02] No default optimizations + reduction-count progress bar** — disable auto-on opts; a
   background turbo run estimates the total reduction count → a progress bar over the toolbar.
5. **[04] Zoo 2D/3D toggle** — a [2D|3D] switch on the creature picture; 3D slowly auto-rotates.
   *Depends on 01 (3D embedding) + 03 (tones default).*
6. **[05] Discovery flash** — flash a card under the tracked quest on discovery, fade out (phones too).
7. **[06] 3D reduction animation** — animate the sphere as the term reduces. *Biggest; depends on 01.*

## The goal to set (after sign-off)
A `/goal` that walks these in order, collaborating with the council at each step, verifying
headless after each, and committing per logical slice. (Presented separately once you sign off.)

## Shared component (added)
- **Mini-3D auto-rotate widget** — a small, non-interactive, slowly-rotating packed-sphere render
  of one term (separate lightweight renderer, compositing-A in a Pixi/DOM box). Built in [04]
  (Zoo 2D/3D) and reused in [05] (discovery card). Build once.

## Corrected order + cross-plan obligations (completeness review, council consensus)
**Order: [03] → [08] → [01] → [07] → [02] → [04] → [05] → [06]** — cleanup first; the control
redesign [08] before [01] so gamepad/touch-3D lands on the final router; [07] needs only [01]
(static 3D), not [06].

**Cross-plan obligations (every Three/3D slice):**
- **Renderer lifecycle**: dispose the WebGLRenderer + canvas on hide/close (today `Sphere3D.hide()`
  only sets a flag → context LEAK on repeated open/close); pause on `document.hidden`, on closed
  Zoo / dismissed card, and when `withMotion` is false.
- **Pool the mini-3D**: ONE shared lightweight `MiniSpherePreview` renderer (separate from the
  main fullscreen view) for [04] + [05] — caps live WebGL contexts at 2. Explicit contention:
  the active widget wins; if the Zoo 3D is open and a discovery card arrives, the **card takes
  priority** and the Zoo preview freezes / falls back to 2D. Acquire/release lifecycle, DPR cap.
- **Graceful no-WebGL fallback**: every 3D mini (esp. the discovery card [05]) degrades to the 2D
  `renderPicture` if Three/WebGL/lazy-import fails — discovery must never break on a no-WebGL device.
- **Headless**: everything stays verifiable under SwiftShader (the auto-rotate widgets + [06]'s
  per-frame animation included).
- **[06] perf**: the survivor-displacement spike must ALSO budget the per-frame render +
  `texture.source.update()` upload (continuous during animation, with any live minis ticking).
  Only revive the rejected zero-copy (ExternalSource) path IF that profiling shows the upload
  dominates on real/headless hardware.
