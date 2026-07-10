# Codebase audit log

First-party audit ledger. `IDEAS.md` and `vendor/microhs/` are intentionally out of scope.

| Date | Category | Area | Change | Evidence / why | Verification |
|---|---|---|---|---|---|
| 2026-07-10 | slop | `crates/minimal` | Removed superseded FPC helpers and unused census/work-item remnants. | `cargo test` reported 18 warnings; searches found no live callers/readers. | Warning-free `cargo test --manifest-path crates/minimal/Cargo.toml`; production build and release check pass. |
| 2026-07-10 | slop | `crates/reduce` | Removed the unused `TAG_FREE` binding; wire tag 2 remains documented and pass-through handling is unchanged. | `cargo test` reported the constant as dead; decoding never branches on free nodes. | Warning-free `cargo test --manifest-path crates/reduce/Cargo.toml`; production build and release check pass. |
| 2026-07-10 | docs | architecture docs and module headers | Replaced dead `PLAN.md`, `layout.ts`, and `layout3d.ts` pointers with their current ADR/module locations. | The referenced files were deleted or split; live paths are `docs/adr/` and `src/core/layouts/`. | `npm run typecheck`, `npm run build`, and `npm run check:release` pass. |
| 2026-07-10 | simplify | `crates/minimal` | Replaced three comparator/index-shape remnants with the direct `sort_by_key`/`values` forms. | `clippy::all` found them; unlike its other loop suggestions, these do not encode reduction stack or enumeration indices. | `cargo test` passes; those three lints are gone from `clippy::all`. |
| 2026-07-10 | docs | ADRs and recorder contract | Updated deleted reader/modal/hook names, current optimization defaults, kernel status, and the shipped 3D recorder path. | Source searches showed the prose described APIs and UI states that no longer exist; historical specs remain untouched. | Dead-reference scan is clean; `npm run build` passes. |
