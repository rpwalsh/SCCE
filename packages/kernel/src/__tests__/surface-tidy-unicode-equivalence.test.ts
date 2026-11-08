// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { tidySurfaceText, isSentenceBoundarySymbol } from "../surface-linguistics.js";

function previousTransform(text: string): string {
  const collapsed: string[] = [];
  let pending = false;
  for (const char of text.normalize("NFC")) {
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v") { pending = collapsed.length > 0; continue; }
    if (pending) collapsed.push(" ");
    pending = false;
    collapsed.push(char);
  }
  let out = "";
  for (const char of collapsed.join("").trim()) {
    const previous = out[out.length - 1] ?? "";
    if (isSentenceBoundarySymbol(char) && previous === char) continue;
    if ((char === ":" || char === ";" || char === "," || char === "،" || char === "、") && previous === char) continue;
    out += char;
  }
  return out;
}

it("preserves NFC, whitespace and UTF16 boundary behavior across deterministic Unicode samples", () => {
  const symbols = ["a", "界", "ગુજરાતી", "한", "e\u0301", "👩‍🚀", "\ud800", "\udfff", " ", "\t", "\n", "\v", "\u00a0", "\u2003", ".", "!", "?", "。", "؟", ":", ";", ",", "،", "、"];
  let state = 94723;
  for (let sample = 0; sample < 80; sample++) {
    let text = "";
    for (let index = 0; index < 120; index++) { state = Math.imul(state, 1664525) + 1013904223 | 0; text += symbols[(state >>> 0) % symbols.length]; }
    expect(tidySurfaceText(text)).toBe(previousTransform(text));
  }
});
