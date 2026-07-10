/**
 * Encoder seam (ADR 24): Mediabunny-backed MP4 output (WebCodecs underneath).
 * Probe first — a null video codec means recording is unavailable here.
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
} from "mediabunny";
import type { CodecSupport, RecordPlan, RecordSettings } from "./types";

const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITRATE = 160_000;
/**
 * Combinate frames are flat 1-bit / few-hue line-art, so a fixed high bitrate
 * just bloats the file. Mediabunny's resolution-aware {@link QUALITY_MEDIUM}
 * (~1.7 Mbps at 1080², vs the old ~5.6 Mbps target) is visually lossless here
 * and roughly a third the size. VBR still undershoots on near-static frames.
 */
const VIDEO_QUALITY = QUALITY_MEDIUM;

/** A started MP4 encoder owned by the recorder driver. */
export interface RecordingEncoder {
  addFrame: (timestampSec: number, durationSec: number) => Promise<void>;
  finalize: () => Promise<Blob>;
  cancel: () => Promise<void>;
}

async function audioCodec(): Promise<"aac" | "opus" | null> {
  const opts = { numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE };
  if (await canEncodeAudio("aac", opts).catch(() => false)) return "aac";
  if (await canEncodeAudio("opus", opts).catch(() => false)) return "opus";
  return null;
}

/** Probe WebCodecs support: H.264 for video, AAC with Opus fallback for audio. */
export async function probeSupport(): Promise<CodecSupport> {
  const video = (await canEncodeVideo("avc").catch(() => false)) ? "avc" : null;
  return { video, audio: await audioCodec() };
}

/** Start a Mediabunny MP4 encoder for the recorder-owned canvas and optional audio. */
export async function createRecordingEncoder(
  canvas: HTMLCanvasElement,
  settings: RecordSettings,
  plan: RecordPlan,
  audioBuffer: AudioBuffer | null,
): Promise<RecordingEncoder> {
  const bitrate = VIDEO_QUALITY;
  if (!(await canEncodeVideo("avc", { width: settings.width, height: settings.height, bitrate }).catch(() => false))) {
    throw new Error("record: H.264 video encoding is unavailable in this browser");
  }

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    bitrate,
    keyFrameInterval: 2,
    alpha: "discard",
    bitrateMode: "variable",
    latencyMode: "quality",
  });
  output.addVideoTrack(videoSource, { frameRate: settings.fps, maximumPacketCount: plan.totalFrames });

  let audioSource: AudioBufferSource | null = null;
  if (settings.audio && plan.tones.length > 0 && audioBuffer) {
    const codec = await audioCodec();
    if (codec) {
      audioSource = new AudioBufferSource({ codec: codec as AudioCodec, bitrate: AUDIO_BITRATE });
      output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(plan.durationSec * 100) + 16 });
    }
  }

  try {
    await output.start();
    if (audioSource && audioBuffer) {
      await audioSource.add(audioBuffer);
      audioSource.close();
    }
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }

  return {
    addFrame: (timestampSec, durationSec) => videoSource.add(timestampSec, durationSec),
    finalize: async () => {
      videoSource.close();
      await output.finalize();
      if (!target.buffer) throw new Error("record: MP4 encoder produced no output");
      return new Blob([target.buffer], { type: "video/mp4" });
    },
    cancel: async () => {
      videoSource.close();
      audioSource?.close();
      if (output.state !== "canceled" && output.state !== "finalized") await output.cancel();
    },
  };
}
