// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { renderWorkbench } from "../index.js";

describe("workbench settings and models surfaces", () => {
  it("renders the settings and models sections driven by the server schema", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('id="models-list"');
    expect(html).toContain('id="model-download"');
    expect(html).toContain("/api/settings");
    expect(html).toContain("/api/models");
  });

  it("labels every settings surface with its own id and every field with the server's key", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    for (const id of ["side.settings", "side.settings.hint", "side.models", "side.models.download", "side.models.empty"]) {
      expect(html, `settings surface id ${id} is not rendered`).toContain(id);
    }
    // A field names itself by the key the server sent; no table stands between the schema and the row.
    expect(html).toContain("textContent = field.key");
    expect(html).not.toContain("I18N");
  });
});
