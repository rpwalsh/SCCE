// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Test scaffolding only: a bitmap font and a page renderer, so the visual pipeline can be proven on captures
// whose ground truth is known exactly. Production code never sees a font.

import type { GrayImage } from "../visual-page-analysis.js";

export const FONT: Record<string, readonly string[]> = {
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."]
};

export const ALPHABET = Object.keys(FONT);

/** The same font reflected left-to-right, as a script that flips with reading direction would render it. */
export const MIRROR_FONT: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(FONT).map(([ch, rows]) => [ch, rows.map(row => [...row].reverse().join(""))])
);

export const SCALE = 3;
export const GLYPH_W = 5;
export const GLYPH_H = 7;
export const LETTER_GAP = 1;
export const WORD_GAP = 4;
export const LINE_GAP = 6;
export const MARGIN = 6;
export const PAPER = 235;
export const INK = 35;

/** Deterministic integer jitter in -8..8, so a "capture" is never pixel-perfect. */
export function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state % 17) - 8;
  };
}

/** A deterministic 0..1 stream. */
export function uniform(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state % 100000) / 100000;
  };
}

export interface RenderedLine {
  readonly text: string;
  readonly font: Record<string, readonly string[]>;
}

/** Render lines of space-separated words as a grayscale page, plus isolated single-pixel specks. */
export function renderTextPage(lines: readonly string[], specks: readonly [number, number][] = []): GrayImage {
  return renderTextPageWith(FONT, lines, specks);
}

/** As renderTextPage, with the glyph shapes supplied: a different font, or the same font reflected. */
export function renderTextPageWith(
  font: Record<string, readonly string[]>,
  lines: readonly string[],
  specks: readonly [number, number][] = []
): GrayImage {
  return renderMixedPage(lines.map(text => ({ text, font })), specks);
}

/** A page whose lines are carved in different hands: mixed reading direction, or two scripts at once. */
export function renderMixedPage(
  lines: readonly RenderedLine[],
  specks: readonly [number, number][] = []
): GrayImage {
  const columns = Math.max(...lines.map(({ text }) => {
    const words = text.split(" ");
    const letters = words.reduce((total, word) => total + word.length, 0);
    return letters * GLYPH_W + (letters - words.length) * LETTER_GAP + (words.length - 1) * WORD_GAP;
  }));
  const width = (columns + 2 * MARGIN) * SCALE;
  const height = (lines.length * GLYPH_H + (lines.length - 1) * LINE_GAP + 2 * MARGIN) * SCALE;
  const data = new Uint8Array(width * height);
  const jitter = noise(99);
  for (let i = 0; i < data.length; i++) data[i] = PAPER + jitter();

  const plot = (fx: number, fy: number) => {
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const x = fx * SCALE + dx;
        const y = fy * SCALE + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) data[y * width + x] = INK + jitter();
      }
    }
  };

  lines.forEach(({ text, font }, lineIndex) => {
    const top = MARGIN + lineIndex * (GLYPH_H + LINE_GAP);
    let cursor = MARGIN;
    text.split(" ").forEach((word, wordIndex) => {
      if (wordIndex > 0) cursor += WORD_GAP;
      [...word].forEach((character, characterIndex) => {
        if (characterIndex > 0) cursor += LETTER_GAP;
        const glyph = font[character]!;
        glyph.forEach((row, ry) => [...row].forEach((cell, rx) => {
          if (cell === "#") plot(cursor + rx, top + ry);
        }));
        cursor += GLYPH_W;
      });
    });
  });

  for (const [sx, sy] of specks) plot(sx, sy);
  return { width, height, data };
}

export function invert(image: GrayImage): GrayImage {
  const data = new Uint8Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) data[i] = 255 - image.data[i]!;
  return { width: image.width, height: image.height, data };
}

/** Rotate about the centre with nearest-neighbour sampling: a genuinely skewed capture, not a relabelled one. */
export function rotate(image: GrayImage, radians: number): GrayImage {
  const { width, height } = image;
  const data = new Uint8Array(width * height).fill(PAPER);
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sourceX = Math.round(cx + dx * cos - dy * sin);
      const sourceY = Math.round(cy + dx * sin + dy * cos);
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
      data[y * width + x] = image.data[sourceY * width + sourceX]!;
    }
  }
  return { width, height, data };
}
