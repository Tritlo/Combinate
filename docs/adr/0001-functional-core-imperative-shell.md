# 1. Functional core, imperative shell (hexagonal)

**Status:** accepted

The domain lives in `src/core/` as a pure functional core — terms (`term.ts`),
normal-order reduction (`reduce.ts`), behavioural recognition/discovery
(`probe.ts`), layout geometry (`layout.ts`), and the combinator catalogue
(`catalog.ts`). It has **no Pixi, DOM, time, or randomness** and is deterministic
and unit-testable in isolation. `src/view/` (Pixi adapters: tree, hotbar, zoo,
toast, theme) plus `src/app.ts` (the composition root) are the imperative shell:
the single driving adapter that maps user gestures onto core operations and core
results back onto the screen.

This is hexagonal with one driving adapter and no driven adapters: the "ports"
are just the core's exported function signatures (`step`, `normalize`,
`recognize`, `iotaTreeOf`, `layout*`, `CATALOG`/`PAGES`), and the dependency
arrow only ever points shell → core. We deliberately don't add formal port
interfaces — for a single-UI frontend that would be ceremony, not safety.

**Consequences.** The rule is mechanically checkable: `grep -rn
"pixi\|window\.\|document\." src/core/` must stay empty. Reduction/recognition can
be verified headlessly (as the smoke checks do) without booting Pixi. New
rendering tech (a different canvas lib, SSR thumbnails) would be a new adapter
over the same core.
