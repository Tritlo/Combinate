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
