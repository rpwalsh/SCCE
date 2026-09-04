// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { isLoopbackHostname } from "@scce/kernel";

/**
 * The one settings schema every surface (CLI, VS Code, workbench, server) reads and
 * writes through, so keys, labels and validation never drift between copies.
 * Labels here are the canonical English source; the workbench renders through its
 * locale table keyed by `settings.<key>`.
 */
export interface SettingsField {
  key: string;
  label: string;
  kind: "string" | "boolean" | "choice" | "number";
  choices?: string[];
  validate?: (value: string) => string | undefined;
}

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  { key: "realization.provider", label: "Realization provider", kind: "choice", choices: ["native", "ollama", "api"] },
  { key: "realization.ollama.host", label: "Ollama host (loopback only)", kind: "string", validate: value => { try { return isLoopbackHostname(new URL(value).hostname) ? undefined : "must be a loopback host"; } catch { return "must be a URL"; } } },
  { key: "realization.ollama.model", label: "Ollama model", kind: "string" },
  { key: "realization.apiProvider.endpoint", label: "API endpoint (https)", kind: "string", validate: value => value.toLocaleLowerCase().startsWith("https://") ? undefined : "must be https" },
  { key: "realization.apiProvider.model", label: "API model", kind: "string" },
  { key: "realization.apiProvider.apiKeyEnv", label: "Env var holding the API key (never stored in config; must start with SCCE_)", kind: "string", validate: value => /^SCCE_[A-Z0-9_]+$/u.test(value) ? undefined : "must be an env var name starting with SCCE_" },
  { key: "realization.apiProvider.acknowledgeRemoteDataExposure", label: "Acknowledge that evidence leaves this device when the API provider is used", kind: "boolean" },
  { key: "realization.constrainedDecoding.enabled", label: "Enable local constrained-decoding realizer", kind: "boolean" },
  { key: "realization.constrainedDecoding.modelId", label: "Constrained-decoding model id", kind: "string" },
  { key: "realization.constrainedDecoding.modelDir", label: "Local model directory", kind: "string" },
  { key: "ingestion.visual.embeddings.enabled", label: "Enable image / PDF-page visual embeddings", kind: "boolean" },
  { key: "ingestion.visual.embeddings.modelId", label: "Visual embedding model id", kind: "string" },
  { key: "ingestion.visual.embeddings.modelDir", label: "Visual model directory", kind: "string" },
  { key: "ingestion.observation.workspaceAutoIngest", label: "Ingest the opened workspace automatically (consented by opening it)", kind: "boolean" },
  { key: "ingestion.observation.screen", label: "Observe screen contents beyond the workspace (opt-in, logged while active)", kind: "boolean" },
  { key: "ingestion.observation.otherApplications", label: "Observe other running applications (opt-in, logged while active)", kind: "boolean" }
];

export function settingsFieldByKey(key: string): SettingsField | undefined {
  return SETTINGS_FIELDS.find(field => field.key === key);
}

export function coerceSettingValue(field: SettingsField, raw: string): unknown {
  if (field.kind === "boolean") return /^(y|yes|true|1|on)$/iu.test(raw.trim());
  if (field.kind === "number") return Number(raw);
  if (field.kind === "choice" && !field.choices!.includes(raw.trim())) throw new Error(`${field.key} must be one of ${field.choices!.join(", ")}`);
  return raw.trim();
}

export function getSettingPath(target: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), target);
}

export function setSettingPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof current[key] !== "object" || current[key] === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

/** Validates then applies one setting to a raw config object; returns the coerced value. */
export function applySetting(raw: Record<string, unknown>, key: string, rawValue: string): unknown {
  const field = settingsFieldByKey(key);
  if (!field) throw new Error(`unknown setting ${key}`);
  const value = coerceSettingValue(field, rawValue);
  const problem = field.validate?.(String(value));
  if (problem) throw new Error(`${key}: ${problem}`);
  setSettingPath(raw, key, value);
  return value;
}

/** Surface-safe view of current settings. Config holds no secrets by design (keys live in env vars). */
export function settingsView(raw: Record<string, unknown>): Array<{ key: string; label: string; kind: SettingsField["kind"]; choices?: string[]; value: unknown }> {
  return SETTINGS_FIELDS.map(field => ({ key: field.key, label: field.label, kind: field.kind, ...(field.choices ? { choices: field.choices } : {}), value: getSettingPath(raw, field.key) ?? null }));
}
