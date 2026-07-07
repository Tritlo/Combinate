/**
 * Offline audio rendering for ADR 24 recording. The live WebAudio path cannot
 * be captured deterministically, so the recorder schedules the same tone
 * envelope into an OfflineAudioContext at exact output timestamps.
 */
import { pitchFor, REDUCTION_TONE } from "../sound";
import type { RecordPlan, RecordSettings } from "./types";

const SAMPLE_RATE = 48_000;

/** Render the planned reduction tones to a 48 kHz mono AudioBuffer. */
export async function renderAudio(plan: RecordPlan, settings: RecordSettings): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(plan.durationSec * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  for (const tone of plan.tones) {
    if (tone.timeSec >= plan.durationSec) continue;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = REDUCTION_TONE.type;
    osc.frequency.value = pitchFor(tone.sym, settings.baseNote);
    gain.gain.setValueAtTime(REDUCTION_TONE.floor, tone.timeSec);
    gain.gain.exponentialRampToValueAtTime(REDUCTION_TONE.peak, tone.timeSec + REDUCTION_TONE.attackSec);
    gain.gain.exponentialRampToValueAtTime(REDUCTION_TONE.floor, tone.timeSec + REDUCTION_TONE.decaySec);
    osc.connect(gain).connect(ctx.destination);
    osc.start(tone.timeSec);
    osc.stop(tone.timeSec + REDUCTION_TONE.decaySec + REDUCTION_TONE.stopPaddingSec);
  }
  return ctx.startRendering();
}
