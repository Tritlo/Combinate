# TODO

Overnight run. Work top-down. Collaborate with Codex on each step (plan before,
review+simplify after). Use `/frontend-design:frontend-design` where it fits.

## 1. Transport redesign — DO FIRST (commit + push when done)

Replace the single cycling transport icon (top-right) with a row of glyph buttons.

- [ ] **Pause** ‖ · **Step** · **Play** ▶ · **Fast-forward** ⏩ as side-by-side glyphs.
- [ ] Clear **"pressed/active" indication** on the current mode (Pause/Play/FF).
- [ ] **Step** button **between Pause and Play**: runs exactly **one reduction**
      then stays paused (glyph idea `|>`). An action, never shows "active".
- [ ] Keep the live `red/s` readout + top-right placement; Reduce-menu radios sync.
- [ ] Codex review + simplify; commit + push.

## 2. Codex + frontend-design pass on the "fluff" plan — DO SECOND

- [ ] `review_plan` with Codex; design with `/frontend-design:frontend-design`.
- [ ] Add more fun ideas; design the settings modal + effect visuals (System-1).
- [ ] Nail the **efficient render** strategy (thousands of GPU particles already;
      must not tank FPS — respect the FPS counter + HEAVY jump-cut path).
- [ ] Write the refined, concrete plan back into this file before building §3.

## 3. "Fluff" — a `View ▸ Fluff…` settings modal, ON by default

A System-1 window (like Zoo / About) with a **master on/off** + **individual
toggles** per effect, wired to a fluff-settings object. All-off = the current
crisp, fast view. Design the modal + visuals with `/frontend-design` (and Codex).

- [ ] **Build the modal first** (menu item → modal → toggles → settings object).
- [ ] Grab/spawn animation — node pops/appears when grabbed or spawned.
- [ ] Reduction flourish — "something more interesting when reducing" (TBD §2;
      e.g. a ripple/pulse along the firing redex).
- [ ] Water drift — gentle sway, as if nodes float in water.
- [ ] Leaf / vine nodes held together by the spine (edges) — fits the water-drift.
- [ ] Zoo tone button — play a combinator's `sound.ts` tone; with fluff on,
      auto-play it when you open a creature's page (Pokédex-style).
- [ ] Living Zoo — animations / drift so it feels alive.
- [ ] Perf check each effect with the FPS counter; Codex review + simplify.

## 4. New Special: a progression story / quest (adapted to ι)

- [ ] Adapt the SKI quest <https://dallaylaen.github.io/ski-interpreter/quest.html>
      into a Combinate **Special** — a guided progression "story" — for **iota (ι)**
      instead of SKI. New entry in the Special menu. Codex review + simplify.

---

## Shipped (recent batch — Codex-reviewed, pushed)

- Apple six-colour-logo Colour palette; per-combinator dot colours (pinned +
  hashed, glyph auto-contrasts); white light bg.
- Dark mode toggle moved to View; FPS counter (View ▸ FPS, bottom-left).
- Zoom-out floor 0.2 → 0.04. Factorial perf: jump-cut + solid edges above HEAVY=600.
- Dashed argument edges (tree + legend + snap-preview); legend back on the left.
- Auto-pause on non-termination; Golf list scrolls; hotbar law tooltips.
