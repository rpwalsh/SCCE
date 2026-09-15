// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

/** A package segment, not a language taxonomy. Resolution remains local-only. */
const LOCAL_OCR_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export const DEFAULT_OCR_PROFILE = "eng";

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
