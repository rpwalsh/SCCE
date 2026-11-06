// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { renderWorkbench, WORKBENCH_MODEL_ROUTE } from "../index.js";
import { DEFAULT_COMMANDS } from "../workbench-model.js";

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
    const opening = '<script type="module">';
    for (const html of [
      renderWorkbench("http://127.0.0.1:3873", { benchmarkSuiteId: "scce.eval.frontier_broad_capability.v1" }),
      renderWorkbench("", { staticConnector: true })
    ]) {
      const body = html.slice(html.indexOf(opening) + opening.length, html.indexOf("</script>"));
      // The page is one module: strip its single import so the body can be parsed as a plain function body here.
      const withoutImport = body.replace(/^\s*import\s+\{[^}]*\}\s+from\s+'[^']*';/m, "");
      expect(() => new Function(withoutImport)).not.toThrow();
    }
  });

  it("loads the workbench model as a module rather than restating it in the page", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain(`from '${WORKBENCH_MODEL_ROUTE}'`);
    expect(html).toContain("createInitialWorkbenchState(");
    expect(html).toContain("const commands = workbench.commands;");
    expect(html).not.toContain("const map = {");
    for (const command of DEFAULT_COMMANDS) expect(html).not.toContain(`'${command.id}': '/api`);
  });

  it("resolves the exported static asset at both the site root and a nested Pages path", () => {
    const html = renderWorkbench("", { staticConnector: true });
    expect(html).toContain('from \'./ui/workbench-model.js\'');

    const modelUrl = "./ui/workbench-model.js";
    expect(new URL(modelUrl, "https://rpwalsh.com/").pathname).toBe("/ui/workbench-model.js");
    expect(new URL(modelUrl, "https://rpwalsh.com/scce/").pathname).toBe("/scce/ui/workbench-model.js");
  });

  it("renders the Pages shell with a loopback-only local connector and pinned-source build stream", () => {
    const html = renderWorkbench("", { staticConnector: true });
    expect(html).toContain('id="connector-origin"');
    expect(html).toContain('id="connector-token"');
    expect(html).toContain('id="build-source"');
    expect(html).toContain("/api/ingest/github?stream=1");
    expect(html).toContain("['127.0.0.1', 'localhost', '[::1]']");
    expect(html).toContain("localStorage.setItem('scce.localApiOrigin'");
    expect(html).not.toContain("SCCE_API_BEARER_TOKEN=");
  });

  it("gives the local workbench the same readable chrome and in-memory bearer connector", () => {
    const html = renderWorkbench("http://127.0.0.1:3874");
    for (const text of ["Connect runtime", "Connect your local brain", "Ask SCCE a question", "Send", "Runtime details", "Evidence", "Local API address", "API bearer token"]) {
      expect(html).toContain(text);
    }
    for (const key of ["chat.empty.title", "composer.placeholder", "button.send", "app.developer_panel"]) {
      expect(html).not.toContain(key);
    }
    expect(html).toContain('value="http://127.0.0.1:3874"');
    expect(html).toContain("['127.0.0.1', 'localhost', '[::1]']");
    expect(html).toContain("parsed.protocol !== 'http:'");
    expect(html).toContain("headers.set('authorization', 'Bearer ' + connectorToken)");
    expect(html).toContain("const response = await apiFetch('/api/ready')");
    expect(html).not.toContain("get('/api/ready')");
    expect(html).toContain("localStorage.setItem('scce.localApiOrigin'");
    expect(html).not.toMatch(/localStorage\.setItem\([^)]*(?:token|bearer)/iu);
    expect(html).toContain("connectorToken = ''");
    expect(html).toContain("document.getElementById('connector-token').value = ''");
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

  it("renders readable operator chrome independent of trained language memory", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    for (const text of ["Workspace", "Evidence", "Approvals", "Local settings", "Connect your local brain"]) {
      expect(html, `readable operator label ${text} is not rendered`).toContain(text);
    }
    // UI chrome is concise operator wording and never renders a message table or engine-language model.
    expect(html).not.toContain("I18N");
    expect(html).toContain('<html lang="und">');
  });

  it("drives the command palette from the command's own id, not a translated label", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).not.toContain("i18n:");
    for (const command of DEFAULT_COMMANDS) expect(command.label.startsWith("cmd.")).toBe(true);
  });
});
