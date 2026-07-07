# 24. MP4 recording: offline frame-perfect only, with audio

We want reductions to be shareable artifacts (the Opus Magnum loop — see `IDEAS.md`).
Decision: render the focused reduction to an **MP4 with the sonification audio track**.
Entry points: a **"Record" entry in the File menu**, and a **red ● record button in the
transport bar** next to play/pause/ff — matching the transport buttons' style, with a
System-1-style variant for the retro chrome. Both open the same **record modal**. We do
**only the offline frame-perfect mode** — no live `captureStream()`/MediaRecorder path. Step the replay deterministically
(fixed timestep, manual ticker), render each frame, encode. Live capture inherits frame
drops and jank and can't do perfect loops; one deterministic path is less to maintain,
and it doubles as a replay harness.

The render is **displayed as it goes** — frames are rendered offline (offscreen target
at the chosen resolution) but each one is blitted to the main canvas as it's encoded, so
recording *is* watching the reduction; a progress read-out on top, not a headless export.

The modal opens **prefilled from the current canvas settings** — 2D vs 3D view,
expand-ι, layout (radial vs H-tree) — so recording captures what you're looking at.
Engine options: **rules, graph, and native are allowed; Turbo is not** — Turbo computes
the normal form wholesale in wasm with no per-step animation, so there's nothing to
render frame-by-frame.

**Parameters are tunable at record time**: pacing (step duration / frames-per-reduction),
resolution/fps, and a **"base note"** — the root pitch the per-rule tones are derived
from, so recordings can be tuned musically. Record-time pacing is an explicit player
choice, so this stays consistent with ADR 22 (no display-cost heuristic may change it).
Audio is rendered offline too
(`OfflineAudioContext`, tones scheduled at exact frame timestamps — the live WebAudio
path can't be captured deterministically), then muxed with the video via **Mediabunny**
(the maintained successor to mp4-muxer — it owns the WebCodecs orchestration,
backpressure, and codec probing; AAC with Opus fallback where the browser lacks an AAC
encoder). No wasm encoder fallback in the MVP — probe first, fail with a clear message.

Scope notes (plan review, 2026-07-07): **2D landed first**; 3D followed the same day via
a recorder-owned Sphere3D (injected clock, pixel-ratio 1, its canvas encoded directly;
morphs over the cap fail loudly instead of jump-cutting — ADR 21 keeps 3D secondary).
The modal shows a first-frame preview of the current settings, layout is an explicit
choice (Auto resolved via `resolveAutoLayout` at prefill), and the tone track is muted
by picking base note **None** (no separate audio toggle).

Round 3 (2026-07-07): offline 3D is **uncapped** (node/morph caps are live-app
protections; slow offline renders are fine), plus **Rotate** (3D turntable, one
revolution per clip), **Theme** (record light/dark without touching the live app —
fixed mono palettes; deliberately ignores Colour-4096), **Camera** Fixed/Follow
(smoothed re-fit per frame, deterministic), and burn-in **overlays** composited onto
the encode canvas: an info card (name/law/ι-count from the shell's lenses) and a
stats line (step n/total · node count).

Later same-day refinements: the info card became a **live readout** (the current
expression through the named/native lens, cached per step); framing is **root-anchored**
inside an overlay-safe rect (centered System-1 header card up top, frame-centred lens
line + right-aligned stats below); camera default is **hold** — one zoom fitting the
whole reduction, from a pure layout pre-pass over every step — with fixed/follow still
available (3D hold falls back to fixed framing); a **Zen** preset records clean frames
with all overlays off; offline 3D is uncapped with a spin-speed setting; Colour-4096
and base-note-None round out the modal.
Recording captures the **current focused term to normal form** (the pre-reduction source
is ephemeral live state; a source-retention seam is a possible follow-up). A pre-run
pass counts steps (capped — Ω must not hang the modal), sizes the progress bar, and
schedules the tone track. Graph mode ignores native opts, exactly as live reduction
does. One recording at a time; the live transport is paused while recording.
