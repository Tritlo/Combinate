# 11. Kernels — pure native primitives bound to named combinators

**Status:** Accepted (Codex consensus, TODO §5).

## Context

Native values (ADR 10) compute a fixed set of catalog Scott ops natively, gated by the
optimize toggles. They are de-facto **kernels** — a named combinator backed by a native
JS implementation — but hardcoded in `core/native.ts`. We want one extensible mechanism:
bind any named combinator to a **pure** native kernel, so we can add primitives (a Church
`cmod` to unblock the over-budget gcd; real MicroHs primitives in the Haskell panel)
without touching the reducer each time. MicroHs's FFI is the inspiration; **pure only** —
a kernel is a deterministic function of its evaluated arguments, no IO/effects.

## Decision

**One registry, one reducer hook.** `core/kernels.ts`:

```ts
type Kernel = { arity: number; enabled?: (o: NativeOpts) => boolean; run: (args: Node[]) => Node | null };
const KERNELS = new Map<string, Kernel>();   // registerKernel(sym, kernel)
```

`reduce.ts`'s existing native hook becomes a registry lookup: at a saturated `comb` head,
`kernelFor(sym, opts)` returns the kernel if its `enabled` gate passes (absent = always
on). Discovery stays cheap; the match runs in the redex's `build`, falling back to the
catalog rule (`RULES[sym]`) when the kernel returns `null` or the args aren't recognised
values — so toggling off and unrecognised inputs are always correct. Kernels **never leak
a native payload**: each emits the exact canonical `Node` tree (round-trip-safe by
construction, like native values). Native numbers/lists/booleans are **registered** as
kernels gated by their toggle — the tested `numberOp/listOp/boolOp` logic stays in
`native.ts`; this is a thin adapter, not a rewrite (Codex).

**Church helpers** move to a reducer-free `core/church.ts`: `church(k)` (the SKI numeral,
from `skiq/parse`) and `matchChurch(node, normalize, cap)` (from `skiq/engine`'s
`readChurch`). Both `skiq/engine` and Church kernels share them with no
`reduce → kernels → skiq → reduce` cycle.

**Kernel contract.** Deterministic, side-effect-free, no-throw; return `null` to fall
back; emit a canonical tree (never a native value); don't force operands the catalog rule
wouldn't; cap materialised output (e.g. `MAX_NAT`). A kernel's own value-matching runs the
reducer **with kernels disabled** (no recursive kernels), so matchers can't re-enter.

**Gating.** Pure, catalog-backed kernels whose output is extensionally identical to the
fallback are **always on** — no new user toggle (noise). The native-value toggles stay as
user-facing optimization controls (they gate their kernels).

## gcd (unblock path, may follow separately)

The gcd stage has no `allow`, so the checker permits named combinators, but the SKIQ
parser only resolves a name as a combinator if it's catalog-visible. So: register pure
**Church** kernels for the expensive primitive(s) — chiefly `cmod` (Church mod, native) —
make them resolvable, and author the gcd answer as Euclid built from them (`Y`-recursion +
`cmod` + iszero). A `gcd` kernel is rejected — it makes the stage trivial; `cmod` is the
defensible kernel-assisted route, and that answer-key entry is marked kernel-assisted.

## Notes (Codex review)

- **`cmod` is parse-global, allow-gated.** The SKIQ parser resolves any kernel name, so
  `cmod` is available to every puzzle — but it's subject to each puzzle's `allow` set
  (restricted puzzles reject it), and it's not on any canvas/hotbar, so only authored
  source reaches it. This is deliberate, small language growth, not a per-puzzle hack.
- **Kernel-only discovery is eager.** A kernel-only sym (no catalog `def`) matches in
  `redexAt` discovery rather than `build`, relaxing the cheap-discovery invariant — fine
  because such syms never appear on the canvas (`firingRule`/probes never hit them). A
  future kernel-only primitive that needs cheap discovery should ship a `def` fallback.
- **Totality + cap.** `cmod a 0 = a` (no stuck term); output capped at `MAX_CHURCH`.

## Consequences

Native values and future primitives share one path. The Haskell panel can register
primitives later. The pure/no-IO contract keeps the functional core deterministic; effects
(real FFI) remain explicitly out of scope.
