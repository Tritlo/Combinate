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
Recording captures the **current focused term to normal form** (the pre-reduction source
is ephemeral live state; a source-retention seam is a possible follow-up). A pre-run
pass counts steps (capped — Ω must not hang the modal), sizes the progress bar, and
schedules the tone track. Graph mode ignores native opts, exactly as live reduction
does. One recording at a time; the live transport is paused while recording.
