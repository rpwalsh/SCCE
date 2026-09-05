// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { renderWorkbench, WORKBENCH_MODEL_ROUTE } from "../index.js";
import { DEFAULT_COMMANDS } from "../workbench-model.js";
import { UI_MESSAGES_EN_US } from "../locales.js";

describe("renderWorkbench", () => {
  it("produces a single well-formed HTML document", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html.trim().startsWith("<!doctype html>")).toBe(true);
    expect(html.trim().endsWith("</html>")).toBe(true);
    expect((html.match(/<html/g) ?? []).length).toBe(1);
    expect((html.match(/<\/html>/g) ?? []).length).toBe(1);
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  it("keeps chat as the default, unhidden primary surface and the developer panel closed by default", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain('id="messages"');
    expect(html).toContain('id="prompt"');
    expect(html).toContain('id="send"');
    // devpanel only gets the "open" class via a later user click (dev-toggle) --
    // it must not ship pre-opened, since traces/inspector are meant to stay
    // secondary until the user asks for them.
    expect(html).not.toMatch(/class="devpanel open"/);
    expect(html).not.toMatch(/class="devpanel[^"]*\bopen\b/);
  });

  it("still exposes every element id the inline script depends on (approvals, inspector, terminal, trace, palette)", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    for (const id of [
      "messages", "messages-inner", "empty-state", "prompt", "send", "devpanel", "dev-toggle", "dev-close",
      "approvals-badge", "approval-list", "operator-grant-toggle", "refresh-approvals",
      "inspect", "inspect-json", "terminal", "trace", "palette", "palette-input", "palette-list"
    ]) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it("emits a page script the JavaScript engine can actually parse", () => {
    const html = renderWorkbench("http://127.0.0.1:3873", { benchmarkSuiteId: "scce.eval.frontier_broad_capability.v1" });
    const opening = '<script type="module">';
    const body = html.slice(html.indexOf(opening) + opening.length, html.indexOf("</script>"));
    // The page is one module: strip its single import so the body can be parsed as a plain function body here.
    const withoutImport = body.replace(/^\s*import\s+\{[^}]*\}\s+from\s+'[^']*';/m, "");
    expect(() => new Function(withoutImport)).not.toThrow();
  });

  it("loads the workbench model as a module rather than restating it in the page", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain(`from '${WORKBENCH_MODEL_ROUTE}'`);
    expect(html).toContain("createInitialWorkbenchState(");
    expect(html).toContain("const commands = workbench.commands;");
    expect(html).not.toContain("const map = {");
    for (const command of DEFAULT_COMMANDS) expect(html).not.toContain(`'${command.id}': '/api`);
  });

  it("keeps a hostile server origin inside the script string it is embedded in", () => {
    const html = renderWorkbench('http://127.0.0.1:3873"></script><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  it("escapes the server origin so it cannot break out of HTML attribute/text context", () => {
    const html = renderWorkbench('http://127.0.0.1:3873"><script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("resolves every uiText() key used in the template to a real message, not a raw key fallback", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    // uiText() falls back to returning the key itself when a message is
    // missing (see locales.ts) -- a leaked raw key like "app.developer_panel"
    // showing up as literal visible text would mean a typo'd lookup.
    for (const key of Object.keys(UI_MESSAGES_EN_US)) {
      if (key === "app.lang") continue;
      const looksLikeRawKeyLeak = new RegExp(`>${escapeRegExp(key)}<`).test(html);
      expect(looksLikeRawKeyLeak, `raw i18n key "${key}" leaked into rendered HTML`).toBe(false);
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
