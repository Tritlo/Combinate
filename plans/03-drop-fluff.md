# [03] Drop the fluff system; zoo tones default-on

## Findings
- `fluff.ts`: `FluffKey = redexAnts | drift | leaves | zooTone | discovery | livingZoo`, a
  FluffPanel (View ▸ Fluff…) + `isFluff()` gates. Used in fluff.ts, zoo.ts, tree.ts, app.ts.

## Plan
- **Remove the fluff system**: delete `fluff.ts` (the FluffPanel + store), the View ▸ Fluff menu
  item, and the `isFluff(...)` gates. Drop the now-dead effect code:
  - `redexAnts` (the reduction flourish ring), `drift` (water-sway), `leaves` (leaf node sprites),
    `livingZoo` (floating zoo picture) → **remove** the code paths in tree.ts / zoo.ts / app.ts.
- **Zoo tones default-on**: the `zooTone` effect (Pokédex chirp on opening a creature) becomes a
  plain default in the catalog/zoo — always plays, no toggle.
- **`discovery`** (chirp on discovering a combinator): fold into [05] discovery flash (play the
  tone as part of the flash) or keep as a plain default. Decide with [05].
- **Keep** `prefersReducedMotion()` — it's a real accessibility check (not fluff), still gates
  the grab/spawn pop + any remaining motion.
- Update ADR (Fluff ADR superseded/removed).

## Council questions
- Remove drift/leaves entirely, or keep one as a cheap always-on aesthetic? (User said "remove
  the rest" → lean remove-all-but-tones.)
- Reduced-motion: what stays gated by it after fluff is gone.

## Council verdict (consensus)
- Clean, mostly net-negative deletion: remove `fluff.ts` (panel + store + menu + `onFluffChange`),
  and the four effect paths — redexAnts (`reduceFlourish` + the flourish Graphics), drift
  (ticker + `applyDrift`/`clearDrift`), leaves (leaf texture + vines), livingZoo (zoo float).
- **Extract `prefersReducedMotion()`** to a tiny util (it gates popIn at several call sites + is
  real a11y, not fluff) — don't delete it with fluff.
- **zooTone → unconditional default** (keep the audio-unlock / autoplay-safe path). Move the
  discovery chirp out of `discover()` into the [05] flash site.
- Watch: scattered `isFluff()` call sites (tree.ts, zoo.ts, app.ts), the `prevLeaves` hack, any
  E2E that pokes the Fluff menu. Update/retire the Fluff ADR.

## User refinement
- Reframe the negative `prefersReducedMotion()` to a positive `withMotion()` / `motionOk()`
  (it currently reads backwards) while keeping the underlying `prefers-reduced-motion` media
  query. Get rid of the motion + leaves (drift/sway/leaf sprites). **Clean up thoroughly
  afterwards** — no orphaned constants, textures, ticker hooks, CSS, or dead branches.
