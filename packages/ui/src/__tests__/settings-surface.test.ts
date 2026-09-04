// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { renderWorkbench } from "../index.js";
import { UI_MESSAGES_EN_US } from "../locales.js";

describe("workbench settings and models surfaces", () => {
  it("renders the settings and models sections driven by the server schema", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('id="models-list"');
    expect(html).toContain('id="model-download"');
    expect(html).toContain("/api/settings");
    expect(html).toContain("/api/models");
  });

  it("sources every settings label from the locale table, never inline English in the markup", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    for (const key of ["side.settings", "side.settings.hint", "side.models", "side.models.download", "side.models.empty"]) {
      expect(UI_MESSAGES_EN_US[key as keyof typeof UI_MESSAGES_EN_US]).toBeTruthy();
      expect(html).toContain(UI_MESSAGES_EN_US[key as keyof typeof UI_MESSAGES_EN_US]);
    }
    // Field labels are looked up as settings.<key> at runtime from the same table.
    const fieldKeys = Object.keys(UI_MESSAGES_EN_US).filter(key => key.startsWith("settings."));
    expect(fieldKeys.length).toBeGreaterThanOrEqual(16);
    expect(html).toContain("I18N['settings.' + field.key]");
  });
});
