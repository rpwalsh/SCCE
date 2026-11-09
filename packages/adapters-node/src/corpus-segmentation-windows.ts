// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalGraphemeSegmenter } from "@scce/kernel";

export interface CorpusSegmentationWindow {
  startUtf16: number;
  endUtf16: number;
  ownedStartUtf16: number;
  text: string;
}
/** Complete original Unicode, one-grapheme overlap covers every adjacent boundary exactly once. */
export async function* corpusSegmentationWindows(chunks: AsyncIterable<string>, maxUtf16: number): AsyncGenerator<CorpusSegmentationWindow> {
  if (!Number.isSafeInteger(maxUtf16) || maxUtf16 < 2) throw new Error("Invalid segmentation Unicode window budget");
  let pending = "", current = "", start = 0, ownedStart = 0, last = "";
  const append = function* (grapheme: string): Generator<CorpusSegmentationWindow> {
    if (grapheme.length > maxUtf16) throw new Error("Segmentation window cannot contain one complete grapheme");
    if (current && current.length + grapheme.length > maxUtf16) {
      yield { startUtf16: start, endUtf16: start + current.length, ownedStartUtf16: ownedStart, text: current };
      ownedStart = start + current.length;
      start = ownedStart - last.length;
      current = last;
      if (current.length + grapheme.length > maxUtf16) throw new Error("Segmentation window cannot contain one complete adjacent grapheme pair");
    }
    current += grapheme; last = grapheme;
  };
  for await (const chunk of chunks) {
    if (chunk.length > maxUtf16) throw new Error("Segmentation source chunk exceeds window budget");
    pending += chunk;
    let retained = "";
    for (const part of canonicalGraphemeSegmenter().segment(pending)) {
      if (retained) yield* append(retained);
      retained = part.segment;
    }
    pending = retained;
    if (pending.length > maxUtf16) throw new Error("Segmentation window cannot contain one complete grapheme");
  }
  if (pending) yield* append(pending);
  if (current) yield { startUtf16: start, endUtf16: start + current.length, ownedStartUtf16: ownedStart, text: current };
}
