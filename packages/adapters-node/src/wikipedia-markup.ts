// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/** Adapter diagnostics, not a claim that arbitrary MediaWiki templates were expanded. */
export interface WikiNormalizationDiagnostics {
  unexpandedTemplateCount: number;
  unexpandedTemplates: string[];
  malformedConstructs: number;
}

export const WIKIPEDIA_SURFACE_TRANSFORM = "scce.wikipedia-text-surface.v2";

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

/** Pipes inside nested links/templates belong to that construct, not its parent. */
function argumentsOf(inner: string): string[] {
  const parts: string[] = [];
  let start = 0, templates = 0, links = 0;
  for (let i = 0; i < inner.length; i++) {
    const pair = inner.slice(i, i + 2);
    if (pair === "{{") { templates++; i++; }
    else if (pair === "}}" && templates) { templates--; i++; }
    else if (pair === "[[") { links++; i++; }
    else if (pair === "]]" && links) { links--; i++; }
    else if (inner[i] === "|" && !templates && !links) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));
  return parts;
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
