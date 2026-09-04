// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createChangeDetector, dHash, downscaleLuma, hammingDistance, runSensorSource, type FrameLuma, type IngestionSource } from "../sensor-ingest.js";

function gradient(width: number, height: number, shift = 0): FrameLuma {
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) luma[y * width + x] = ((x + shift) * 255) / width;
  return { width, height, luma };
}

describe("frame change detection", () => {
  it("hashes identical frames identically and different frames far apart", () => {
    const a = dHash(downscaleLuma(gradient(64, 48)));
    const b = dHash(downscaleLuma(gradient(64, 48)));
    const inverted = downscaleLuma(gradient(64, 48));
    inverted.luma.reverse();
    expect(hammingDistance(a, b)).toBe(0);
    expect(hammingDistance(a, dHash(inverted))).toBeGreaterThan(20);
  });

  it("admits the first frame, skips unchanged frames, admits changed ones", () => {
    const detector = createChangeDetector(10);
    expect(detector.admit(0n)).toBe(true);
    expect(detector.admit(1n)).toBe(false);
    expect(detector.admit(0xffffffffn)).toBe(true);
    expect(detector.admitted).toBe(2);
  });
});

describe("sensor runner", () => {
  it("ingests only changed frames with sensor provenance, and always closes the source", async () => {
    const changed = gradient(32, 32); changed.luma.reverse();
    const frames = [gradient(32, 32), gradient(32, 32), changed, changed];
    let closed = false;
    const source: IngestionSource = {
      id: "cam-1",
      kind: "video-file",
      async *frames() { for (const [index] of frames.entries()) yield { index, filePath: `frame-${index}`, capturedAt: index * 1000 }; },
      async close() { closed = true; }
    };
    const ingested: string[] = [];
    const result = await runSensorSource({
      source,
      sink: { ingestFile: async input => { ingested.push(input.uri); expect((input.metadata.sensor as { id: string }).id).toBe("cam-1"); } },
      readLuma: async filePath => frames[Number(filePath.split("-")[1])]!,
      changeThreshold: 10
    });
    expect(result).toMatchObject({ seen: 4, admitted: 2, ingested: 2 });
    expect(ingested).toEqual(["sensor://cam-1/frame/0", "sensor://cam-1/frame/2"]);
    expect(closed).toBe(true);
  });
});
