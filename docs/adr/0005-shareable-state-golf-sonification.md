# 5. Shareable permalinks, golf challenges, and sonification (v6)

**Status:** proposed (draft — to be finalised by a grill-with-docs pass)

## Context

The discovery loop is open-ended but has no *goal* and no *spread*: you discover
combinators by accident, and there is no way to share a tree, score a solution, or
hear a reduction. These are the cheapest, highest-leverage additions because they
deepen the loop and make it viral while reusing machinery we already have (the
Codex brainstorm ranked them first).

## Decision

Ship three small, composing features as one release, all shell-state over the
existing pure core, no new dependencies:

1. **Permalinks.** Export/import a tree + the active mode flags in the URL hash.
   A tree already round-trips through Barker bit-code (`encodeIota` / `decode`),
   and modes are a few booleans, so a link is `bitcode + flags`. Cap inline links;
   fall back to a downloadable `.json`/bit-code for very large trees.
2. **Golf / challenge pack.** 5–8 curated challenges ("build `I` in the fewest ι",
   "make a tree that reduces to `[1, 2, 3]`", "discover the five ι-cycle birds").
   A challenge is shell-state: id, a *target predicate* (over the value reader or a
   target bit-code), a best metric (reuse `countIotas` / step count), and a
   *solution = a permalink*. No backend; URL-local "best" is enough for now.
3. **Sonification (juice).** A tiny WebAudio layer (one oscillator, ~tone per
   combinator family) on the existing reduction tick, gated by a toggle. The
   MicroHs morph films already validate the combinator→pitch mapping.

## Why

Smallest multiplier on the board: spread (links), purpose (challenges turn
"discover by accident" into "discover on purpose"), and wow (a shared reduction
that plays a melody). All static/KISS, reuses bit-code, `countIotas`, the value
reader, and the transport tick.

## Consequences

- `step()` currently returns only the next `Node`, not which rule fired — so
  family-tones need a small rule-trace return (or a `stepWithRule`). Still small,
  not zero.
- The URL schema needs a version byte so old links keep working across releases.

## Open questions (for the grill)

- The exact challenge set + how "target" is expressed (predicate vs target NF).
- URL schema + versioning; size cap before falling back to a download.
- Sonification: head-symbol families vs the rule-trace — is by-head enough?
- How to surface "your best" without accounts (localStorage only? in the link?).
