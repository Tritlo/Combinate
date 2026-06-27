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
- [ ] **Marching-ants redex** — classic Mac selection dashes crawl along the firing
      redex just before it contracts (transient `Graphics` overlay; very on-brand).
- [x] **Water drift** — `TreeView.applyDrift(t)` sways nodes around their layout
      base; one app ticker, gated by isFluff("drift")/reduced-motion/HEAVY; edges
      stay (stiff spine). Verified: animates @60fps, frozen under reduced-motion.
- [ ] **Leaf / vine nodes** — swap the leaf-node disc texture for a small **leaf**
      sprite; edges read as the **vine/spine**. Still one particle batch (just a
      different texture); the drift makes them flutter. *Stretch / bold.*
- [x] **Zoo tone button** — `sound.play(sym)` added; a ♪ button in the Zoo detail;
      `autoTone()` chirps the creature on open / select when isFluff("zooTone").
- [x] **Discovery chirp** — `discover()` plays the new bird's tone when
      isFluff("discovery"); the existing toast already stamps its name.
- [ ] **Living Zoo** — gentle drift on the Zoo's creature preview (reuse the sway).
- [ ] Per-effect FPS check; Codex review + simplify.

## 4. New Special: a progression story / quest (adapted to ι)

- [ ] Adapt the SKI quest <https://dallaylaen.github.io/ski-interpreter/quest.html>
      into a Combinate **Special** — a guided progression "story" — for **iota (ι)**
      instead of SKI. New entry in the Special menu. Codex review + simplify.

## 5. Polish & sharing

- [ ] **Phone menu scrolling** — on a phone, tapping the ι (collapsed menu) opens a
      dropdown that runs **off-screen**; it needs to scroll / clamp to the viewport.
- [ ] **GitHub link in About** — the repo is now public; add a link to it.
- [ ] **Favicon** — an ι favicon.
- [ ] **OpenGraph / link-sharing** — favicon + OG/Twitter meta (title, description,
      image) so shared links unfurl nicely.

---

## Shipped (recent batch — Codex-reviewed, pushed)

- Apple six-colour-logo Colour palette; per-combinator dot colours (pinned +
  hashed, glyph auto-contrasts); white light bg.
- Dark mode toggle moved to View; FPS counter (View ▸ FPS, bottom-left).
- Zoom-out floor 0.2 → 0.04. Factorial perf: jump-cut + solid edges above HEAVY=600.
- Dashed argument edges (tree + legend + snap-preview); legend back on the left.
- Auto-pause on non-termination; Golf list scrolls; hotbar law tooltips.
