// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { canonicalGraphemeSegmenter } from "@scce/kernel";
import { corpusSegmentationWindows } from "../corpus-segmentation-windows.js";

it("covers every original Unicode position and adjacent grapheme boundary once without inventing document independence", async () => {
  const text = "e\u0301????\r\n? ?????? e\u0301???";
  async function* chunks() { for (let index=0;index<text.length;index++) yield text.slice(index,index+1); }
  const windows = []; for await (const window of corpusSegmentationWindows(chunks(), 12)) windows.push(window);
  expect(windows.length).toBeGreaterThan(1);
  expect(windows.map(window => window.text.slice(window.ownedStartUtf16-window.startUtf16)).join("")).toBe(text);
  const sourceBoundaries = [...canonicalGraphemeSegmenter().segment(text)].map(part => part.index).slice(1);
  const actual: number[] = [];
  let covered = 0;
  for (const window of windows) {
    expect(window.ownedStartUtf16).toBe(covered); expect(window.endUtf16-window.startUtf16).toBeLessThanOrEqual(12);
    expect(text.slice(window.startUtf16,window.endUtf16)).toBe(window.text);
    actual.push(...[...canonicalGraphemeSegmenter().segment(window.text)].map(part => window.startUtf16+part.index).slice(1));
    covered = window.endUtf16;
  }
  expect(covered).toBe(text.length); expect(actual).toEqual(sourceBoundaries);
});
it("refuses an unrepresentable grapheme instead of silently clipping it", async () => {
  async function* chunks() { yield "a"; for(let index=0;index<20;index++) yield "\u0301"; }
  await expect((async () => { for await (const ignored of corpusSegmentationWindows(chunks(),8)) void ignored; })()).rejects.toThrow(/complete grapheme/);
});
