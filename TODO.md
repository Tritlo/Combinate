# TODO

Overnight run. Work top-down. Collaborate with Codex on each step (plan before,
review+simplify after). Use `/frontend-design:frontend-design` where it fits.
**Push each piece as soon as it's verified** (the user authorised pushing freely).

## 1. Transport redesign — ✅ DONE (pushed)

- [x] Pause ‖ · Step |▷ · Play ▷ · Fast-forward ▷▷ as side-by-side glyphs.
- [x] Active mode boxed in gold; Step is an action (never "active").
- [x] Step pauses + advances the focused tree one reduction (shares the auto
      loop's normal-form handling; ensureAuto for unscheduled focused trees).
- [x] Live red/s readout kept; Reduce-menu radios + a Step item sync.
- [x] Codex-reviewed (finishNormalForm, ensureAuto, setFastMode invalidation).

## 2. Design pass on "fluff" — ✅ DONE (Codex brainstorm + frontend-design)

Decisions captured in §3. Headlines:
- [x] **Render architecture** decided (below). Ambient motion stays CPU + cheap
      because fluff is **gated off above HEAVY=600** — only small trees drift, so
      no custom shader needed. Reject whole-tree filters (break batches, distort
      glyphs) and an edge-mesh rewrite (too much code) for v1.
- [x] **Signature / one bold move**: leaves on a vine, drifting underwater — leaf
      nodes flutter around a **stiff spine** (the edges don't move). Realizes both
      "water drift" and "leaf/vine" with one cheap effect.
- [x] Extra fun ideas folded in (marching-ants redex, discovery stamp + chirp).
- [x] `sound.ts` `pitchFor` is private → export it (or add `Sound.play(sym)`) for
      the Zoo tones, separate from the reduction `tick`.
- [x] Gotcha: Pixi `ParticleContainer` has no `scale` dynamic prop (it's carried
      by vertex data); animate node size via vertex/baseScale, not a scale flag.

## 3. "Fluff" — a `View ▸ Fluff…` settings modal, ON by default

A System-1 window (like Zoo / About), **paper/ink + IoskeleyMono**, with classic
**Mac square checkboxes**: a **master on/off** at top, then one checkbox + a
one-line plain-language description per effect, then a Done button. Persist to
localStorage; on by default. All-off (or master off) = the current crisp view.
Build the **modal first**, wire each effect to a `fluff` settings object, then add
effects one at a time. Design with `/frontend-design` as you build.

**Global gates (every effect):** master + its own toggle, `prefers-reduced-motion`,
and **`tree.heavy()` / HEAVY** (no ambient fluff on big trees). Never break the FPS
counter or the auto-pause guard; sanity-check each effect with the FPS counter.

**Render architecture:**
- *Ambient* (continuous): **CPU node-only sway** around each node's stored **base**
  (layout) position — `particle.x = base.x + amp·sin(k·base + t)`, tiny amplitude
  (~3px). **Don't redraw edges** → stiff spine, fluttering leaves. Runs only on
  settled trees below HEAVY (a light ticker; hand off cleanly to the tween/layout,
  which own positions during animation).
- *Transient* (one-shot): the existing `tween` helper + a **transient `Graphics`
  overlay above the tree** that draws a ring/dashes/pulse and dies after ~200–350ms.
  No change to the particle batch.

Effects to toggle:

- [x] **Modal + settings** (`fluff` object, localStorage, master, Mac checkboxes).
      `src/view/fluff.ts`: `isFluff(key)`, `fluffOn()`, `onFluffChange`,
      `prefersReducedMotion()`; `View ▸ Fluff…`. Verified both themes + persistence.
- [x] **Grab / spawn pop** — `TreeView.popIn()` scales the new tree in on spawn
      (gated by isFluff("grabPop") + reduced-motion).
- [x] **Marching ants** — a gold dashed ring crawls + fades at the reduction site
      on each step (`reduceFlourish`); skipped on fast-forward / heavy / reduced
      motion. (Anchored at the tree root, where leftmost-outermost fires; exact
      per-redex localisation would need reducer support — a later refinement.)
- [x] **Water drift** — `TreeView.applyDrift(t)` sways nodes around their layout
      base; one app ticker, gated by isFluff("drift")/reduced-motion/HEAVY; edges
      stay (stiff spine). Verified: animates @60fps, frozen under reduced-motion.
- [x] **Leaf / vine nodes** — leaf + circle packed in ONE texture atlas (so the
      ParticleContainer still batches); leaf nodes use the leaf frame (tinted by
      the combinator colour), app junctions stay dots, edges read as the vine.
      Toggling it refreshes the trees. Verified (S=green, K=purple… leaves).
- [x] **Zoo tone button** — `sound.play(sym)` added; a ♪ button in the Zoo detail;
      `autoTone()` chirps the creature on open / select when isFluff("zooTone").
- [x] **Discovery chirp** — `discover()` plays the new bird's tone when
      isFluff("discovery"); the existing toast already stamps its name.
- [x] **Living Zoo** — `Zoo.tickFluff(t)` gently floats the open creature's picture
      (driven by the shell ticker, gated by isFluff("livingZoo") + reduced-motion).
- [x] Codex review + simplify of the whole fluff layer — fixed: discovery chirp
      now only plays if audio's already unlocked (non-gesture autoplay policy);
      ambient resets on any fluff toggle *and* on OS reduced-motion change (drift +
      living-Zoo snap back). `resume()` rejections swallowed.

## 4. New Special: a progression story / quest (adapted to ι) — ⏸ ON HOLD

- [ ] **Awaiting permission** (it adapts dallaylaen's SKI quest). When built, keep
      it on a **local branch only — do NOT push to main** until permission is
      granted. Adapt <https://dallaylaen.github.io/ski-interpreter/quest.html> into
      a Combinate **Special** (guided ι progression). Codex review + simplify.

## 5. Polish & sharing — ✅ DONE (pushed)

- [x] **Phone menu scrolling** — clamp the dropdown to `window.innerHeight` (not CSS
      100vh, which spans behind the mobile address bar) so it scrolls in place.
- [x] **GitHub link in About** — links to github.com/Tritlo/Combinate.
- [x] **Favicon** — `public/favicon.svg` (gold ι on a dark rounded square).
- [x] **OpenGraph / link-sharing** — full OG/Twitter meta + a 1200×630 `og.png`
      (gold ι, wordmark, tagline, tree motif). Verified base-aware in the build.

## 7. Bugs / follow-ups

- [x] **Edge colours reworked** — mono edges are now **grayscale** (function = ink
      solid, argument = dim dashed) — truly 1-bit beyond the brand gold ι. And in
      **Colour** mode the bold red/blue edges became **muted**: a dark brown (almost
      black) function edge + a light blue (almost grey) argument edge (warm tan /
      blue-grey on the dark canvas) — the vibrant per-combinator nodes now carry the
      colour; the edges recede. The solid/dashed style still tells fn from arg.
- [x] **Fluff defaults** — grab/spawn pop is now **always on** (gated only by
      reduced-motion); every other effect is **off by default** (storage bumped to
      v2 so old all-on state resets). Pushed.
- [x] **Phone menu can't scroll** — items fired on `pointerdown`, so a touch
      scroll-drag triggered the option; now fire on tap (pointerup with no move).

## 6. Render efficiency pass — ✅ mostly done

The big lever (HEAVY jump-cut) already landed earlier, so this pass is cleanup +
idle wins (the render path is otherwise minimal):
- [x] Fixed the `ParticleContainer` config — `scale:true` was an unknown key (no-op);
      it's now `{position:true, color:true}` (the only per-frame attrs: movement +
      alpha fades). Vertices/uvs/rotation stay static.
- [x] Cache the reduced-motion `MediaQueryList` (the drift ticker polled it every
      frame).
- [x] Idle the render/animation ticker while the tab is hidden (visibilitychange).
- [ ] *Stretch:* per-node-kind particle textures → enables the deferred **leaf
      nodes** fluff effect (one batch, leaf sprite for leaves + dot for junctions).

---

## Shipped (recent batch — Codex-reviewed, pushed)

- Apple six-colour-logo Colour palette; per-combinator dot colours (pinned +
  hashed, glyph auto-contrasts); white light bg.
- Dark mode toggle moved to View; FPS counter (View ▸ FPS, bottom-left).
- Zoom-out floor 0.2 → 0.04. Factorial perf: jump-cut + solid edges above HEAVY=600.
- Dashed argument edges (tree + legend + snap-preview); legend back on the left.
- Auto-pause on non-termination; Golf list scrolls; hotbar law tooltips.
