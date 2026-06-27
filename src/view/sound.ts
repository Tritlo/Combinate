/**
 * Sonification (ADR 0005): a tiny WebAudio layer that plays one tone per
 * reduction tick, pitched by the *family* of the rule that fires (`firingRule`'s
 * symbol). The fundamentals (ι/I/K/S) get fixed low notes; every other bird is
 * hashed onto a major-pentatonic scale, so a reduction plays an (always
 * consonant) melody. No dependencies — one short-lived oscillator per tick.
 */

const SCALE = [0, 2, 4, 7, 9]; // major pentatonic — any subset sounds consonant
const FUNDAMENTAL: Record<string, number> = { "ι": 48, I: 52, K: 55, S: 59 }; // MIDI notes

const midiToFreq = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** Map a firing-rule symbol to a frequency: fundamentals are fixed, named birds
 *  are hashed into the pentatonic scale across two octaves. */
function pitchFor(sym: string): number {
  let midi = FUNDAMENTAL[sym];
  if (midi === undefined) {
    let h = 0;
    for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
    const oct = Math.floor(h / SCALE.length) % 2;
    midi = 60 + SCALE[h % SCALE.length] + 12 * oct;
  }
  return midiToFreq(midi);
}

/** A toggleable one-oscillator-per-tick sonifier for the reduction stream. */
export class Sound {
  private ctx: AudioContext | null = null;
  enabled = false;

  /** Flip on/off; resumes the (gesture-gated) AudioContext when enabled. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.enabled) this.ensure();
    return this.enabled;
  }

  private ensure(): void {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Play a short tone for the rule about to fire (no-op when off or at NF). */
  tick(sym: string | null): void {
    if (!this.enabled || !sym) return;
    this.play(sym);
  }

  /** Play a combinator's tone once, regardless of the reduction-sound toggle —
   *  for explicit plays (the Zoo "play tone" button, discovery chirp). The call
   *  must originate from a user gesture so the AudioContext can start. */
  play(sym: string): void {
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = pitchFor(sym);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}
