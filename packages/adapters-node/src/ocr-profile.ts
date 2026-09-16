// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** A package segment, not a language taxonomy. Resolution remains local-only. */
const LOCAL_OCR_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;


export interface OcrProfileSelection { profile?: string; origin: "source" | "configured" | "fallback_packaged_profile" | "unconfigured"; installed?: string[] }

export function selectOcrProfile(source: string | undefined, configured: string | undefined): OcrProfileSelection {
  if (source !== undefined) return { profile: source, origin: "source" };
  if (configured !== undefined) return { profile: configured, origin: "configured" };
  // No profile is named in code: an unnamed profile resolves only when the installation leaves no choice.
  const installed = installedOcrProfiles();
  if (installed.length === 1) return { profile: installed[0]!, origin: "fallback_packaged_profile" };
  return { origin: "unconfigured", ...(installed.length ? { installed } : {}) };
}

/** The profiles this installation actually carries, discovered from the packaged data scope. */
export function installedOcrProfiles(): string[] {
  const found = new Set<string>();
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 16; depth++) { // cost bound: stop walking after 16 parent directories
    const scope = path.join(directory, "node_modules", "@tesseract.js-data");
    if (existsSync(scope)) {
      for (const entry of readdirSync(scope)) {
        if (!LOCAL_OCR_PROFILE.test(entry)) continue;
        try { resolveOcrProfile(entry); found.add(entry); } catch { /* the scope lists it, this installation does not carry its data */ }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...found].sort();
}

export function ocrProfileSelectionWarnings(selection: OcrProfileSelection): string[] {
  if (selection.origin === "fallback_packaged_profile") return [`ocr_profile:fallback_packaged_profile:${selection.profile}`];
  return selection.origin === "unconfigured" ? ["ocr_profile:unconfigured"] : [];
}

export function assertOcrProfileId(value: string): string {
  if (!LOCAL_OCR_PROFILE.test(value)) throw new Error("OCR profile must be an opaque local package identifier");
  return value;
}

export interface ResolvedOcrProfile { id: string; data: { code: string; gzip: boolean; langPath: string } }

export function resolveOcrProfile(id: string): ResolvedOcrProfile {
  assertOcrProfileId(id);
  let data: { code?: unknown; gzip?: unknown; langPath?: unknown };
  try {
    data = require(`@tesseract.js-data/${id}`) as { code?: unknown; gzip?: unknown; langPath?: unknown };
  } catch {
    throw new Error(`OCR profile is not locally packaged: ${id}`);
  }
  if (typeof data.code !== "string" || typeof data.gzip !== "boolean" || typeof data.langPath !== "string" || !path.isAbsolute(data.langPath))
    throw new Error(`OCR profile has invalid local package data: ${id}`);
  const dataPath = path.join(data.langPath, `${data.code}.traineddata${data.gzip ? ".gz" : ""}`);
  if (!existsSync(dataPath)) throw new Error(`OCR profile data is not locally installed: ${id}`);
  return { id, data: { code: data.code, gzip: data.gzip, langPath: data.langPath } };
}
