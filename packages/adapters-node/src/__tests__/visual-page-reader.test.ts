// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { decodeImage, decodeNetpbm, decodePng, transcribeImageFile } from "../visual-page-reader.js";

// The claim: an image file becomes a DERIVED TRANSCRIPTION -- a document whose bytes are the text, carrying the
// hash of the image it came from and what the eye decided. Not an evidence span over the image, because an
// evidence span must carry its source's own bytes and an image has none. And a reading the eye would not stand
// behind carries its reason and no text at all.
//
// Decoding uses Node's zlib and nothing else. No image library, no model, no service.

/** A PNG written here, so the decoder is tested against the format rather than against another decoder. */
function encodePng(width: number, height: number, channels: 1 | 3, pixels: Uint8Array): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const name = Buffer.from(type, "ascii");
    // The CRC is not checked by the decoder under test, so a placeholder keeps the fixture honest about that.
    return Buffer.concat([length, name, body, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(pixels.subarray(row * stride, (row + 1) * stride)).copy(raw, row * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const LANGUAGE = {
  bigrams: [
    { previous: "a", next: "b", count: 40 },
    { previous: "b", next: "a", count: 30 },
    { previous: "a", next: "a", count: 12 }
  ],
  frequencies: [
    { symbol: "a", count: 70 },
    { symbol: "b", count: 52 }
  ]
};

describe("reading an image file with no image library and no model", () => {
  it("decodes a grayscale PNG it did not write itself", () => {
    const pixels = new Uint8Array([10, 200, 30, 240, 50, 60]);
    const decoded = decodePng(encodePng(3, 2, 1, pixels));
    expect(decoded.kind).toBe("gray");
    expect(decoded.image.width).toBe(3);
    expect(decoded.image.height).toBe(2);
    expect([...Array(6).keys()].map(i => decoded.image.data[i])).toEqual([10, 200, 30, 240, 50, 60]);
  });

  it("decodes a colour PNG", () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 255, 0]);
    const decoded = decodePng(encodePng(2, 1, 3, pixels));
    expect(decoded.kind).toBe("colour");
    expect([...Array(6).keys()].map(i => decoded.image.data[i])).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it("decodes binary Netpbm, gray and colour", () => {
    const gray = decodeNetpbm(Buffer.concat([
      Buffer.from("P5\n2 2\n255\n", "ascii"),
      Buffer.from([1, 2, 3, 4])
    ]));
    expect(gray.kind).toBe("gray");
    expect(gray.image.width).toBe(2);
    expect([...Array(4).keys()].map(i => gray.image.data[i])).toEqual([1, 2, 3, 4]);

    const colour = decodeNetpbm(Buffer.concat([
      // A comment in the header, which the format allows.
      Buffer.from("P6\n# written by a scanner\n1 1\n255\n", "ascii"),
      Buffer.from([9, 8, 7])
    ]));
    expect(colour.kind).toBe("colour");
    expect([...Array(3).keys()].map(i => colour.image.data[i])).toEqual([9, 8, 7]);
  });

  it("decides the format from the bytes, not the file name", () => {
    const png = encodePng(1, 1, 1, new Uint8Array([7]));
    expect(decodeImage(png).kind).toBe("gray");
    expect(decodeImage(Buffer.concat([Buffer.from("P5\n1 1\n255\n", "ascii"), Buffer.from([7])])).kind).toBe("gray");
  });

  it("refuses a format it cannot read, by name, rather than guessing at it", () => {
    // A JPEG's opening bytes. Guessing here would invent marks that were never on the page.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(() => decodeImage(jpeg)).toThrow(/unrecognised image format/);
    expect(() => decodePng(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/);
    // Sixteen bits per channel is a real PNG and is still refused by name rather than mis-read.
    const deep = encodePng(1, 1, 1, new Uint8Array([1]));
    deep[24] = 16;
    expect(() => decodePng(deep)).toThrow(/bit depth 16/);
  });

  it("returns a derived transcription that carries the image's hash, not text over the image", async () => {
    // Blank paper: the eye will not stand behind any reading of it.
    const directory = await mkdtemp(join(tmpdir(), "scce-eye-"));
    const path = join(directory, "page.pgm");
    const width = 80;
    const height = 60;
    const pixels = new Uint8Array(width * height).fill(230);
    await writeFile(path, Buffer.concat([
      Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii"),
      Buffer.from(pixels)
    ]));

    const transcription = await transcribeImageFile(path, LANGUAGE, { outerIterations: 20 });
    // The projection records where it came from: the hash is of the image's own bytes.
    expect(transcription.imageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(transcription.imageBytes).toBeGreaterThan(width * height);
    expect(transcription.imageWidth).toBe(width);
    expect(transcription.imageHeight).toBe(height);
    // Nothing was read, so nothing is claimed, and the reason is carried instead of a guess.
    expect(transcription.abstained).toBe(true);
    expect(transcription.abstainedBecause).toBeTruthy();
    expect(transcription.text).toBe("");
    expect(transcription.lines).toHaveLength(0);
  });
});
