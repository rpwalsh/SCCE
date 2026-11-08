// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export type NativeProgramType = { kind: "unit" | "any" | "bool" | "string"; text: string }
  | { kind: "integer"; text: string; signed: boolean; bits?: number }
  | { kind: "float"; text: string; bits: 32 | 64 }
  | { kind: "optional" | "reference" | "sequence"; text: string; element: NativeProgramType }
  | { kind: "mapping"; text: string; key: NativeProgramType; value: NativeProgramType };

/** These are native grammar types, never types inferred from observed example values. */
export function nativeProgramType(language: "go" | "rust", source: string | undefined): NativeProgramType | undefined {
  if (source === undefined || source.trim() === "()") return { kind: "unit", text: language === "go" ? "" : "()" };
  const text = source.replace(/\s+/gu, "");
  if (language === "go") {
    if (text === "any" || text === "interface{}") return { kind: "any", text: source };
    if (text === "string") return { kind: "string", text: source };
    if (text === "bool") return { kind: "bool", text: source };
    if (/^(?:u?int(?:8|16|32|64)?|byte|rune)$/u.test(text)) {
      const bits = text === "byte" ? 8 : text === "rune" ? 32 : Number(text.match(/[0-9]+$/u)?.[0]) || undefined;
      return { kind: "integer", text: source, signed: !text.startsWith("u") && text !== "byte", ...(bits ? { bits } : {}) };
    }
    if (text === "float32" || text === "float64") return { kind: "float", text: source, bits: text === "float32" ? 32 : 64 };
    if (text.startsWith("*")) { const element = nativeProgramType(language, text.slice(1)); return element ? { kind: "optional", text: source, element } : undefined; }
    if (text.startsWith("[]")) { const element = nativeProgramType(language, text.slice(2)); return element ? { kind: "sequence", text: source, element } : undefined; }
    if (text.startsWith("map[")) {
      const close = balancedEnd(text, 3, "[", "]");
      const key = close === undefined ? undefined : nativeProgramType(language, text.slice(4, close)), value = close === undefined ? undefined : nativeProgramType(language, text.slice(close + 1));
      return key && value ? { kind: "mapping", text: source, key, value } : undefined;
    }
    return undefined;
  }
  if (text === "bool") return { kind: "bool", text: source };
  if (text === "str" || text === "String" || text === "::std::string::String" || text === "std::string::String") return { kind: "string", text: source };
  if (/^[iu](?:8|16|32|64|128|size)$/u.test(text)) return { kind: "integer", text: source, signed: text[0] === "i", ...(text.endsWith("size") ? {} : { bits: Number(text.slice(1)) }) };
  if (text === "f32" || text === "f64") return { kind: "float", text: source, bits: text === "f32" ? 32 : 64 };
  if (text.startsWith("&") && !text.startsWith("&mut") && !text.startsWith("&'")) { const element = nativeProgramType(language, text.slice(1)); return element ? { kind: "reference", text: source, element } : undefined; }
  const open = text.indexOf("<");
  if (open < 1 || balancedEnd(text, open, "<", ">") !== text.length - 1) return undefined;
  const name = text.slice(0, open), args = splitTypeArguments(text.slice(open + 1, -1));
  const normalized = name.replace(/^::/u, "");
  if (["Option", "std::option::Option", "Vec", "std::vec::Vec"].includes(normalized) && args.length === 1) {
    const element = nativeProgramType(language, args[0]);
    return element ? { kind: normalized.endsWith("Option") ? "optional" : "sequence", text: source, element } : undefined;
  }
  if (["BTreeMap", "std::collections::BTreeMap", "HashMap", "std::collections::HashMap"].includes(normalized) && args.length === 2) {
    const key = nativeProgramType(language, args[0]), value = nativeProgramType(language, args[1]);
    return key && value ? { kind: "mapping", text: source, key, value } : undefined;
  }
  return undefined;
}
function balancedEnd(text: string, start: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let index = start; index < text.length; index++) { if (text[index] === open) depth++; else if (text[index] === close && --depth === 0) return index; }
  return undefined;
}
function splitTypeArguments(text: string): string[] {
  const out: string[] = []; let depth = 0, start = 0;
  for (let index = 0; index < text.length; index++) { if ("<[(".includes(text[index]!)) depth++; else if (">])".includes(text[index]!)) depth--; else if (text[index] === "," && depth === 0) { out.push(text.slice(start, index)); start = index + 1; } }
  out.push(text.slice(start)); return out;
}
