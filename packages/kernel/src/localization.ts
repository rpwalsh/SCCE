import type { JsonValue } from "./types.js";

export type LocaleId = string;
export type MessageKey = string;
export type MessageVars = Record<string, string | number | boolean | null | undefined>;
export type MessageBundle = Record<string, string>;

const DEFAULT_LOCALE: LocaleId = "und";
const BUNDLES: Record<string, MessageBundle> = {
  [DEFAULT_LOCALE]: {
    "turn.insufficient_support": "Insufficient support.",
    "import.summary.graph_priors": "graph priors {count}",
    "import.summary.language_priors": "language priors {count}",
    "import.summary.program_priors": "program priors {count}",
    "import.summary.direct_evidence": "direct evidence {count}",
    "import.summary.unsupported": "unsupported {count}"
  }
};

export function registerMessageBundle(locale: LocaleId, bundle: MessageBundle): void {
  BUNDLES[normalizeLocale(locale)] = { ...(BUNDLES[normalizeLocale(locale)] ?? {}), ...bundle };
}

export function localeFromMetadata(metadata: JsonValue | undefined, text = ""): LocaleId {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return inferLocaleFromText(text) ?? DEFAULT_LOCALE;
  const record = metadata as Record<string, JsonValue>;
  for (const key of ["locale", "language", "languageTag", "uiLocale", "responseLocale"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return normalizeLocale(value);
  }
  return inferLocaleFromText(text) ?? DEFAULT_LOCALE;
}

export function formatSurfaceMessage(key: MessageKey, vars: MessageVars = {}, locale: LocaleId = DEFAULT_LOCALE): string {
  const template = BUNDLES[normalizeLocale(locale)]?.[String(key)] ?? BUNDLES[DEFAULT_LOCALE]?.[String(key)];
  if (template) return template.replace(/\{([A-Za-z0-9_.:-]+)\}/g, (_match, rawKey: string) => {
    const value = vars[rawKey];
    return value === undefined || value === null ? "" : String(value);
  });
  return opaqueMessageToken(String(key), vars);
}

function normalizeLocale(locale: LocaleId): LocaleId {
  const clean = String(locale || DEFAULT_LOCALE).trim().toLocaleLowerCase();
  return clean.split(/[-_]/u)[0] || DEFAULT_LOCALE;
}

function inferLocaleFromText(text: string): LocaleId | undefined {
  if (!text) return undefined;
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return "ja";
  if (/\p{Script=Han}/u.test(text)) return "zh";
  if (/\p{Script=Arabic}/u.test(text)) return "ar";
  return undefined;
}

export function validationMessageKey(key: MessageKey): string {
  return `i18n:${String(key)}`;
}

export function containsUnresolvedSurfaceKey(text: string): boolean {
  const exposed = text.replace(/\[scce:[^\]]+\]/gu, "");
  return exposed.includes("i18n:") ||
    exposed.includes("surface.") ||
    exposed.includes("mouth.") ||
    exposed.includes("workspace.kernel.");
}

function opaqueMessageToken(key: string, vars: MessageVars): string {
  const entries = Object.entries(vars)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => `${name}=${String(value)}`);
  return entries.length ? `[scce:${key} ${entries.join(" ")}]` : `[scce:${key}]`;
}
