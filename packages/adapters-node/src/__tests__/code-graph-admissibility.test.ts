import { describe, expect, it } from "vitest";
import { sourceFactsTextAdmissible } from "../code-graph.js";

describe("source-facts admissibility (OOM regression)", () => {
  it("never treats a fetched HTML page as source", () => {
    expect(sourceFactsTextAdmissible("text/html; charset=UTF-8", "<html><script>var a = 1;</script></html>")).toBe(false);
  });

  it("rejects other non-source text media", () => {
    for (const media of ["text/markdown", "text/csv", "text/xml", "text/calendar"]) {
      expect(sourceFactsTextAdmissible(media, "a, b, c")).toBe(false);
    }
  });

  it("admits real code media under the byte cap", () => {
    expect(sourceFactsTextAdmissible("text/javascript", "export const a = 1;")).toBe(true);
    expect(sourceFactsTextAdmissible("application/typescript", "export const a: number = 1;")).toBe(true);
  });

  it("rejects anything over 2MB regardless of media type", () => {
    const huge = "export const a = 1;\n".repeat(120000);
    expect(Buffer.byteLength(huge)).toBeGreaterThan(2 * 1024 * 1024);
    expect(sourceFactsTextAdmissible("text/javascript", huge)).toBe(false);
  });
});
