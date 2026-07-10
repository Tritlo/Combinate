# Codebase audit log

First-party audit ledger. `IDEAS.md` and `vendor/microhs/` are intentionally out of scope.

| Date | Category | Area | Change | Evidence / why | Verification |
|---|---|---|---|---|---|
| 2026-07-10 | slop | `crates/minimal` | Removed superseded FPC helpers and unused census/work-item remnants. | `cargo test` reported 18 warnings; searches found no live callers/readers. | Warning-free `cargo test --manifest-path crates/minimal/Cargo.toml`; production build and release check pass. |
| 2026-07-10 | slop | `crates/reduce` | Removed the unused `TAG_FREE` binding; wire tag 2 remains documented and pass-through handling is unchanged. | `cargo test` reported the constant as dead; decoding never branches on free nodes. | Warning-free `cargo test --manifest-path crates/reduce/Cargo.toml`; production build and release check pass. |
| 2026-07-10 | docs | architecture docs and module headers | Replaced dead `PLAN.md`, `layout.ts`, and `layout3d.ts` pointers with their current ADR/module locations. | The referenced files were deleted or split; live paths are `docs/adr/` and `src/core/layouts/`. | `npm run typecheck`, `npm run build`, and `npm run check:release` pass. |
