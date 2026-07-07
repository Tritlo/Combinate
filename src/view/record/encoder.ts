/**
 * Encoder seam (ADR 24): Mediabunny-backed MP4 output (WebCodecs underneath).
 * Probe first — a null video codec means recording is unavailable here.
 */
import type { CodecSupport } from "./types";

/** Probe WebCodecs support: H.264 for video, AAC with Opus fallback for audio. */
export async function probeSupport(): Promise<CodecSupport> {
  throw new Error("record: probeSupport not implemented yet");
}
