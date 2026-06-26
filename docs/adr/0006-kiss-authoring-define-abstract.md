# 6. KISS authoring: Define, then one-hole Abstract (v7)

**Status:** proposed (draft — to be finalised by a grill-with-docs pass)

## Context

Today you only acquire combinators by *discovering* them (a tree's behaviour
matches a catalog law). There is no way to **author** your own — to name a tree
you built, or to abstract a variable out of it — which is the route to building
`map` / `filter` / `qsort` yourself. `spec/upper-techtree.md` already designs this
(and that spec went stale after the Scott switch, so this work updates it). The
risk is that authoring balloons into a modal lambda editor, which would break the
KISS, no-DOM-in-core shape.

## Decision

Two verbs, both reusing the existing core, no modal editor:

1. **`Define`** (ship first). Select a settled subtree → "name it" → it collapses
   to a fresh hotbar block. This is the *same object as discovery* — a labelled
   leaf backed by a tree — so it reuses `collapsedNode` / `discover` /
   `hotbar.reveal`. The symbol table is presentation-only.
2. **one-hole `Abstract`** (ship second). Drag a leaf out and mark it a *hole* (a
   free-variable placeholder); bracket-abstract the tree over that one hole (reuse
   `bracket` / `lam` in `catalog.ts`). **One hole only** — no multi-hole system
   until the one-hole verb feels good.

## Why

Turns the sandbox from "discover by accident" into a learning *authoring* game,
reusing the existing collapse/discover/bracket machinery. `Define` is low-risk
(same object as discovery); the one-hole `Abstract` is the minimal shape of the
genuinely-powerful verb without an editor.

## Consequences

- A user-defined combinator needs to persist (localStorage and/or the permalink
  from ADR 0005) and survive across sessions.
- Naming may collide with catalog symbols — needs a rule (namespace, or reject).
- `spec/upper-techtree.md` is updated to the Scott world as part of this.

## Open questions (for the grill)

- The gesture for marking a hole (drag-out? long-press? a dedicated mode?).
- Multi-hole later, or is one hole + composition enough forever?
- Where user-defined combinators live (localStorage vs in the share link) and how
  they appear in the Zoo.
- Collision policy with catalog names.
