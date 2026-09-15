// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/** A package segment, not a language taxonomy. Resolution remains local-only. */
const LOCAL_OCR_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export const DEFAULT_OCR_PROFILE = "eng";

export function assertOcrProfileId(value: string): string {
  if (!LOCAL_OCR_PROFILE.test(value)) throw new Error("OCR profile must be an opaque local package identifier");
  return value;
}
