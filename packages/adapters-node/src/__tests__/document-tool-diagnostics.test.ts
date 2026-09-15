// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { ScceRuntimeConfig } from "../config.js";
import { diagnoseExtractionTools } from "../document.js";

const withProfile = (profile?: string) => ({ runtime: { ocr: profile === undefined ? undefined : { profile } } }) as unknown as ScceRuntimeConfig;

describe("document extraction tool diagnostics", () => {
  it("reports OCR unavailable when the configured profile is not installed", async () => {
    const tools = await diagnoseExtractionTools(withProfile("scce-absent-profile"));
    const ocr = tools.find(tool => tool.name === "tesseract.js");
    expect(ocr?.ok).toBe(false);
    expect(ocr?.detail).toContain("scce-absent-profile");
  });

  it("reports the packaged default profile as installed", async () => {
    const tools = await diagnoseExtractionTools(withProfile());
    expect(tools.find(tool => tool.name === "tesseract.js")).toMatchObject({ ok: true });
  });

  it("names whether the OCR profile is configured or the packaged fallback", async () => {
    expect((await diagnoseExtractionTools(withProfile())).find(tool => tool.name === "tesseract.js")?.detail).toContain("(fallback_packaged_profile)");
    expect((await diagnoseExtractionTools(withProfile("eng"))).find(tool => tool.name === "tesseract.js")?.detail).toContain("(configured)");
  });
});
