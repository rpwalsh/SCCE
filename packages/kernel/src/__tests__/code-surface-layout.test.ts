// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { codeIdentifierTokens, codeSurfaceTokens, codeTrainingSurface, codeTokenWhitespace, CODE_SOURCE_SYMBOL, renderCodeTokens } from "../code-surface.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";

const source = 'def 計算(値):\r\n\t# 日本語  comment\r\n\tif 値:\r\n\t\tcafe\u0301 = "a  b ⏎"\r\n\t\t𐐀値 = """first\n  second\n\tthird"""\r\n\t\treturn cafe\u0301\r\n\r\n\treturn "終"\r\n';

describe("observed formal source layout", () => {
  it("round-trips complete observed line structure, Unicode identifiers, comments and literals", () => {
    const tokens = codeSurfaceTokens(source);
    expect(renderCodeTokens(tokens)).toBe(source);
    expect(codeIdentifierTokens(tokens)).toContain("cafe\u0301");
    expect(codeIdentifierTokens(tokens)).toContain("𐐀値");
    expect(tokens.some(token => codeTokenWhitespace(token) === "\t\t")).toBe(true);
    expect(codeSurfaceTokens(codeTrainingSurface(source))).toEqual(tokens);
    expect(renderCodeTokens(codeSurfaceTokens("a+b;"))).toBe("a+b;");
  });

  it("does not interpret source text as serialized layout authority", () => {
    const text = CODE_SOURCE_SYMBOL + '\n⏎\n"\\u001ecode-whitespace:\\"    \\""';
    expect(renderCodeTokens(codeSurfaceTokens(text))).toBe(text);
  });

  it("replaces a repair target's base indentation once while retaining relative observed nesting", () => {
    expect(renderCodeTokens(codeSurfaceTokens("    if 値:\n        return 値"), "\t", "replace"))
      .toBe("\tif 値:\n\t    return 値");
  });

  it("reports an explicit finite lexical budget instead of silently training a source prefix", () => {
    expect(() => codeSurfaceTokens(source, 3)).toThrow("complete source");
    expect(() => codeTrainingSurface(source, 3)).toThrow("complete source");
    const long = "x;".repeat(100_001);
    expect(codeTrainingSurface(long)).toBe(long);
    expect(renderCodeTokens(codeSurfaceTokens(long))).toBe(long);
  });

  it("trains the same canonical formal compiler on the once-projected observed surface", () => {
    const hasher = createHasher();
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
    const sourceVersionId = ids.sourceVersionId(hasher.digestHex(source));
    const text = codeTrainingSurface(source);
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 });
    const memory = createLanguageMemoryRuntime({ idFactory: ids, hasher }).train({ streamId: "fixture://observed-code", sourceSystem: "oss_code",
      profile, sourceVersionId, text, evidence: [], createdAt: 1, maxOrder: 3 });
    expect(memory.observations.some(row => row.symbol === "cafe\u0301")).toBe(true);
    expect(memory.observations.some(row => codeTokenWhitespace(row.symbol) === "\t\t")).toBe(true);
    expect(memory.models).toHaveLength(1);
    expect(memory.models[0]!.modelJson).toHaveProperty("model.observedSymbolCount", codeSurfaceTokens(source).length);
  });
});
