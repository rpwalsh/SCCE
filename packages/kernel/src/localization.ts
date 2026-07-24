import type { JsonValue } from "./types.js";

export type LocaleId = string;
export type MessageKey = string;
export type MessageVars = Record<string, string | number | boolean | null | undefined>;
export type MessageBundle = Record<string, string>;

const DEFAULT_LOCALE: LocaleId = "und";
const BUNDLES: Record<string, MessageBundle> = {
  [DEFAULT_LOCALE]: {}
};

export function registerMessageBundle(locale: LocaleId, bundle: MessageBundle): void {
  BUNDLES[normalizeLocale(locale)] = { ...(BUNDLES[normalizeLocale(locale)] ?? {}), ...bundle };
}

export function localeFromMetadata(metadata: JsonValue | undefined, text = ""): LocaleId {
  void text;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return DEFAULT_LOCALE;
  const record = metadata as Record<string, JsonValue>;
  for (const key of ["locale", "language", "languageTag", "uiLocale", "responseLocale"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return normalizeLocale(value);
  }
  return DEFAULT_LOCALE;
}

export function formatSurfaceMessage(key: MessageKey, vars: MessageVars = {}, locale: LocaleId = DEFAULT_LOCALE): string {
  const template = BUNDLES[normalizeLocale(locale)]?.[String(key)] ?? BUNDLES[DEFAULT_LOCALE]?.[String(key)];
  if (template) return template.replace(/\{([A-Za-z0-9_.:-]+)\}/g, (_match, rawKey: string) => {
    const value = vars[rawKey];
    return value === undefined || value === null ? "" : String(value);
  });
  return "";
}

function normalizeLocale(locale: LocaleId): LocaleId {
  const clean = String(locale || DEFAULT_LOCALE).trim().toLocaleLowerCase();
  return clean.split(/[-_]/u)[0] || DEFAULT_LOCALE;
}

export function validationMessageKey(key: MessageKey): string {
  return `i18n:${String(key)}`;
}

export function containsUnresolvedSurfaceKey(text: string): boolean {
  return text.includes("[scce:") ||
    text.includes("i18n:") ||
    text.includes("surface.") ||
    text.includes("mouth.") ||
    text.includes("workspace.kernel.");
}
