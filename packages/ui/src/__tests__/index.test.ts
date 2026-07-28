import { describe, expect, it } from "vitest";
import { renderWorkbench } from "../index.js";
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
