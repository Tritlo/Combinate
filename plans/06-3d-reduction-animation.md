# [06] 3D reduction animation — animate the sphere as the term reduces

Biggest item; depends on [01]. The huge wow.

## Findings
- `sphere3d.ts` is a STATIC snapshot — `update(node)` rebuilds the whole scene for one term.
- The 2D `TreeView.animateTo(next, dur, done)` tweens between reduction steps: persisted nodes
  (by id) glide to new positions, fresh nodes grow in, dropped nodes fade out. `layout3d` is
  computed per-term and is deterministic but NOT yet id-stable across steps.
- The `ReductionController` drives the 2D animation; the 3D view currently shows a frozen snapshot.

## Plan
- Make the 3D **morph per reduction step** (the 3D analog of `animateTo`): on each step, re-layout
  the new term, then tween node instances — nodes that persist (same id) glide from old→new 3D
  position, new nodes scale in, dropped nodes scale/fade out; edges follow.
- Drive it from the reduction loop: while in 3D + playing, step the focused term and feed each
  snapshot to sphere3d's animator (respect the speed levels; jump-cut huge steps like the 2D HEAVY
  path; honor the node cap).
- Keep a static mode (no animation) as the cheap fallback / for huge trees.

## Council questions (design-heavy)
- The tween model: id-stable instanced mesh (reorder/grow/shrink instances per step) — how to
  diff node sets between steps efficiently; or rebuild + cross-fade two scenes.
- Perf: re-layout + re-render every step at scale (instancing helps; cap + jump-cut needed).
- Integration: does the ReductionController gain a 3D-aware path, or does sphere3d subscribe to
  the focused tree's step stream? Keep the functional core (layout3d) pure.
- Interaction during animation (orbit while it reduces) + the texture-compositing cost per frame.

## Council verdict (consensus)
- Do AFTER 01. **Step 0 = a survivor-displacement SPIKE**: with the *current* layout3d, measure
  the old→new 3D position of shared node-ids across real reduction steps. The risk: layout3d's
  tilts are computed from live subtree weights, so a reduction in one branch shifts ancestor
  tilts → untouched survivors can angularly "reshuffle". If displacement is tolerable, build the
  morph on the current layout; only if it visibly reshuffles, id-SEED the layout (seed twist/tilt
  by id-path or the previous layout) — a non-trivial change to the pure cone math, so don't do it
  speculatively.
- **Morph technique**: one InstancedMesh + an id→instanceIndex map; per-step diff the node-id sets
  (persist→glide, new→scale-in from 0, dropped→scale/fade + compact), tween each instance matrix
  (dummy Object3D + setMatrixAt + needsUpdate), rebuild the edge LineSegments each step. NOT
  whole-scene cross-fade (loses the "same sphere glides" feel) — that's only the fallback.
- **Drive** from the ReductionController feeding sphere3d each snapshot (don't duplicate the
  stepper); honor speed levels; cap + jump-cut huge steps (HEAVY/turbo analog) so the per-frame
  re-render+upload doesn't dominate; keep a static fallback for big trees. Don't tween the hidden
  2D focus tree simultaneously.
