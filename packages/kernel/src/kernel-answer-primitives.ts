import { hasUncasedNonLatinLetter, hasUppercaseLetter, surfaceWords } from "./surface-linguistics.js";
import type { JsonValue } from "./types.js";




export function namedSubjectAnchors(text: string): string[] {
  return namedPriorSurfaceRuns(text)
    .map(normalizePriorKey)
    .filter(namedSourceAnchorSpecificEnough)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
}



 function namedSourceAnchorSpecificEnough(anchor: string): boolean {
  const units = splitPriorUnits(anchor);
  if (units.length >= 2) return true;
  return units.some(unit => [...unit].length >= 3 && !genericQuestionSignal(unit));
}



/**
 * Source-neutral request units shared by graph retrieval and question-slot
 * selection. Punctuation does not identify a language-independent question
 * operator, so every observed unit remains available to downstream scoring.
 *
 * @internal Exported for focused routing-invariant tests; it is not re-exported
 * from the package entrypoint.
 */
export function requestContentPriorUnits(text: string): string[] {
  return splitPriorUnits(normalizePriorKey(text));
}



/** @internal See {@link requestContentPriorUnits}. */
export function requestContentSurface(text: string): string {
  const words = splitPriorSurfaceWords(text);
  return words.join(" ") || text;
}



export function genericQuestionSignal(unit: string): boolean {
  if (!unit) return true;
  if (unit.length <= 2) return true;
  let letters = 0;
  let repeated = 0;
  let previous = "";
  for (const char of unit) {
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) letters++;
    if (char === previous) repeated++;
    previous = char;
  }
  return letters <= 1 || repeated / Math.max(1, unit.length - 1) > 0.72;
}



 function namedPriorSurfaceRuns(text: string): string[] {
  return uniqueKernelStrings(surfaceEntityRuns(text)).slice(0, 8);
}



 function splitPriorSurfaceWords(text: string): string[] {
  return surfaceWords(text);
  const out: string[] = [];
  let current = "";
  for (const char of text.normalize("NFKC")) {
    const symbol = char.toLocaleLowerCase() !== char.toLocaleUpperCase() || (char >= "0" && char <= "9") || char === "'" || char === "’";
    if (symbol) {
      current += char;
      continue;
    }
    if (current) out.push(current);
    current = "";
  }
  if (current) out.push(current);
  return out;
}



export function surfaceEntityRuns(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (
      current.length >= 2 ||
      current.some(hasUncasedNonLatinLetter) ||
      current.some(unit => hasPriorAnchorSignal(unit) && [...normalizePriorKey(unit)].length >= 4)
    ) out.push(current.join(" "));
    current = [];
  };
  for (const raw of surfaceWords(text)) {
    const word = stripOuterPriorSeparators(raw);
    if (!word) continue;
    if (hasPriorAnchorSignal(word) && splitPriorUnits(normalizePriorKey(word)).some(unit => unit.length >= 2)) {
      current.push(word);
      continue;
    }
    flush();
  }
  flush();
  return uniqueKernelStrings(out).slice(0, 32);
}



export function boundedEditDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}



export function kernelClamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}



export function hasPriorAnchorSignal(value: string): boolean {
  return hasUppercaseLetter(value) || hasUncasedNonLatinLetter(value);
}



export function stripOuterPriorSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isPriorSeparator(value[start] ?? "")) start++;
  while (end > start && isPriorSeparator(value[end - 1] ?? "")) end--;
  return value.slice(start, end).trim();
}



export function isPriorSeparator(char: string): boolean {
  return char === "\\" || char === "\"" || char === "'" || char === ":" || char === "," || char === "." || char === ";" || char === "?" || char === "!" || char === "{" || char === "}" || char === "[" || char === "]" || isPriorWhitespace(char);
}



export function collapsePriorWhitespace(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    out += char;
    pendingSpace = false;
  }
  return out.trim();
}



 function isPriorWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}



export function splitPriorUnits(value: string): string[] {
  const units: string[] = [];
  let current = "";
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      if (current) units.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) units.push(current);
  return units;
}



export function normalizePriorKey(value: string): string {
  return collapsePriorWhitespace(value.toLocaleLowerCase());
}



export function kernelString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}



export function kernelNumber(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}



export function kernelStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}



export function uniqueKernelStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}



export function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
