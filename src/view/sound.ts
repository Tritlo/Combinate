/**
 * Sonification (ADR 0005): a tiny WebAudio layer that plays one tone per
 * reduction tick, pitched by the *family* of the rule that fires (`firingRule`'s
 * symbol). The fundamentals (ι/I/K/S) get fixed low notes; every other bird is
 * hashed onto a major-pentatonic scale, so a reduction plays an (always
 * consonant) melody. No dependencies — one short-lived oscillator per tick.
 */

const SCALE = [0, 2, 4, 7, 9]; // major pentatonic — any subset sounds consonant
const FUNDAMENTAL_OFFSETS: Record<string, number> = { "ι": 0, I: 4, K: 7, S: 11 };

/** The reduction-tone envelope shared by live WebAudio and offline recording. */
export const REDUCTION_TONE = {
  type: "triangle" as OscillatorType,
  attackSec: 0.01,
  peak: 0.14,
  decaySec: 0.18,
  floor: 0.0001,
  stopPaddingSec: 0.02,
};

const midiToFreq = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** Map a firing-rule symbol to a MIDI note at `base`: fundamentals are offsets,
 *  named birds are hashed into the pentatonic scale across two octaves. */
export function midiFor(sym: string, base: number): number {
  let midi = FUNDAMENTAL_OFFSETS[sym];
  if (midi === undefined) {
    let h = 0;
    for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
    const oct = Math.floor(h / SCALE.length) % 2;
    midi = base + 12 + SCALE[h % SCALE.length] + 12 * oct;
  } else {
    midi += base;
  }
  return midi;
}

/** Map a firing-rule symbol to a frequency for the chosen MIDI base note. */
export function pitchFor(sym: string, base = 48): number {
  const midi = midiFor(sym, base);
  return midiToFreq(midi);
}

/** A toggleable one-oscillator-per-tick sonifier for the reduction stream. */
export class Sound {
  private ctx: AudioContext | null = null;
  enabled = true; // on by default — the browser still gates the AudioContext until the first gesture (see unlock)

  /** Flip on/off; resumes the (gesture-gated) AudioContext when enabled. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.enabled) this.ensure();
    return this.enabled;
  }

  /** Resume the (autoplay-gated) AudioContext on the first user gesture, so sound-on-by-default
   *  actually plays without a manual toggle. No-op when sound is off. */
  unlock(): void {
    if (this.enabled) this.ensure();
  }

  private ensure(): void {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  /** Play only if the audio context is already unlocked + running — for non-gesture
   *  events (a discovery chirp during auto-reduction) that must not trip the
   *  browser's autoplay policy by starting a context. */
  playIfReady(sym: string): void {
    if (this.ctx?.state === "running") this.play(sym);
  }

  /** Play a short tone for the rule about to fire (no-op when off or at NF). Auto-reduction is not a
   *  user gesture, so this only sounds once the context is already running — it must never START one
   *  (that would trip the browser's autoplay policy). A gesture (unlock / toggle / pickup) opens it. */
  tick(sym: string | null): void {
    if (!this.enabled || !sym || this.ctx?.state !== "running") return;
    this.play(sym);
  }

  /** Play a combinator's tone once, regardless of the reduction-sound toggle —
   *  for explicit plays (the Zoo "play tone" button, discovery chirp). The call
   *  must originate from a user gesture so the AudioContext can start. */
  play(sym: string): void {
    this.tone(pitchFor(sym, 48), REDUCTION_TONE.type, REDUCTION_TONE.peak, REDUCTION_TONE.decaySec);
  }

  /** A soft, low, round cue for dropping a tree — distinct from the (triangle) bird tones. The call
   *  must originate from a user gesture (the drop pointer-up) so the AudioContext can start. */
  drop(): void {
    this.tone(165, "sine", 0.12, 0.12); // ~E3
  }

  // One short-lived oscillator: ramp up, exponential decay, stop. Shared by play() and drop().
  private tone(freq: number, type: OscillatorType, peak: number, decay: number): void {
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(REDUCTION_TONE.floor, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + REDUCTION_TONE.attackSec);
    gain.gain.exponentialRampToValueAtTime(REDUCTION_TONE.floor, t + decay);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + decay + REDUCTION_TONE.stopPaddingSec);
  }
}
