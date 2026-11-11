// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/** Adapter diagnostics, not a claim that arbitrary MediaWiki templates were expanded. */
export interface WikiNormalizationDiagnostics {
  unexpandedTemplateCount: number;
  unexpandedTemplates: string[];
  malformedConstructs: number;
}

export const WIKIPEDIA_SURFACE_TRANSFORM = "scce.wikipedia-text-surface.v3";
export const WIKIPEDIA_LANGUAGE_SURFACE_TRANSFORM = "scce.wikipedia-language-surface.v1";

export type WikiMarkupSourceRoleName =
  | "gallery-syntax"
  | "gallery-filename"
  | "gallery-caption"
  | "media-link"
  | "table-apparatus"
  | "reference-apparatus";

/** A source-coordinate declaration for material that must not all enter the same prose-learning channel. */
export interface WikiMarkupSourceRole {
  role: WikiMarkupSourceRoleName;
  channel: "prose" | "structured" | "apparatus" | "unqualified";
  sourceCharStart: number;
  sourceCharEnd: number;
  /** The role projection is length-preserving, so these coordinates stay aligned with the source wikitext. */
  projectedCharStart: number;
  projectedCharEnd: number;
}

export interface WikiMarkupFigure {
  id: string;
  caption?: string;
  origin: "gallery" | "media-link";
  sourceCharStart: number;
  sourceCharEnd: number;
  filenameCharStart: number;
  filenameCharEnd: number;
  captionCharStart?: number;
  captionCharEnd?: number;
}

export interface WikiMarkupTable {
  id: string;
  label?: string;
  rows: number;
  sourceCharStart: number;
  sourceCharEnd: number;
}

export interface WikiMarkupRoleProjection {
  /** Wikitext for prose learning. Canonical/evidence text is not changed by this projection. */
  languageWikitext: string;
  roles: WikiMarkupSourceRole[];
  figures: WikiMarkupFigure[];
  tables: WikiMarkupTable[];
  roleCounts: Record<string, number>;
  malformedConstructs: number;
}

function balancedEnd(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start + open.length; i < text.length; i++) {
    if (text.startsWith(open, i)) { depth++; i += open.length - 1; }
    else if (text.startsWith(close, i)) {
      if (--depth === 0) return i;
      i += close.length - 1;
    }
  }
  return -1;
}

interface MarkupArgumentRange {
  text: string;
  start: number;
  end: number;
}

/** Pipes inside nested links/templates belong to that construct, not its parent. */
function argumentRanges(inner: string, sourceOffset = 0): MarkupArgumentRange[] {
  const parts: MarkupArgumentRange[] = [];
  let start = 0, templates = 0, links = 0;
  for (let i = 0; i < inner.length; i++) {
    const pair = inner.slice(i, i + 2);
    if (pair === "{{") { templates++; i++; }
    else if (pair === "}}" && templates) { templates--; i++; }
    else if (pair === "[[") { links++; i++; }
    else if (pair === "]]" && links) { links--; i++; }
    else if (inner[i] === "|" && !templates && !links) {
      parts.push({ text: inner.slice(start, i), start: sourceOffset + start, end: sourceOffset + i });
      start = i + 1;
    }
  }
  parts.push({ text: inner.slice(start), start: sourceOffset + start, end: sourceOffset + inner.length });
  return parts;
}

function argumentsOf(inner: string): string[] {
  return argumentRanges(inner).map(part => part.text);
}

/**
 * Classify source markup before prose learning. The returned language wikitext has exactly the same UTF-16
 * length and line breaks as the source. Only a gallery's syntax and filename are blanked: that role has a
 * durable typed figure route. Tables and references are declared but left to the established evidence
 * normalizer until their semantic cells/citations have an equally complete typed route.
 */
export function projectWikiMarkupRoles(input: string): WikiMarkupRoleProjection {
  const galleryMask = new Uint8Array(input.length);
  const captionRetain = new Uint8Array(input.length);
  const roles: WikiMarkupSourceRole[] = [];
  const figures: WikiMarkupFigure[] = [];
  const tables: WikiMarkupTable[] = [];
  let malformedConstructs = 0;

  const role = (name: WikiMarkupSourceRoleName, channel: WikiMarkupSourceRole["channel"], start: number, end: number) => {
    if (end <= start) return;
    roles.push({ role: name, channel, sourceCharStart: start, sourceCharEnd: end,
      projectedCharStart: start, projectedCharEnd: end });
  };
  const maskGallery = (start: number, end: number) => galleryMask.fill(1, Math.max(0, start), Math.min(input.length, end));
  const retainCaption = (start: number, end: number) => captionRetain.fill(1, Math.max(0, start), Math.min(input.length, end));

  let cursor = 0;
  while (cursor < input.length) {
    const start = openingTag(input, "gallery", cursor);
    if (start < 0) break;
    const openEnd = markupTagEnd(input, start);
    if (openEnd < 0) { malformedConstructs++; break; }
    const closeStart = indexOfIgnoreCase(input, "</gallery>", openEnd + 1);
    if (closeStart < 0) {
      // Do not swallow an article tail because one structural tag is malformed.
      maskGallery(start, openEnd + 1);
      role("gallery-syntax", "apparatus", start, openEnd + 1);
      malformedConstructs++;
      cursor = openEnd + 1;
      continue;
    }
    const closeEnd = closeStart + "</gallery>".length;
    maskGallery(start, closeEnd);
    role("gallery-syntax", "apparatus", start, openEnd + 1);
    role("gallery-syntax", "apparatus", closeStart, closeEnd);

    for (const line of sourceLines(input, openEnd + 1, closeStart)) {
      const content = trimmedRange(input, line.start, line.end);
      if (!content) continue;
      const parts = argumentRanges(input.slice(content.start, content.end), content.start);
      const filenamePart = trimmedArgument(parts[0]);
      if (!filenamePart) continue;
      const id = filenamePart.text.replace(/^(?:file|image)\s*:/iu, "").trim();
      if (!id) continue;
      role("gallery-filename", "structured", filenamePart.start, filenamePart.end);

      let caption: MarkupArgumentRange | undefined;
      for (let index = parts.length - 1; index >= 1; index--) {
        const candidate = trimmedArgument(parts[index]);
        if (!candidate || mediaOption(candidate.text)) continue;
        caption = candidate;
        break;
      }
      if (caption) {
        retainCaption(caption.start, caption.end);
        role("gallery-caption", "prose", caption.start, caption.end);
      }
      figures.push({
        id,
        ...(caption ? { caption: caption.text, captionCharStart: caption.start, captionCharEnd: caption.end } : {}),
        origin: "gallery",
        sourceCharStart: content.start,
        sourceCharEnd: content.end,
        filenameCharStart: filenamePart.start,
        filenameCharEnd: filenamePart.end
      });
    }
    cursor = closeEnd;
  }

  // Ordinary MediaWiki file links are already omitted by renderWikiLinks. Publish their identity through the
  // same structured figure route instead of turning a filename into free prose.
  cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf("[[", cursor);
    if (start < 0) break;
    const end = balancedEnd(input, start, "[[", "]]");
    if (end < 0) break;
    const parts = argumentRanges(input.slice(start + 2, end), start + 2);
    const target = trimmedArgument(parts[0]);
    if (target && /^(?:file|image)\s*:/iu.test(target.text)) {
      const id = target.text.replace(/^(?:file|image)\s*:/iu, "").trim();
      const caption = [...parts.slice(1)].reverse().map(trimmedArgument)
        .find((part): part is MarkupArgumentRange => Boolean(part && !mediaOption(part.text)));
      role("media-link", "structured", start, end + 2);
      figures.push({
        id,
        ...(caption ? { caption: caption.text, captionCharStart: caption.start, captionCharEnd: caption.end } : {}),
        origin: "media-link",
        sourceCharStart: start,
        sourceCharEnd: end + 2,
        filenameCharStart: target.start,
        filenameCharEnd: target.end
      });
    }
    cursor = end + 2;
  }

  cursor = 0;
  while (cursor < input.length) {
    const start = nextLineMarker(input, "{|", cursor);
    if (start < 0) break;
    const end = balancedTableEnd(input, start);
    if (end < 0) { malformedConstructs++; cursor = start + 2; continue; }
    const body = input.slice(start, end);
    const caption = /^\s*\|\+\s*(.+?)\s*$/mu.exec(body);
    const rows = [...body.matchAll(/^\s*\|-.*$/gmu)].length + 1;
    role("table-apparatus", "unqualified", start, end);
    tables.push({ id: `wiki-table:${start}`, ...(caption?.[1] ? { label: caption[1] } : {}), rows,
      sourceCharStart: start, sourceCharEnd: end });
    cursor = end;
  }

  cursor = 0;
  while (cursor < input.length) {
    const start = openingTag(input, "ref", cursor);
    if (start < 0) break;
    const openEnd = markupTagEnd(input, start);
    if (openEnd < 0) { malformedConstructs++; break; }
    const opening = input.slice(start, openEnd + 1);
    if (/\/\s*>$/u.test(opening)) {
      role("reference-apparatus", "unqualified", start, openEnd + 1);
      cursor = openEnd + 1;
      continue;
    }
    const closeStart = indexOfIgnoreCase(input, "</ref>", openEnd + 1);
    const end = closeStart < 0 ? openEnd + 1 : closeStart + "</ref>".length;
    role("reference-apparatus", "unqualified", start, end);
    if (closeStart < 0) malformedConstructs++;
    cursor = end;
  }

  const projected = input.split("");
  for (let index = 0; index < projected.length; index++) {
    if (!galleryMask[index] || captionRetain[index]) continue;
    if (projected[index] !== "\n" && projected[index] !== "\r") projected[index] = " ";
  }
  roles.sort((left, right) => left.sourceCharStart - right.sourceCharStart || left.sourceCharEnd - right.sourceCharEnd);
  figures.sort((left, right) => left.sourceCharStart - right.sourceCharStart);
  const roleCounts: Record<string, number> = {};
  for (const item of roles) roleCounts[item.role] = (roleCounts[item.role] ?? 0) + 1;
  return { languageWikitext: projected.join(""), roles, figures, tables, roleCounts, malformedConstructs };
}

function trimmedArgument(part: MarkupArgumentRange | undefined): MarkupArgumentRange | undefined {
  if (!part) return undefined;
  const leading = /^\s*/u.exec(part.text)?.[0].length ?? 0;
  const trailing = /\s*$/u.exec(part.text)?.[0].length ?? 0;
  const end = part.end - trailing;
  const start = part.start + leading;
  return end > start ? { text: part.text.slice(leading, part.text.length - trailing), start, end } : undefined;
}

/** Attribute-shaped fields are syntax, independent of the language used in their values. */
function mediaOption(value: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_-]*\s*=/u.test(value) || /^\d+(?:x\d+)?px$/iu.test(value);
}

function sourceLines(input: string, start: number, end: number): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const newline = input.indexOf("\n", cursor);
    const lineEnd = newline < 0 || newline > end ? end : newline;
    lines.push({ start: cursor, end: lineEnd });
    cursor = lineEnd + 1;
  }
  return lines;
}

function trimmedRange(input: string, start: number, end: number): { start: number; end: number } | undefined {
  while (start < end && /\s/u.test(input[start]!)) start++;
  while (end > start && /\s/u.test(input[end - 1]!)) end--;
  return end > start ? { start, end } : undefined;
}

function openingTag(input: string, name: string, from: number): number {
  let cursor = from;
  while (cursor < input.length) {
    const start = indexOfIgnoreCase(input, `<${name}`, cursor);
    if (start < 0) return -1;
    const boundary = input[start + name.length + 1];
    if (boundary === undefined || /[\s/>]/u.test(boundary)) return start;
    cursor = start + name.length + 1;
  }
  return -1;
}

function markupTagEnd(input: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ">") return index;
    if (char === "<") return -1;
  }
  return -1;
}

function indexOfIgnoreCase(input: string, needle: string, from: number): number {
  return input.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase(), from);
}

function nextLineMarker(input: string, marker: string, from: number): number {
  let cursor = from;
  while (cursor < input.length) {
    const found = input.indexOf(marker, cursor);
    if (found < 0) return -1;
    const lineStart = input.lastIndexOf("\n", found - 1) + 1;
    if (/^[ \t]*$/u.test(input.slice(lineStart, found))) return found;
    cursor = found + marker.length;
  }
  return -1;
}

function balancedTableEnd(input: string, start: number): number {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < input.length) {
    const open = nextLineMarker(input, "{|", cursor);
    const close = nextLineMarker(input, "|}", cursor);
    if (close < 0) return -1;
    if (open >= 0 && open < close) { depth++; cursor = open + 2; continue; }
    if (--depth === 0) return close + 2;
    cursor = close + 2;
  }
  return -1;
}

export function renderWikiLinks(input: string, diagnostics?: WikiNormalizationDiagnostics, depth = 0): string {
  if (depth > 64) { if (diagnostics) diagnostics.malformedConstructs++; return ""; }
  const out: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf("[[", cursor);
    if (start < 0) { out.push(input.slice(cursor)); break; }
    out.push(input.slice(cursor, start));
    const end = balancedEnd(input, start, "[[", "]]");
    if (end < 0) {
      if (diagnostics) diagnostics.malformedConstructs++;
      // Preserve the remaining source text instead of swallowing the article tail.
      out.push(input.slice(start + 2)); break;
    }
    const parts = argumentsOf(input.slice(start + 2, end));
    const target = parts[0]!.trim();
    // MediaWiki namespace syntax belongs to this source adapter, not the ontology.
    if (!/^(?:file|image|category)\s*:/iu.test(target)) {
      const label = parts.length > 1 ? parts.slice(1).join("|") : target.replace(/^:/u, "").replaceAll("_", " ");
      out.push(renderWikiLinks(label, diagnostics, depth + 1));
    }
    cursor = end + 2;
  }
  return out.join("");
}

function positionalArguments(parts: string[]): string[] {
  const values: string[] = [];
  let implicit = 0;
  for (const part of parts) {
    const explicit = /^\s*([1-9]\d*)\s*=([\s\S]*)$/u.exec(part);
    if (explicit) {
      const index = Number(explicit[1]) - 1;
      if (index < 128) values[index] = explicit[2]!.trim();
    } else if (!/^\s*[\w -]+=/u.test(part)) values[implicit++] = part.trim();
  }
  return values;
}

function inputQuantity(values: string[]): string | undefined {
  const numeric = /^[+−-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][+−-]?\d+|(?:\+\d+)?\/\d+)?$/u;
  if (!numeric.test(values[0] ?? "")) return undefined;
  let i = 1;
  const output = [values[0]!];
  while (/^(?:to|and|or|by|x|×|–|-|±|\+\/-|,)$/u.test(values[i] ?? "") && numeric.test(values[i + 1] ?? "")) {
    output.push(values[i]!, values[i + 1]!); i += 2;
  }
  const unit = values[i];
  if (!unit || !/^[\p{L}°%][\p{L}\p{N}°%²³/^·. −-]*$/u.test(unit)) return undefined;
  output.push(unit); i++;
  // Compound input quantities, e.g. 5 ft 8 in. Output units/rounding are not input measurements.
  while (numeric.test(values[i] ?? "") && /^[\p{L}°%][\p{L}\p{N}°%²³/^·. −-]*$/u.test(values[i + 1] ?? "")) {
    output.push(values[i]!, values[i + 1]!); i += 2;
  }
  return output.join(" ");
}

export function renderWikiTemplates(input: string, diagnostics?: WikiNormalizationDiagnostics, depth = 0): string {
  if (depth > 64) { if (diagnostics) diagnostics.malformedConstructs++; return ""; }
  const out: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf("{{", cursor);
    if (start < 0) { out.push(input.slice(cursor)); break; }
    out.push(input.slice(cursor, start));
    const end = balancedEnd(input, start, "{{", "}}");
    if (end < 0) {
      if (diagnostics) diagnostics.malformedConstructs++;
      out.push(input.slice(start + 2)); break;
    }
    const parts = argumentsOf(input.slice(start + 2, end));
    const name = parts.shift()!.trim().replace(/^template:/iu, "").toLowerCase().replaceAll("_", " ");
    const values = positionalArguments(parts);
    let rendered: string | undefined;
    if (name === "convert" || name === "cvt") rendered = inputQuantity(values);
    else if (["nowrap", "nobr", "small", "smaller", "larger", "big", "abbr"].includes(name)) rendered = values[0];
    else if (name === "lang") rendered = values[1];
    if (rendered !== undefined) out.push(renderWikiTemplates(rendered, diagnostics, depth + 1));
    else {
      if (diagnostics) {
        diagnostics.unexpandedTemplateCount++;
        if (diagnostics.unexpandedTemplates.length < 32 && !diagnostics.unexpandedTemplates.includes(name)) diagnostics.unexpandedTemplates.push(name.slice(0, 120));
      }
      out.push(" ");
    }
    cursor = end + 2;
  }
  return out.join("");
}

/** Decode once. XML &amp;lt; is literal wikitext &lt;, not a second XML tag. */
export function decodeWikiEntities(value: string, xmlOnly = false): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  if (!xmlOnly) Object.assign(named, { nbsp: " ", thinsp: " ", ndash: "–", mdash: "—", minus: "−", deg: "°", times: "×", divide: "÷", plusmn: "±", middot: "·", hellip: "…" });
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/giu, (original, key: string) => {
    if (!key.startsWith("#")) return named[key] ?? original;
    const point = /^#x/iu.test(key) ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original;
  });
}
