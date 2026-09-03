import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "./document.js";

/**
 * Live sensor ingestion (Phase 4): a pluggable source interface with one
 * reference adapter (local video file, or a webcam device through ffmpeg).
 * Frames are sampled by change detection (dHash Hamming distance), never
 * every frame, so graph-write volume stays proportional to what changed.
 * Each admitted frame is written to a temp file and ingested through the
 * ordinary file path, so it gets the same provenance/identity/timestamp
 * treatment (and Phase 3 visual attributes) as any other document.
 */

export interface SensorFrame {
  index: number;
  filePath: string;
  capturedAt: number;
}

export interface IngestionSource {
  id: string;
  kind: string;
  /** Yields candidate frames; the runner decides which to ingest. */
  frames(): AsyncIterable<SensorFrame>;
  close(): Promise<void>;
}

export interface SensorSink {
  ingestFile(input: { path: string; uri: string; metadata: Record<string, unknown> }): Promise<unknown>;
}

export interface FrameLuma {
  width: number;
  height: number;
  /** Row-major grayscale, 0..255. */
  luma: Uint8Array;
}

/** dHash: compare each pixel with its right neighbour on a (w+1)×h downscale. Pure; input is already downscaled luma. */
export function dHash(frame: FrameLuma): bigint {
  const { width, height, luma } = frame;
  let hash = 0n;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      const left = luma[y * width + x] ?? 0;
      const right = luma[y * width + x + 1] ?? 0;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

export function hammingDistance(left: bigint, right: bigint): number {
  let x = left ^ right;
  let count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

/** Nearest-neighbour downscale of a luma plane to (targetWidth × targetHeight). Pure. */
export function downscaleLuma(frame: FrameLuma, targetWidth = 9, targetHeight = 8): FrameLuma {
  const luma = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.min(frame.height - 1, Math.floor((y * frame.height) / targetHeight));
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(frame.width - 1, Math.floor((x * frame.width) / targetWidth));
      luma[y * targetWidth + x] = frame.luma[sourceY * frame.width + sourceX] ?? 0;
    }
  }
  return { width: targetWidth, height: targetHeight, luma };
}

/** Change detector over frame hashes: admits a frame when its distance from the last admitted hash reaches the threshold. Pure state machine. */
export function createChangeDetector(threshold = 10): { admit(hash: bigint): boolean; readonly admitted: number } {
  let last: bigint | undefined;
  let admitted = 0;
  return {
    admit(hash) {
      if (last === undefined || hammingDistance(last, hash) >= threshold) { last = hash; admitted++; return true; }
      return false;
    },
    get admitted() { return admitted; }
  };
}

export interface VideoSourceOptions {
  id: string;
  kind: "video-file" | "webcam";
  input: string;
  fps?: number;
  maxFrames?: number;
  ffmpeg?: string;
}

/** Reference adapter: ffmpeg extracts frames at `fps` from a file (or a webcam device on Windows via dshow). */
export function createVideoFrameSource(options: VideoSourceOptions): IngestionSource {
  const fps = Math.max(0.1, Math.min(10, options.fps ?? 1));
  const maxFrames = Math.max(1, Math.min(5000, options.maxFrames ?? 300));
  let directory: string | undefined;
  return {
    id: options.id,
    kind: options.kind,
    async *frames() {
      directory = await mkdtemp(path.join(tmpdir(), `scce-sensor-${options.id.replace(/[^a-z0-9_-]/giu, "_")}-`));
      const inputArgs = options.kind === "webcam" ? ["-f", "dshow", "-i", `video=${options.input}`, "-t", String(Math.ceil(maxFrames / fps))] : ["-i", options.input];
      const result = await runProcess(options.ffmpeg ?? "ffmpeg", [...inputArgs, "-vf", `fps=${fps}`, "-frames:v", String(maxFrames), path.join(directory, "frame-%05d.png")], { timeoutMs: 600_000 });
      if (result.code !== 0) throw new Error(`ffmpeg failed for sensor ${options.id}: ${result.stderr?.slice(0, 300) ?? result.code}`);
      const files = (await readdir(directory)).filter(name => name.endsWith(".png")).sort();
      const startedAt = Date.now();
      for (const [index, name] of files.entries()) {
        const filePath = path.join(directory, name);
        const info = await stat(filePath);
        yield { index, filePath, capturedAt: options.kind === "video-file" ? startedAt + Math.round((index / fps) * 1000) : info.mtimeMs };
      }
    },
    async close() {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export interface SensorRunResult {
  sourceId: string;
  seen: number;
  admitted: number;
  ingested: number;
}

/** Runs a source through change detection and the sink. `readLuma` is injected (RawImage in production, fixtures in tests). */
export async function runSensorSource(input: {
  source: IngestionSource;
  sink: SensorSink;
  readLuma: (filePath: string) => Promise<FrameLuma>;
  changeThreshold?: number;
  log?: (message: string) => void;
}): Promise<SensorRunResult> {
  const detector = createChangeDetector(input.changeThreshold ?? 10);
  const log = input.log ?? (() => undefined);
  let seen = 0, ingested = 0;
  log(`sensor ${input.source.id} (${input.source.kind}) active`);
  try {
    for await (const frame of input.source.frames()) {
      seen++;
      const hash = dHash(downscaleLuma(await input.readLuma(frame.filePath)));
      if (!detector.admit(hash)) continue;
      await input.sink.ingestFile({
        path: frame.filePath,
        uri: `sensor://${input.source.id}/frame/${frame.index}`,
        metadata: { sensor: { id: input.source.id, kind: input.source.kind, frameIndex: frame.index, capturedAt: frame.capturedAt, dHash: hash.toString(16) } }
      });
      ingested++;
    }
  } finally {
    await input.source.close();
    log(`sensor ${input.source.id} stopped: ${seen} frames seen, ${detector.admitted} changed, ${ingested} ingested`);
  }
  return { sourceId: input.source.id, seen, admitted: detector.admitted, ingested };
}

/** Production luma reader via transformers.js RawImage (no weights involved). */
export async function readLumaWithRawImage(filePath: string): Promise<FrameLuma> {
  const specifier = "@huggingface/transformers";
  const { RawImage } = await import(specifier) as typeof import("@huggingface/transformers");
  const image = (await RawImage.read(filePath)).grayscale();
  return { width: image.width, height: image.height, luma: Uint8Array.from(image.data) };
}
