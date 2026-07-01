# iota-render — an interactive iota combinator sandbox

> **Status: HISTORICAL.** The original build spec (phases 0-3). MicroHs-via-WASM (§11) is no
> longer a later phase — it's a submodule now, and live in-browser compile shipped in v8
> (ADR 0007). Kept for the ι-cycle/sandbox semantics it still documents; not maintained
> against later features.

A drag-and-drop game for building, reducing, and **discovering** combinators out of a
single primitive: **ι (iota)**. You start with nothing but ι in a Minecraft-style
hotbar, drag copies onto a canvas, snap them together into application trees, reduce
them, and each time a tree's *behaviour* matches a known combinator you **discover a new
law** ("`I x = x` discovered!") and it joins your hotbar as a new building block.

This document lives in the **Combinate** repo and is the build spec for it (a new,
standalone TypeScript + [Pixi.js] app), independent of MicroHs. MicroHs-via-WASM is a
*later* phase (see §11); the canonical data format is chosen so that hook stays cheap. It
is self-contained — you should not need the MicroHs `iota/` toolchain to build this, though
it is the reference implementation for the semantics and the rendering, and is cited
throughout.

> **Path convention.** MicroHs is checked out as a **sibling repo at `../MicroHs/`** (it is
> *not* part of this workspace). All `../MicroHs/iota/…` references below — `Check.hs`,
> `Reduce.hs`, `Morph.hs`, `treedraw.py`, the `check`/`morph` binaries — point there. Treat
> them as a reference/oracle to read and diff against, not as a build dependency.

[Pixi.js]: https://pixijs.com

---

## 1. The core loop

```
drag ι from hotbar ──► canvas        (spawn a building block)
   drag a tree near another tree ──► snap into one application tree
   tap a reducible tree ──► it reduces (animated), step by step
   tree reaches normal form ──► probe its behaviour
       behaviour matches a known law ──► "NAME discovered!"  +  new hotbar slot
   new block unlocks bigger builds ──► more laws ──► …
```

It's alchemy for combinatory logic. The whole tech tree bootstraps from ι: the
first thing you can build, `ι ι`, *is* the identity combinator `I` — and just by stacking
more ι on top you walk the entire **ι-cycle** (I → A → K → S → X → I, §4). Once you have
`K` and `S` you can build *anything* (they're Turing-complete), so the sandbox is open-ended.


---

## 2. Background: the iota combinator (self-contained)

Combinatory logic computes by **rewriting a tree** — no variables, no environments. The
classic basis is **S** and **K**:

```
K x y     = x
S x y z   = x z (y z)
I x       = x            (I is derivable: I = S K K)
```

Chris Barker's **Iota** language shows a *single* combinator suffices. Define

```
ι = λx. x S K
```

Then everything is built from ι and **application** alone. The famous derivations:

```
ι ι            = I
ι (ι (ι ι))    = K
ι (ι (ι (ι ι)))= S
```

So **every program is a binary tree whose only leaf is ι and whose only internal node is
application.** That tree is the entire object of this game.

### 2.1 Reduction rules

Reduction is **normal-order** (leftmost-outermost). ι unfolds to its definition; the S/K/I
that ι produces then fire by their own rules. This is exactly the reducer in
`../MicroHs/iota/Check.hs`:

```
ι x        → x S K          -- the only rule the player starts with
S x y z    → x z (y z)
K x y      → x
I x        → x
```

Note that **S and K only ever appear transiently**, produced by reducing ι. The player
never places an S or K directly — they emerge when ι unfolds. This is the central
"reveal" of the game: *ι is secretly `λx. x S K`*, and you watch that secret unfold every
time you reduce.

> Worked example — why `ι ι` is the identity:
> ```
> ι ι                       (apply ι to ι:  ι x → x S K,  x = ι)
>   → ι S K                 (now reduce ι S:  → S S K)
>   → S S K K               (S a b c → a c (b c),  a=S b=K c=K)
>   → S K (K K)             ← normal form
> ```
> `S K (K K)` is *not literally* the symbol `I`, but feed it an argument and
> `S K (K K) a → K a (K K a) → a`. It **behaves** as `I`. Discovery is behavioural, not
> syntactic (§7).

---

## 3. The iota tree: data model & serialization

### 3.1 Node model

A term is a binary tree. Internal nodes are application (`app`); leaves are ι. During
reduction, transient combinator leaves (`S`/`K`/`I`, and later `B`/`C`/… if you enable
named-combinator mode, §6.4) can appear.

```ts
type NodeId = number;            // stable across reduction steps — drives animation & dnd

type Node =
  | { id: NodeId; kind: "iota" }                       // ι leaf  (the only block you start with)
  | { id: NodeId; kind: "comb"; sym: "S"|"K"|"I"|… }   // a named combinator leaf (transient / optional)
  | { id: NodeId; kind: "app"; fn: Node; arg: Node };  // application:  (fn arg)
```

`fn` is the **left** child (the function); `arg` is the **right** child (the argument).
Reading order is `fn arg`, i.e. `f x`.

Keep the model **pure and immutable** (functional core, §9). Reduction returns a *new*
tree; ids are preserved for nodes that survive a step so the view can tween them (§6.3).

### 3.2 Bit-code — the canonical serialization

Barker's prefix bit-code is the interchange format (round-trips with the MicroHs toolchain
— important for the WASM phase, §11):

```
term ::= "1"               -- ι leaf
       | "0" term term     -- application:  0 <fn> <arg>
```

`1` = ι, `0` = application. (The MicroHs `encodeIota`/`parse` use this convention; one
film flipped it to `0 = ι` for presentation — we use **`1 = ι`, `0 = app`**.)

Reference codes (each ι-cycle member just prepends `01` — one more ι on top):

| term            | tree                | bit-code        |
|-----------------|---------------------|-----------------|
| ι               | `ι`                 | `1`             |
| I  = ι ι        | `(ι ι)`             | `011`           |
| A  = ι I        | `(ι (ι ι))`         | `01011`         |
| K  = ι A        | `(ι (ι (ι ι)))`     | `0101011`       |
| S  = ι K        | `(ι (ι (ι (ι ι))))` | `010101011`     |
| X  = ι S        | …                   | `01010101011`   |

A second human-readable form is the **s-expression**: `1` for ι, `(L R)` for application
(e.g. `I` = `(1 1)`). Useful for debugging/tests. Both parsers are ~10 lines (see
`parse_iota` / `parse_sexp` in `../MicroHs/iota/treedraw.py`).

---

## 4. The ι-cycle — the built-in tech tree

Because `ι M = M S K`, applying ι to each result in turn walks a **period-5 cycle**:

```
ι:   I  →  A  →  K  →  S  →  X  →  I
```

| step    | result | rule (law text)        | canonical ι-form    | #ι |
|---------|--------|------------------------|---------------------|----|
| `ι ι`   | **I**  | `I x = x`              | `ι ι`               | 2  |
| `ι I`   | **A**  | `A x y = y`            | `ι (ι ι)`           | 3  |
| `ι A`   | **K**  | `K x y = x`            | `ι (ι (ι ι))`       | 4  |
| `ι K`   | **S**  | `S x y z = x z (y z)`  | `ι (ι (ι (ι ι)))`   | 5  |
| `ι S`   | **X**  | `X x y = x y x`        | `ι (ι (ι (ι (ι ι))))` | 6 |
| `ι X`   | **I**  | (cycle closes)         | …                   |    |

This is the spine of early progression: **stack ι on top and reduce** to unlock I, then A,
K, S, X with no other ingredients. `A` (≡ `K I`, "return second") and `X` (`S S K`, a
duplicator) are the quirky two; `I`, `K`, `S` are the famous ones. Curate which count as
headline "laws" vs. a special **ι-cycle** achievement set (§7.2).

Past the cycle, with `S` and `K` unlocked you can build the rest of the zoo: `B x y z =
x (y z)`, `C x y z = x z y`, `W x y = x y y`, `T = K`-ish booleans, Church numerals, pairs,
etc. — open-ended (§7.2, §11.2).

---

## 5. Rendering the tree (Pixi.js)

The reference look is `../MicroHs/iota/treedraw.py`'s **tidy top-down** layout. Adopt its math; upgrade
its visuals.

### 5.1 Layout

Tidy top-down, root at the top, children below. Two passes (this is `annotate()` in
`treedraw.py`):

```
post-order:
  leaf:  x = next in-order leaf index (0,1,2,…);  depth = d
  app:   recurse left, right;  x = ½(x_left + x_right);  depth = d
pixel:   px = PAD + x·XS + XS/2          (XS ≈ 56)
         py = PAD + TOP + depth·YS       (YS ≈ 64)
```

This places leaves on a regular horizontal grid and hangs each application node at the
midpoint of its two children. It's cheap and stable. *Limitation:* sequential leaf indices
don't reserve space between disjoint subtrees, so very deep asymmetric trees can crowd.
Fine for hand-built game trees; if it bites, swap in a proper **Reingold–Tilford** pass
(reserve subtree widths, shift to avoid overlap). Keep layout in the functional core so
it's swappable.

```
            (app)                 ← root application node (small junction dot)
           /     \
        (app)     ι               depth grows downward
        /   \
       ι     ι                    ← ι leaves on the in-order grid
       this is  S = (((ι ι) … ))  drawn as a binary tree
```

### 5.2 Visual language

Borrow `treedraw.py`'s leaf styling, polished for a game (dark canvas, soft glow):

| element            | look                                                                 |
|--------------------|----------------------------------------------------------------------|
| **ι leaf**         | small filled disc with a faint `ι` glyph + soft glow. (treedraw: r≈5 dark dot) |
| **application**    | a small junction dot (r≈6) where the two child edges meet            |
| **edge**           | thin line parent→child; optional slight curve for polish             |
| **S/K/I leaf** (transient) | labelled coloured circle (r≈15) — distinct from ι, so unfolding *reads* |
| **redex** (reducible app) | gentle pulse / glow ring to signal "tap me" (§6.2)           |

Colours (from `treedraw.py`, tunable): canvas `#0b0f17`, ι `#ffe08a`/dark dot, structural
combinator `#3b78e8`. Use a mono font with the glyphs `ι λ → ≤` (DejaVu Sans Mono works).

### 5.3 Pixi scene graph

Target **Pixi v8** (verify the current major at build time; the v8 API is assumed below).

```
app.stage
 ├─ world: Container            ← pannable/zoomable camera (set world.position / world.scale)
 │   ├─ Tree A: Container        ← one connected tree = one draggable unit
 │   │    ├─ edges: Graphics      (redrawn on layout change)
 │   │    └─ nodes: Container     (one display object per node, keyed by NodeId)
 │   ├─ Tree B: Container
 │   └─ ghostLayer: Container    ← snap preview (§6.1)
 └─ hud: Container               ← hotbar + toasts + notebook, screen-space (not in world)
```

- One **`Container` per connected tree**, positioned by its root anchor (top-centre). Drag
  the container, not individual nodes (MVP).
- One display object per node, stored in a `Map<NodeId, DisplayObject>`. On relayout, tween
  each node from its old to new local position (`id` stability makes this a lookup, not a
  diff). Reuse objects across reduction steps where ids persist (§6.3).
- Interaction: `eventMode = "static"` on draggable containers; use federated pointer events
  (`pointerdown` on the tree, `globalpointermove` + `pointerup` on the stage). Hit area =
  the tree's bounds (pad a little so thin trees are grabbable).
- Edges: a single `Graphics` per tree, cleared and redrawn (`moveTo`/`lineTo`/`stroke`) when
  layout changes — cheaper than one Graphics per edge for these sizes.

---

## 6. Interaction

### 6.1 Spawn & drag

- **Spawn:** drag a token *out of a hotbar slot* (§7). On drop in the world, instantiate
  that token's ι-tree (ι → a single leaf; I → `ι ι`; etc., §7.3) as a fresh tree Container
  at the cursor. (Per the design: **no click-to-spawn** — you always start by dragging from
  the bar.)
- **Move:** drag any tree by grabbing it anywhere; it moves as a rigid unit.

### 6.2 Snap = application

Two trees snap into one **application** tree. Snapping *is* the only constructor.

```
   while dragging tree D, find nearest other tree T within SNAP_R (bbox/anchor distance)
   orientation by horizontal order of the two roots at the drop point:
        D left of T   →  new = app(D, T)       (D is the function)
        D right of T  →  new = app(T, D)        (T is the function)
   while hovering in range: show a GHOST of the new app node + its two edges (ghostLayer)
   on release in range: commit → build app node (fresh id) → relayout merged tree (tween)
```

`SNAP_R` ≈ one grid cell (`XS`). The new app node is placed above and between the two
subtrees; a short tween slides both roots under it. Show the ghost so the player sees the
structure *before* committing, and which tree becomes the function.

**Expressiveness note (why MVP needs no "detach"):** pairwise left/right snapping is already
complete. Left-leaning spines fall out of repeatedly snapping new args onto the right:
`f` + `x` → `(f x)`, then `+ y` → `((f x) y)`. And right-nested trees come from **build
order**: build `(x y)` as its own tree, build `f` alone, then drop `f` onto the **left** of
`(x y)` → `(f (x y))`. So any tree is reachable by choosing order + side. *Detach a subtree*
(drag a node out of its parent) is a nice convenience but a **stretch** feature, not needed
for completeness.

### 6.3 Reduction animation (the "morph")

A reduction step rewrites a redex. To keep it legible, classify each node in the result by
where it came from (this is precisely what `../MicroHs/iota/Morph.hs` does with stable ids; we
re-derive provenance from the rule):

| provenance | when                                  | animation                        |
|------------|---------------------------------------|----------------------------------|
| **persist**| same subtree before & after (same id) | glide to its new position        |
| **copy**   | `S x y z → x z (y z)` duplicates `z`  | the copy grows out of the source |
| **drop**   | `K x y → x` discards `y` (also `A`)   | discarded subtree fades & drifts off |
| **new**    | `ι x → x S K` introduces fresh S, K   | S and K grow from the ι's spot   |

Implement: give every node a stable `id` at creation; a step preserves ids for persisting
subtrees, mints new ids for `new` nodes, and records `copy(src→dst)`/`drop(id)` so the view
can animate. Tween durations can scale with how big the morph is.

### 6.4 Triggering reduction — auto-play first

The early game should feel like fireworks, so reduction is **automatic by default**:

- **Auto-reduce on idle.** When you snap a tree and let go, after a short beat (~400 ms) it
  auto-plays to normal form (the §6.3 morph animation) and runs the discovery probe. No
  instruction, no clicking — snap and watch it resolve. The whole ι-cycle (I, A, K, S, X) is
  then a cascade of one-snap unlocks (§8.3).
- **Touching a tree cancels its pending/running auto-reduce** and freezes it. That one rule
  preserves building: to assemble a bigger tree you just keep manipulating it (grab it, drag
  the next block on) and it won't reduce out from under you — it only resolves once you leave
  it alone. A **pin** toggle locks a tree so it never auto-reduces (for deliberate big builds).
- **Manual control is always there** for players who want to learn the steps: redexes show the
  **reducible glow** (§5.2; in pure-ι, any app whose left-spine head is ι-with-an-arg is a
  redex; transient saturated `S`/`K`/`I` mid-reduction). **Tap** = one leftmost-outermost step;
  **run/spacebar** = play to normal form; **pause** = stop. Past the cycle, as builds get
  bigger, players naturally lean on these.
- **Non-termination guard:** cap auto-run at ~10⁴ steps (terms can diverge, e.g. `Ω`); on the
  cap, stop and flag "still reducing…". Single-step is always safe.

**Two reduction modes** (a toggle; default = pure):

- **Pure ι** (canonical, matches `Check.hs`): only the `ι x → x S K` + S/K/I rules. True to
  Barker; shows the unfolding; more steps.
- **Named** (matches `../MicroHs/iota/Reduce.hs`): discovered combinators placed from the hotbar can be
  kept as labelled leaves that fire by their own rule (`B x y z → x (y z)`, …) for far fewer
  steps on big builds. Offer an **"unfold to ι"** action to expand a named leaf back into its
  ι-gadget. Recommendation: ship **pure** first (it's the point); add named mode later.

---

## 7. Discovery & progression

### 7.1 Behavioural probe

Discovery is **behavioural**, not syntactic (recall `ι ι` normalises to `S K (K K)`, not the
glyph `I`). This is exactly what `../MicroHs/iota/check` does: *apply the term to fresh free variables
and reduce.*

```
to test whether tree T realises a law L of arity n:
    apply T to n fresh distinct free vars  a, b, c, …   (free var = irreducible opaque leaf)
    normal-order reduce (step cap)
    compare the normal form to L's reference output on the same vars
        I:  T a       ≡ a
        K:  T a b     ≡ a
        S:  T a b c   ≡ a c (b c)
        B:  T a b c   ≡ a (b c)
        …
```

Run the probe **when a tree reaches normal form** (after tap/run). For each not-yet-unlocked
law in the catalog, probe at its arity; first match wins → discover it. (Trees that don't
reduce to a clean combinator just sit there — no penalty; the sandbox is about exploration.)

Implementation: the free variable is a fourth `Node` kind (`{kind:"free"; name}`) that has no
reduction rule, so it's inert under reduction — the normal form is then a tree over free
vars + transient combinators, which you compare structurally against the reference.

### 7.2 The law catalog

A data-driven list (configurable). Each entry: `sym`, display **law text** (reused verbatim
in the toast and notebook), `arity`, `reference` output, and a **canonical ι-tree** to stamp
(§7.3). Seed it with:

| tier         | laws                                              |
|--------------|---------------------------------------------------|
| **ι-cycle**  | I, A, K, S, X  (unlock by stacking ι, §4)         |
| **basis**    | (I, K, S already covered) — the headline trio     |
| **zoo**      | B, C, W, T (= `K`), M/ω (`W I`), …                |
| **stretch**  | Church numerals 0/1/2…, booleans, `pair`/`fst`/`snd` |

Law text comes straight from `ruleDesc` in `../MicroHs/iota/Reduce.hs` (`S x y z -> x z (y z)`, etc.).

### 7.3 What a hotbar token stamps

Each discovered law owns a **canonical ι-tree** that dragging its slot stamps onto the canvas
(the player explicitly wanted "drag an I → it appears as an iota tree"):

- **ι-cycle members:** the compact nested form from the §4 table (I = `ι ι`, K = `ι(ι(ιι))`,
  S = `ι(ι(ι(ιι)))`, …). Small and recognizable.
- **Other combinators:** the S/K/I→ι expansion of a known SK definition (e.g. `B = S (K S) K`),
  via the `skToIota` gadget (`I→011, K→0101011, S→010101011`, app = `0`). These get bushy —
  which is the honest cost of ι, and motivates the optional **golf** mechanic below.
- **Golf (stretch):** record the *smallest* ι-tree the player has built for each law; if they
  beat the canonical size, update the stamp and celebrate. Turns the sandbox into a puzzle.

### 7.4 Toast + hotbar unlock

On discovery: a top-of-screen toast — **"`I x = x` — discovered!"** — and a new slot animates
into the hotbar (Minecraft-style). Persist unlocked laws (localStorage) so progress sticks.
A **notebook / lab panel** lists every discovered law with its text, ι-tree thumbnail, and
bit-code — the player's growing reference card.

---

## 8. Game shell & UI

### 8.1 Hotbar

Minecraft-style row of slots, bottom-centre, in screen space (`hud`, not `world`):

- Slot 0 = **ι**, always present. Discovered laws fill slots left→right.
- Each slot: the glyph (`ι`, `I`, `K`, …) + a faint ι-tree thumbnail. Drag *out* of a slot to
  spawn (§6.1). Number keys 1–9 select; hover shows the law text.

### 8.2 Notebook

A toggle panel (the discovered-laws list, §7.4). Doubles as the win-condition surface: "12
laws discovered", optional achievement set for the ι-cycle / the SK basis / the zoo.

### 8.4 Juice (where the "wow" comes from)

The mechanic is simple, so *feel* carries the first impression — lean into it early:

- **The reveal:** ι visibly unfolding into distinct labelled `S` and `K` nodes is the core
  "aha". Make that morph (§6.3) smooth, and slow it down the *first* time so it lands.
- **Discovery payoff:** toast + slot-pop + a short particle burst + an ascending chime; the law
  text writes on. Chain them so the ι-cycle reads as a combo.
- **Snap:** a soft magnet pull as trees near, then a click on lock; the ghost preview (§6.2)
  makes it feel deliberate, not accidental.
- **Idle ι leaves** breathe (subtle pulse) so the blank canvas isn't dead.
- Optional: the per-combinator note soundtrack from the MicroHs films (each combinator a pitch)
  — reductions become little melodies.

### 8.3 First-run script (also the Phase 0–1 acceptance test)

```
1. Canvas is blank. Hotbar shows one slot: ι. Tooltip: "drag ι onto the canvas".
2. Player drags ι out → an ι leaf appears.
3. Player drags a second ι out → two ι leaves.
4. Player drags one onto the other → they SNAP into (ι ι); the player lets go.
5. After a ~400 ms beat it **auto-reduces** (animated) to S K (K K), normal form — no clicking.
6. Probe: (ι ι) a ≡ a → it's I. Juicy toast "I x = x — discovered!", and an I slot pops into
   the hotbar. A hint arrow nudges: "drop ι on your new block".
7. Player drops ι on I → (ι (ι ι)) → auto-reduces → A discovered → then K → S → X: a ~30 s
   cascade of one-snap unlocks straight up the ι-cycle. The hint arrow retires once S and K
   are in hand and real building begins.
```

---

## 9. Architecture & stack

**New repo.** Per the house style: **functional core, imperative shell.**

- **Stack:** Vite + **TypeScript (strict)** + **Pixi.js v8**. No backend, no framework needed
  (vanilla + Pixi). State in a small store; persist unlocks to localStorage.
- **Functional core** (pure, no Pixi, fully unit-testable):
  - `term.ts` — `Node` model, ids, parse/serialize bit-code + s-expr.
  - `reduce.ts` — one-step + run-to-normal-form + provenance (port of `Check.hs` / `Morph.hs`).
  - `layout.ts` — tidy top-down layout → positions (port of `treedraw.annotate`).
  - `probe.ts` — behavioural discovery against the catalog (port of `check`).
  - `catalog.ts` — the law table (§7.2), data only.
- **Imperative shell** (Pixi):
  - `view/tree.ts` — render a `Node` + positions into a Container; tween on relayout.
  - `view/drag.ts` — drag, snap detection, ghost preview, commit.
  - `view/hotbar.ts`, `view/toast.ts`, `view/notebook.ts`.
  - `app.ts` — wire store ↔ view, camera (pan/zoom), input.

Keep the core free of Pixi types so it can later run under WASM/MicroHs without touching the
view. Test the core directly against the MicroHs binaries as oracles: any bit-code your
`reduce.ts` produces should agree with `../MicroHs/iota/check`, and your discoveries should match
applying `check <code> a b c`.

---

## 10. Build plan (milestones)

| phase | deliverable                                                                 |
|-------|-----------------------------------------------------------------------------|
| **0** | Canvas + camera. Drag ι from a one-slot hotbar. Snap two trees into `app`. Tidy layout. Tap to single-step reduce `ι ι` → normal form. *(No discovery yet.)* |
| **1** | Behavioural probe + catalog + toast + hotbar unlock. The §8.3 first-run script works end to end through the ι-cycle (I, A, K, S, X). |
| **2** | Morph animation (persist/copy/drop/new), run-to-normal-form, redex glow, non-termination cap. |
| **3** | Notebook, the SK-zoo laws (B, C, W, …), localStorage persistence, polish. |
| **stretch** | Subtree detach; golf (smallest-ι records); named-combinator fast mode; Church numerals/booleans/pairs; import a MicroHs-compiled program as an ι-tree (§11). |

Phase 0 + 1 is the playable nugget the user described; ship that first.

---

## 11. Later: MicroHs / WASM

Deliberately **out of scope for v1** — but the design keeps the door open:

1. **Interchange is the bit-code.** `term = 1 | 0 term term` round-trips with the MicroHs
   `../MicroHs/iota/` tools, so anything compiled there can be loaded here and vice-versa with no glue.
2. **Reference oracle now.** While building the JS core, diff it against `../MicroHs/iota/check` (probe)
   and `../MicroHs/iota/morph` (step trace) — they already implement these exact semantics.
3. **WASM reducer later.** For large trees, compile the MicroHs reducer (or the relevant core)
   to WASM and call it from the shell instead of `reduce.ts`. The `Node`↔bit-code boundary is
   the only contract.
4. **Import real programs (stretch).** MicroHs Scott-encodes data into combinators
   (`3 = J(J(J K))`, `[3,1,2] = O 3 (O 1 (O 2 K))`), so a compiled program *is* an ι-tree.
   "Drop a quicksort onto the canvas and watch it run" becomes a natural late-game mode — and
   ties back into the existing explainer-film work.

---

## 12. Open decisions (recommendations in **bold**)

- **Reduce on snap, or only on tap?** → **Auto-reduce on idle** for immediate wow, **cancelled
  on touch** + a **pin** so building still works; manual tap/step always available (§6.4). *(decided)*
- **Stamp ι-trees, or named leaves?** → **ι-trees** for v1 (the player asked to *see* the
  trees grow); add named-leaf fast mode + "unfold to ι" later.
- **Snap orientation rule?** → **horizontal left/right of the two roots** decides fn/arg, with
  a ghost preview; revisit if testers find it unintuitive (alt: dragged tree is always the arg).
- **Which laws are "headline" vs. quiet?** → headline **I, K, S**; group **A, X** under an
  "ι-cycle" achievement; **B, C, W, …** as the zoo. Catalog is data — easy to retune.
- **Pixi major version?** → spec assumes **v8**; confirm the current major when scaffolding.
```
