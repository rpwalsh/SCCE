// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { renderWorkbench } from "../index.js";
import { programArtifactsFromTurn } from "../workbench-model.js";

describe("program artifact presentation contract", () => {
  it("accepts only the file set named by a ready response", () => {
    const turn = readyTurn();
    expect(programArtifactsFromTurn(turn)).toEqual(turn.programArtifacts);
  });

  it("rejects unready, incomplete, mismatched, and unsafe file sets", () => {
    const turn = readyTurn();
    expect(programArtifactsFromTurn({ ...turn, programReadiness: { ...turn.programReadiness, status: "not_ready" } })).toEqual([]);
    expect(programArtifactsFromTurn({ ...turn, programReadiness: { ...turn.programReadiness, artifactCount: 3 } })).toEqual([]);
    expect(programArtifactsFromTurn({ ...turn, programArtifacts: [{ ...turn.programArtifacts[0]!, path: "../outside.ts" }] })).toEqual([]);
    expect(programArtifactsFromTurn({ ...turn, programArtifacts: [{ ...turn.programArtifacts[0]!, artifactId: "artifact.foreign" }] })).toEqual([]);
  });

  it("renders validated source and tests as text and revokes generated download URLs", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain("link.textContent = artifact.path");
    expect(html).toContain("preview.textContent = artifact.content");
    expect(html).toContain("programArtifactsFromTurn(r).length > 0");
    expect(html).toContain("URL.revokeObjectURL(url)");
  });

  it("creates a fresh download URL on every click and releases each one", () => {
    const artifacts = readyTurn().programArtifacts;
    const scheduled: Array<() => void> = [];
    const created: Array<{ content: string; type: string }> = [];
    const revoked: string[] = [];
    let nextUrl = 0;
    const objectUrls = new Set<string>();
    const bubble = new FakeElement();
    const row = new FakeElement();
    row.querySelector = selector => selector === ".bubble" ? bubble : null;
    const render = runInNewContext(`(${renderedFunctionSource()})`, {
      programArtifactsFromTurn: () => artifacts,
      document: { createElement: () => new FakeElement() },
      URL: {
        createObjectURL: (blob: { content: string; type: string }) => {
          created.push(blob);
          const url = `blob:program-${++nextUrl}`;
          objectUrls.add(url);
          return url;
        },
        revokeObjectURL: (url: string) => { revoked.push(url); objectUrls.delete(url); }
      },
      Blob: class {
        readonly content: string;
        readonly type: string;
        constructor(parts: string[], options: { type: string }) { this.content = parts.join(""); this.type = options.type; }
      },
      setTimeout: (callback: () => void) => { scheduled.push(callback); return scheduled.length; },
      programArtifactUrls: objectUrls
    }) as (target: FakeElement, turn: unknown) => void;

    render(row, readyTurn());
    const link = bubble.children[0]!.children[0]!.children[0]!;
    expect(link.textContent).toBe("src/program.ts");
    expect(link.click()).toBe("blob:program-1");
    expect(objectUrls.has("blob:program-1")).toBe(true);
    scheduled.shift()!();
    expect(revoked).toEqual(["blob:program-1"]);
    expect(link.href).toBe("#");
    expect(link.click()).toBe("blob:program-2");
    expect(objectUrls.has("blob:program-2")).toBe(true);
    scheduled.shift()!();
    expect(revoked).toEqual(["blob:program-1", "blob:program-2"]);
    expect(objectUrls.size).toBe(0);
    expect(created).toEqual([{ content: artifacts[0]!.content, type: artifacts[0]!.mediaType }, { content: artifacts[0]!.content, type: artifacts[0]!.mediaType }]);
  });
});

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  href = "";
  download = "";
  textContent = "";
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();

  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  querySelector(_selector: string): FakeElement | null { return null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, handler: () => void): void { this.listeners.set(name, handler); }
  click(): string | undefined { this.listeners.get("click")?.(); return this.href; }
}

function renderedFunctionSource(): string {
  const html = renderWorkbench("http://127.0.0.1:3873");
  const opening = '<script type="module">';
  const script = html.slice(html.indexOf(opening) + opening.length, html.indexOf("</script>"));
  const start = script.indexOf("function renderProgramArtifacts(");
  if (start < 0) throw new Error("renderProgramArtifacts was not emitted");
  const bodyStart = script.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === "{") depth += 1;
    else if (script[index] === "}" && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error("renderProgramArtifacts function was not closed");
}

function readyTurn() {
  const programArtifacts = [
    { artifactId: "artifact.source", path: "src/program.ts", mediaType: "text/typescript", content: "export const value = 1;", contentHash: "sha256_source", role: "source" },
    { artifactId: "artifact.test", path: "test/program.test.ts", mediaType: "text/typescript", content: "if (value !== 1) throw new Error();", contentHash: "sha256_test", role: "test" }
  ];
  return {
    programReadiness: { schema: "scce.program.response_readiness.v1", status: "ready", reasonId: "program.readiness.verified", artifactCount: 2, artifactIds: programArtifacts.map(artifact => artifact.artifactId) },
    programArtifacts
  };
}
