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

/**
 * A square-cell script: every character is several DISCONNECTED strokes inside one cell, the way CJK and Hangul
 * are built. Connected components over-segment this into strokes, so it is the fixture that says whether the eye
 * finds the cell lattice. Strokes are full-cell bars so no stroke is small enough to read as a speck, and a
 * character uses either horizontal or vertical bars, never both, because crossing bars would touch and merge.
 */
export const BLOCK_FONT: Record<string, readonly string[]> = {
  H: ["#######", ".......", ".......", "#######", ".......", ".......", "#######"],
  E: ["#..#..#", "#..#..#", "#..#..#", "#..#..#", "#..#..#", "#..#..#", "#..#..#"],
  L: ["#######", ".......", ".......", ".......", ".......", ".......", "#######"],
  O: ["#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#"],
  T: ["#######", ".......", ".......", "#######", ".......", ".......", "......."],
  W: ["#..#...", "#..#...", "#..#...", "#..#...", "#..#...", "#..#...", "#..#..."],
  R: [".......", ".......", ".......", "#######", ".......", ".......", "#######"],
  D: ["..#...#", "..#...#", "..#...#", "..#...#", "..#...#", "..#...#", "..#...#"]
};

/**
 * A joined script: every letter hangs from a full-width headline and the letters are set with no gap, so the
 * headlines run together and a whole word arrives as ONE connected component -- what Devanagari does with its
 * shirorekha and Arabic does along its baseline. This is the fixture that says whether the eye can cut a joined
 * word into its letters. Rendered with letterGap 0.
 */
export const JOINED_FONT: Record<string, readonly string[]> = {
  H: ["#####", "#....", "#....", "#....", "#....", "#....", "#...."],
  E: ["#####", "....#", "....#", "....#", "....#", "....#", "....#"],
  L: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  O: ["#####", "#...#", "#...#", "#...#", "#...#", "#...#", "#...#"],
  T: ["#####", "#.#..", "#.#..", "#.#..", "#.#..", "#.#..", "#.#.."],
  W: ["#####", "..#.#", "..#.#", "..#.#", "..#.#", "..#.#", "..#.#"],
  R: ["#####", "#....", "#....", "###..", "..#..", "..#..", "..#.."],
  D: ["#####", "....#", "....#", "..###", "..#..", "..#..", "..#.."]
};

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
  /** Space between letters in font pixels; 0 sets the script solid, so joined letters touch. */
  readonly letterGap?: number;
  /** Vertical offset in font pixels at a given position along the line: a baseline that is not straight. */
  readonly curve?: (along: number) => number;
}

/** Render lines of space-separated words as a grayscale page, plus isolated single-pixel specks. */
export function renderTextPage(lines: readonly string[], specks: readonly [number, number][] = []): GrayImage {
  return renderTextPageWith(FONT, lines, specks);
}

/** As renderTextPage, with the glyph shapes supplied: a different font, or the same font reflected. */
export function renderTextPageWith(
  font: Record<string, readonly string[]>,
  lines: readonly string[],
  specks: readonly [number, number][] = [],
  letterGap = LETTER_GAP
): GrayImage {
  return renderMixedPage(lines.map(text => ({ text, font, letterGap })), specks);
}

/** A page whose lines are carved in different hands: mixed reading direction, or two scripts at once. */
export function renderMixedPage(
  lines: readonly RenderedLine[],
  specks: readonly [number, number][] = []
): GrayImage {
  const sizeOf = (font: Record<string, readonly string[]>) => {
    const glyph = Object.values(font)[0]!;
    return { width: glyph[0]!.length, height: glyph.length };
  };
  const columns = Math.max(...lines.map(({ text, font, letterGap = LETTER_GAP }) => {
    const words = text.split(" ");
    const letters = words.reduce((total, word) => total + word.length, 0);
    return letters * sizeOf(font).width + (letters - words.length) * letterGap + (words.length - 1) * WORD_GAP;
  }));
  const rows = lines.reduce((total, line) => total + sizeOf(line.font).height, 0)
    + (lines.length - 1) * LINE_GAP;
  const width = (columns + 2 * MARGIN) * SCALE;
  const height = (rows + 2 * MARGIN) * SCALE;
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

  let top = MARGIN;
  lines.forEach(({ text, font, letterGap = LETTER_GAP, curve }, lineIndex) => {
    if (lineIndex > 0) top += LINE_GAP;
    const size = sizeOf(font);
    let cursor = MARGIN;
    text.split(" ").forEach((word, wordIndex) => {
      if (wordIndex > 0) cursor += WORD_GAP;
      [...word].forEach((character, characterIndex) => {
        if (characterIndex > 0) cursor += letterGap;
        const glyph = font[character]!;
        const lift = curve ? Math.round(curve(cursor)) : 0;
        glyph.forEach((row, ry) => [...row].forEach((cell, rx) => {
          if (cell === "#") plot(cursor + rx, top + lift + ry);
        }));
        cursor += size.width;
      });
    });
    top += size.height;
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

/**
 * A synthetic language over the fixture alphabet: frequencies skewed the way real languages are skewed, so some
 * ranks are genuinely distinguishable and others are not, and an asymmetric transition structure, so direction
 * carries information and every symbol has its own structural fingerprint.
 */
export function syntheticLanguage(seed: number): number[][] {
  const size = ALPHABET.length;
  const random = uniform(seed);
  const weights: number[][] = [];
  for (let i = 0; i < size; i++) {
    const row: number[] = [];
    for (let j = 0; j < size; j++) row.push((1 / (j + 1)) * (0.3 + 0.7 * random()));
    weights.push(row);
  }
  return weights;
}

export function sampleWords(weights: readonly number[][], seed: number, wordCount: number): string[] {
  const random = uniform(seed);
  const size = ALPHABET.length;
  const words: string[] = [];
  let previous = 0;
  for (let w = 0; w < wordCount; w++) {
    const length = 3 + Math.floor(random() * 4);
    let word = "";
    for (let k = 0; k < length; k++) {
      const row = weights[previous]!;
      const total = row.reduce((a, b) => a + b, 0);
      let pick = random() * total;
      let next = size - 1;
      for (let j = 0; j < size; j++) {
        pick -= row[j]!;
        if (pick <= 0) {
          next = j;
          break;
        }
      }
      word += ALPHABET[next]!;
      previous = next;
    }
    words.push(word);
  }
  return words;
}

export function bigramsOf(words: readonly string[]): { previous: string; next: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const word of words) {
    for (let i = 1; i < word.length; i++) {
      const key = `${word[i - 1]}\u0000${word[i]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(([key, count]) => {
    const parts = key.split("\u0000");
    return { previous: parts[0]!, next: parts[1]!, count };
  });
}

export function frequenciesOf(words: readonly string[]): { symbol: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const word of words) for (const ch of word) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([symbol, count]) => ({ symbol, count }));
}

/** Wrap words into lines of a fixed count. */
export function wrapWords(words: readonly string[], perLine: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += perLine) lines.push(words.slice(i, i + perLine).join(" "));
  return lines;
}

/** 1 minus normalised edit distance: a single split mark costs one insertion, not the whole reading. */
export function editSimilarity(a: readonly string[], b: readonly string[]): number {
  const m = a.length;
  const n = b.length;
  if (!m && !n) return 1;
  let previous = Array.from({ length: n + 1 }, (_, j) => j);
  let current = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return 1 - previous[n]! / Math.max(m, n);
}

/**
 * The same page written along a curve, as a hand drifts or a spray can follows the arm. The amplitude is given
 * in font pixels, so an amplitude near the glyph height is a bend that breaks straight-line band finding.
 */
export function renderCurvedPage(
  lines: readonly string[],
  amplitude: number,
  period: number,
  font: Record<string, readonly string[]> = FONT
): GrayImage {
  const curve = (along: number) => amplitude * Math.sin((2 * Math.PI * along) / period);
  // Extra room above and below, so a bend does not run off the page.
  const padded = [`${" ".repeat(0)}`, ...lines, ""].filter((line, index) => index !== 0 || line.length > 0);
  return renderMixedPage((padded.length ? lines : lines).map(text => ({ text, font, curve })));
}
