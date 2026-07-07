# 24. MP4 recording: offline frame-perfect only, with audio

We want reductions to be shareable artifacts (the Opus Magnum loop — see `IDEAS.md`).
Decision: render the focused reduction to an **MP4 with the sonification audio track**.
Entry points: a **"Record" entry in the File menu**, and a **red ● record button in the
transport bar** next to play/pause/ff — matching the transport buttons' style, with a
System-1-style variant for the retro chrome. Both open the same **record modal**. We do
**only the offline frame-perfect mode** — no live `captureStream()`/MediaRecorder path. Step the replay deterministically
(manual ticker, adaptive output schedule), render each frame, encode. Live capture inherits frame
drops and jank and can't do perfect loops; one deterministic path is less to maintain,
and it doubles as a replay harness.

The render is **displayed as it goes** — frames are rendered offline (offscreen target
at the chosen resolution); the preview canvas is refreshed at most **once every ~5s of
wall-clock** (plus the first and final frame) while the progress read-out updates every
frame, so watching the reduction never burdens the encode loop; a progress read-out on
top, not a headless export.

The modal opens **prefilled from the current canvas settings** — 2D vs 3D view,
expand-ι, layout (radial vs H-tree) — so recording captures what you're looking at.
Engine options: **rules, graph, and native are allowed; Turbo is not** — Turbo computes
the normal form wholesale in wasm with no per-step animation, so there's nothing to
render frame-by-frame.

**Parameters are tunable at record time**: per-step pacing (`stepMs`), final hold,
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
3D is allowed to be slow rather than silently truncating what it draws).
The modal shows a first-frame preview of the current settings, layout is an explicit
choice (Auto resolved via `resolveAutoLayout` at prefill), and the tone track is muted
by picking base note **None** (no separate audio toggle).

Round 3 (2026-07-07): 3D recording is **uncapped** (slow renders are fine), plus
**Rotate** (3D turntable, one
revolution per clip), **Theme** and **Color** (record light/dark and Colour-4096
without touching the live app), **Camera** Fixed/Follow
(smoothed re-fit per frame, deterministic), and burn-in **overlays** composited onto
the encode canvas: an info card (name/law/ι-count from the shell's lenses) and a
stats line (step n/total · node count).

Later same-day refinements: the info card became a **live readout** (the current
expression through the named/native lens, cached per step); framing is **root-anchored**
inside an overlay-safe rect (centered System-1 header card up top, frame-centred lens
line + right-aligned stats below); camera default is **hold** — start with the frame-0
root-anchored fit, then zoom out only when a later rendered step exceeds the current
framing (never zoom in, no layout lookahead) — with fixed/follow still available; 3D
has the same uncapped policy with a spin-speed setting (whole revolutions only — the
turn completes at the clip's end);
Colour-4096 and base-note-None round out the modal. (A separate Zen preset existed
briefly and was dropped — unticked overlays already mean clean frames.)
Recording captures the **current focused term to normal form** (the pre-reduction source
is ephemeral live state; a source-retention seam is a possible follow-up). A cheap
headless reducer pass counts steps (capped — Ω must not hang the modal), sizes the
progress bar, and schedules the tone track without doing layout.

**Pacing** is a record-time choice (correction, 2026-07-07 — the maintainer flipped the
earlier always-on time-lapse). The **default is Fixed**: the clip runs at exactly
`stepMs` per step start to finish — plain `steps·stepMs + holdMs` frame math (a sub-frame
step batches inside one rendered frame). The opt-in **Time-lapse** keeps the accelerating
schedule: start at `stepMs`, halve the per-step duration every 5s of output time until it
hits one frame, then double steps-per-frame (1, 2, 4, ... capped at 1024). Both regimes
cap tones to the first reduction step landing in each output frame, and both keep the
exact precount==driver frame-budget assert (one `createScheduleCursor` drives planning and
rendering). Graph mode ignores native opts, exactly as live reduction does. One recording
at a time; the live transport is paused while recording.
