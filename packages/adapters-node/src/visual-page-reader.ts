// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The eye, given a file. Decoding is done here with Node's own zlib and nothing else: no image library, no
// model, no service. PNG and the Netpbm formats are read; anything else is refused by name rather than guessed
// at, because a decoder that silently mis-reads a format produces marks that were never on the page.
//
// What comes back is a DERIVED TRANSCRIPTION, and the distinction matters more than it looks. An evidence span
// in SCCE must carry its source's own bytes, with a hash over exactly those bytes -- that is the invariant every
// provenance consumer downstream relies on. An image has no text bytes, so a reading of it cannot be evidence
// over the image. It is a projection: a separate document whose bytes ARE the transcription, carrying the hash
// of the image it came from, what the eye decided, and how strongly. Spans over the transcription then satisfy
// the invariant honestly, and nothing claims the image said something it did not.
//
// A reading the eye would not stand behind produces no text at all, only the reason. Silence is citable; a
// confident wrong transcription is not.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import {
  knownLanguageFrom,
  projectColor,
  flattenIllumination,
  readImage,
  scriptMemoryOf,
  type ColorImage,
  type CooccurrenceBigram,
  type GrayImage,
  type LearnedSign,
  type ScriptMemory,
  type SymbolFrequency
} from "@scce/kernel";

export type DecodedImage =
  | { readonly kind: "gray"; readonly image: GrayImage }
  | { readonly kind: "colour"; readonly image: ColorImage };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!;
    const source = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const target = out.subarray(row * stride, (row + 1) * stride);
    const previous = row > 0 ? out.subarray((row - 1) * stride, row * stride) : undefined;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? target[i - channels]! : 0;
      const up = previous ? previous[i]! : 0;
      const upLeft = previous && i >= channels ? previous[i - channels]! : 0;
      const value = source[i]!;
      switch (filter) {
        case 0: target[i] = value; break;
        case 1: target[i] = (value + left) & 0xff; break;
        case 2: target[i] = (value + up) & 0xff; break;
        case 3: target[i] = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          // Paeth: whichever of the three neighbours the gradient predicts best.
          const estimate = left + up - upLeft;
          const dLeft = Math.abs(estimate - left);
          const dUp = Math.abs(estimate - up);
          const dUpLeft = Math.abs(estimate - upLeft);
          const nearest = dLeft <= dUp && dLeft <= dUpLeft ? left : (dUp <= dUpLeft ? up : upLeft);
          target[i] = (value + nearest) & 0xff;
          break;
        }
        default: throw new Error(`PNG scanline filter ${filter} is not one of the five the format defines`);
      }
    }
  }
  return out;
}

/** Decode an 8-bit non-interlaced PNG. Anything else is named rather than approximated. */
export function decodePng(bytes: Buffer): DecodedImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG: signature does not match");
  }
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = -1;
  let interlace = 0;
  const data: Buffer[] = [];
  let palette: Buffer | undefined;

  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colourType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "IDAT") data.push(Buffer.from(body));
    else if (type === "IEND") break;
    at += 12 + length;
  }

  if (!width || !height) throw new Error("PNG has no image header");
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not supported; 8 is`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");

  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : 4;
  if (colourType !== 0 && colourType !== 2 && colourType !== 3 && colourType !== 4 && colourType !== 6) {
    throw new Error(`PNG colour type ${colourType} is not supported`);
  }
  const pixels = unfilter(inflateSync(Buffer.concat(data)), width, height, channels);

  if (colourType === 3) {
    if (!palette) throw new Error("indexed PNG has no palette");
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const index = pixels[i]! * 3;
      rgb[i * 3] = palette[index] ?? 0;
      rgb[i * 3 + 1] = palette[index + 1] ?? 0;
      rgb[i * 3 + 2] = palette[index + 2] ?? 0;
    }
    return { kind: "colour", image: { width, height, data: rgb } };
  }
  if (colourType === 0 || colourType === 4) {
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) gray[i] = pixels[i * channels]!;
    return { kind: "gray", image: { width, height, data: gray } };
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = pixels[i * channels]!;
    rgb[i * 3 + 1] = pixels[i * channels + 1]!;
    rgb[i * 3 + 2] = pixels[i * channels + 2]!;
  }
  return { kind: "colour", image: { width, height, data: rgb } };
}

/** Decode binary Netpbm: P5 is gray, P6 is colour. The simplest honest format a scanner can emit. */
export function decodeNetpbm(bytes: Buffer): DecodedImage {
  const magic = bytes.toString("ascii", 0, 2);
  if (magic !== "P5" && magic !== "P6") throw new Error(`Netpbm type ${magic} is not supported; P5 and P6 are`);
  let at = 2;
  const fields: number[] = [];
  while (fields.length < 3) {
    while (at < bytes.length && /\s/.test(String.fromCharCode(bytes[at]!))) at += 1;
    if (bytes[at] === 0x23) {
      while (at < bytes.length && bytes[at] !== 0x0a) at += 1;
      continue;
    }
    let value = 0;
    let digits = 0;
    while (at < bytes.length && bytes[at]! >= 0x30 && bytes[at]! <= 0x39) {
      value = value * 10 + (bytes[at]! - 0x30);
      at += 1;
      digits += 1;
    }
    if (!digits) throw new Error("Netpbm header is malformed");
    fields.push(value);
  }
  at += 1;
  const [width, height, maximum] = fields as [number, number, number];
  if (maximum !== 255) throw new Error(`Netpbm maximum value ${maximum} is not supported; 255 is`);
  const body = bytes.subarray(at);
  if (magic === "P5") {
    return { kind: "gray", image: { width, height, data: new Uint8Array(body.subarray(0, width * height)) } };
  }
  return { kind: "colour", image: { width, height, data: new Uint8Array(body.subarray(0, width * height * 3)) } };
}

/** Decode by what the bytes say they are, never by the file's extension. */
export function decodeImage(bytes: Buffer): DecodedImage {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") return decodePng(bytes);
  const magic = bytes.toString("ascii", 0, 2);
  if (magic === "P5" || magic === "P6") return decodeNetpbm(bytes);
  throw new Error("unrecognised image format: the bytes are neither PNG nor binary Netpbm");
}

export interface PageTranscription {
  /** The transcription, which IS this derived document's bytes. Empty when the eye would not stand behind it. */
  readonly text: string;
  readonly lines: readonly string[];
  /** Hash of the image's own bytes: what this projection came from. */
  readonly imageSha256: string;
  readonly imageBytes: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** True when the capture was colour and was projected onto its measured contrast axis. */
  readonly colourProjected: boolean;
  /** True when the illumination was divided out before reading. */
  readonly illuminationFlattened: boolean;
  readonly orientation: string;
  readonly grouping: string;
  readonly rightToLeft: boolean;
  readonly signCount: number;
  readonly glyphCount: number;
  readonly abstained: boolean;
  readonly abstainedBecause: string | undefined;
  /** Log-likelihood per symbol under the known language, and the margin over the rejected direction. */
  readonly fit: number;
  readonly directionMargin: number;
  /** Whether the page read one mark at a time or in the multi-mark units it was found to be written in. */
  readonly granularity: string;
  /**
   * What else the page might say. Readings are cheapest first and `readingMargin` is how far ahead the chosen
   * one is, in nats. A small margin means the page genuinely admits more than one reading, and a caller that
   * shows a transcription without showing that is overstating what was read.
   */
  readonly alternatives: readonly {
    readonly orientation: string;
    readonly grouping: string;
    readonly framing: string;
    readonly signCount: number;
    readonly codeLength: number;
  }[];
  readonly readingMargin: number;
  /** How many of this page's signs were already known from a script read before. */
  readonly recalledSigns: number;
  /**
   * What this reading learned about the script, ready for `rememberScript`. Absent when the eye abstained or
   * the caller named no script: there is nothing a page the eye would not stand behind can teach.
   */
  readonly learned: ScriptMemory | undefined;
}

/** The storage surface reading a page needs: the same bigram table cross-lingual alignment reads. */
export interface VisualLanguageStorage {
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  table(name: string): string;
}

/**
 * The language SCCE has ingested, in the shape the eye consumes, taken from the corpus's own co-occurrence at
 * character granularity. Bounded by weight, so the working vocabulary is the language's most-used structure
 * rather than its long tail.
 */
export async function knownLanguageFromBrain(
  storage: VisualLanguageStorage,
  languageHint: string,
  maxBigrams = 4096
): Promise<{ bigrams: CooccurrenceBigram[]; frequencies: SymbolFrequency[] }> {
  const rows = await storage.query<{ previous: string; next: string; total: string }>(
    `SELECT history[1] AS previous, symbol AS next, SUM(count)::bigint AS total
       FROM ${storage.table("ngram_observations")}
      WHERE order_n = 2 AND language_hint = $1 AND array_length(history, 1) = 1
      GROUP BY history[1], symbol
      ORDER BY SUM(count) DESC
      LIMIT $2`,
    [languageHint, Math.max(1, maxBigrams)]
  );
  const bigrams = rows
    .filter(row => row.previous && row.next)
    .map(row => ({ previous: row.previous, next: row.next, count: Number(row.total) }));

  // Symbol frequencies from the same counts, so the anchors and the likelihood come from one measurement.
  const counts = new Map<string, number>();
  for (const bigram of bigrams) {
    counts.set(bigram.previous, (counts.get(bigram.previous) ?? 0) + bigram.count);
    counts.set(bigram.next, (counts.get(bigram.next) ?? 0) + bigram.count);
  }
  const frequencies = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, count]) => ({ symbol, count }));
  return { bigrams, frequencies };
}

export interface ReadPageOptions {
  /** Divide out the illumination first. Worth it for a photograph, needless for a clean scan. */
  readonly flattenLight?: boolean;
  readonly outerIterations?: number;
  readonly epsilon?: number;
  /** Signs read before, from `recallScript`. Any that match this page inside its own same-sign scale come in known. */
  readonly remembered?: readonly LearnedSign[];
  /** What to call the script this page is in, when keeping what was learned from it. */
  readonly scriptId?: string;
  /** Which language the reading is into. Both this and `scriptId` are needed before a reading can be kept. */
  readonly targetLanguage?: string;
}

/**
 * Read an image file into a derived transcription. The language is whatever SCCE has already ingested, supplied
 * at the granularity the script's signs are expected to carry.
 */
export async function transcribeImageFile(
  path: string,
  language: { readonly bigrams: readonly CooccurrenceBigram[]; readonly frequencies: readonly SymbolFrequency[] },
  options: ReadPageOptions = {}
): Promise<PageTranscription> {
  const bytes = await readFile(path);
  const decoded = decodeImage(bytes);
  const colourProjected = decoded.kind === "colour";
  const monochrome = colourProjected ? projectColor(decoded.image) : decoded.image;
  const flattened = options.flattenLight ? flattenIllumination(monochrome) : monochrome;

  const reading = readImage(flattened, knownLanguageFrom(language.bigrams, language.frequencies), {
    outerIterations: options.outerIterations,
    epsilon: options.epsilon,
    remembered: options.remembered
  });

  // A reading the eye would not stand behind carries its reason and no text. Silence is citable.
  const lines = reading.abstained ? [] : reading.lines.map(line => line.join(""));
  return {
    text: lines.join("\n"),
    lines,
    imageSha256: createHash("sha256").update(bytes).digest("hex"),
    imageBytes: bytes.length,
    imageWidth: flattened.width,
    imageHeight: flattened.height,
    colourProjected,
    illuminationFlattened: options.flattenLight === true,
    orientation: reading.orientation,
    grouping: reading.grouping,
    rightToLeft: reading.reversed,
    signCount: reading.signCount,
    glyphCount: reading.glyphCount,
    abstained: reading.abstained,
    abstainedBecause: reading.abstainedBecause,
    fit: reading.fit,
    directionMargin: reading.directionMargin,
    granularity: reading.granularity,
    alternatives: reading.considered.map(candidate => ({
      orientation: candidate.orientation,
      grouping: candidate.grouping,
      framing: candidate.framing,
      signCount: candidate.signCount,
      codeLength: candidate.codeLength
    })),
    readingMargin: reading.margin,
    recalledSigns: reading.recalledSigns,
    // What a sign is worth remembering by is the likelihood the known language itself assigns per symbol to the
    // reading that taught it. Nothing is kept from a page the eye would not stand behind.
    learned: reading.abstained || options.scriptId === undefined || options.targetLanguage === undefined
      ? undefined
      : scriptMemoryOf({
          scriptId: options.scriptId,
          targetLanguage: options.targetLanguage,
          signs: reading.signs,
          signToSymbol: reading.signToSymbol,
          score: Math.exp(reading.fit)
        })
  };
}
