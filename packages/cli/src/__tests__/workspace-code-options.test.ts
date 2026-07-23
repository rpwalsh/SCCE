import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_CODING_VALIDATOR_ID,
  WORKSPACE_CODE_USAGE,
  WORKSPACE_CODING_CHECKS,
  WORKSPACE_CODING_MAX_DEPTH,
  WORKSPACE_CODING_MAX_DOCUMENT_BYTES,
  WORKSPACE_CODING_MAX_FILE_BYTES,
  WORKSPACE_CODING_MAX_FILES,
  WORKSPACE_CODING_REQUEST_MAX_BYTES,
  defaultWorkspaceCodingRequestId,
  parseWorkspaceCodingRequest,
  splitWorkspaceCodingTurnArgs
} from "../workspace-code-options.js";

describe("workspace plan-code CLI parsing", () => {
  it("keeps chat controls separate from the structured compiler selector", () => {
    expect(splitWorkspaceCodingTurnArgs([
      "--workspace-code",
      "--conversation-id=conversation.1",
      "--root=C:/repo",
      "--path=src/index.ts",
      "--diagnostic-code=2552",
      "repair",
      "symbol"
    ])).toEqual({
      turnArgs: ["--conversation-id=conversation.1", "repair", "symbol"],
      codingRequest: expect.objectContaining({
        text: "repair symbol",
        rootPath: "C:/repo",
        requestedPaths: ["src/index.ts"],
        diagnosticCodes: [2552]
      })
    });
  });

  it("uses the complete compiler validation contract and canonical requested paths", () => {
    const request = parseWorkspaceCodingRequest([
      "--path=src/z.ts",
      "--path=package.json",
      "--root=C:\\repo",
      "--request-id=request-1",
      "--max-files=100",
      "Remove",
      "the unused import"
    ]);

    expect(request).toEqual({
      text: "Remove the unused import",
      requestedPaths: ["package.json", "src/z.ts"],
      diagnosticCodes: [],
      requestId: "request-1",
      rootPath: "C:\\repo",
      validatorId: DEFAULT_WORKSPACE_CODING_VALIDATOR_ID,
      checks: [...WORKSPACE_CODING_CHECKS],
      workspaceOptionArgs: ["--max-files=100"]
    });
  });

  it("keeps an explicit typecheck-only narrow repair plan valid", () => {
    expect(parseWorkspaceCodingRequest([
      "--path=src/types.ts",
      "--validator=docker-pnpm-validate.v1",
      "--checks=typecheck",
      "Remove unused type import Example from src/types.ts."
    ])).toMatchObject({
      validatorId: "docker-pnpm-validate.v1",
      checks: ["typecheck"]
    });
  });

  it("parses structured compiler diagnostic selectors without reading request prose", () => {
    expect(parseWorkspaceCodingRequest([
      "--path=src/index.ts",
      "--diagnostic-code=2552",
      "opaque"
    ])).toMatchObject({ diagnosticCodes: [2552] });
    expect(() => parseWorkspaceCodingRequest([
      "--path=src/index.ts",
      "--diagnostic-code=2552",
      "--diagnostic-code=2552",
      "opaque"
    ])).toThrow(/duplicate diagnostic/u);
  });

  it("supports a conventional delimiter for request text containing flag-like tokens", () => {
    expect(parseWorkspaceCodingRequest([
      "--path=src/cli.ts",
      "--",
      "Add",
      "--dry-run",
      "support"
    ])?.text).toBe("Add --dry-run support");
  });

  it("returns usage state only when request text or scope is missing", () => {
    expect(parseWorkspaceCodingRequest(["--path=src/a.ts"])).toBeUndefined();
    expect(parseWorkspaceCodingRequest(["change", "it"])).toBeUndefined();
  });

  it("rejects unsafe, duplicate, absolute, non-NFC, and overlong paths", () => {
    const request = "change it";
    for (const unsafe of ["../a.ts", "src/./a.ts", "src\\a.ts", "/src/a.ts", "C:/src/a.ts", `src/${"e\u0301"}.ts`]) {
      expect(() => parseWorkspaceCodingRequest([`--path=${unsafe}`, request])).toThrow(/path/u);
    }
    expect(() => parseWorkspaceCodingRequest(["--path=src/a.ts", "--path=src/a.ts", request])).toThrow(/duplicate paths/u);
    expect(() => parseWorkspaceCodingRequest([`--path=${"a".repeat(1_025)}`, request])).toThrow(/1024/u);
    const tooMany = Array.from({ length: 257 }, (_, index) => `--path=src/${index}.ts`);
    expect(() => parseWorkspaceCodingRequest([...tooMany, request])).toThrow(/256 paths/u);
  });

  it("enforces request byte, identifier, validation, and option bounds", () => {
    const path = "--path=src/a.ts";
    expect(Buffer.byteLength("a".repeat(WORKSPACE_CODING_REQUEST_MAX_BYTES), "utf8")).toBe(WORKSPACE_CODING_REQUEST_MAX_BYTES);
    expect(parseWorkspaceCodingRequest([path, "a".repeat(WORKSPACE_CODING_REQUEST_MAX_BYTES)])?.text).toHaveLength(WORKSPACE_CODING_REQUEST_MAX_BYTES);
    expect(() => parseWorkspaceCodingRequest([path, "a".repeat(WORKSPACE_CODING_REQUEST_MAX_BYTES + 1)])).toThrow(/20000 UTF-8 bytes/u);
    expect(() => parseWorkspaceCodingRequest([path, "bad\0request"])).toThrow(/NUL/u);
    expect(() => parseWorkspaceCodingRequest([path, `--request-id=${"x".repeat(257)}`, "change"])).toThrow(/256 characters/u);
    expect(() => parseWorkspaceCodingRequest([path, "--checks=compiler,,tests", "change"])).toThrow(/subset/u);
    expect(() => parseWorkspaceCodingRequest([path, "--checks=tests,tests", "change"])).toThrow(/duplicates/u);
    expect(() => parseWorkspaceCodingRequest([path, "--checks=lint", "change"])).toThrow(/subset/u);
    expect(() => parseWorkspaceCodingRequest([path, "--conversation-id=irrelevant", "change"])).toThrow(/unknown workspace coding option/u);
    expect(() => parseWorkspaceCodingRequest([path, "--max-files=0", "change"])).toThrow(/integer from 1/u);
    expect(() => parseWorkspaceCodingRequest([path, `--max-files=${WORKSPACE_CODING_MAX_FILES + 1}`, "change"])).toThrow(/100000/u);
    expect(() => parseWorkspaceCodingRequest([path, "--max-files=1.5", "change"])).toThrow(/integer/u);
    expect(() => parseWorkspaceCodingRequest([path, `--max-file-bytes=${WORKSPACE_CODING_MAX_FILE_BYTES + 1}`, "change"])).toThrow(/67108864/u);
    expect(() => parseWorkspaceCodingRequest([path, `--max-depth=${WORKSPACE_CODING_MAX_DEPTH + 1}`, "change"])).toThrow(/256/u);
    expect(() => parseWorkspaceCodingRequest([path, `--max-document-bytes=${WORKSPACE_CODING_MAX_DOCUMENT_BYTES + 1}`, "change"])).toThrow(/67108864/u);
    expect(() => parseWorkspaceCodingRequest([path, "--no-unsupported", "--no-unsupported", "change"])).toThrow(/duplicate/u);
  });

  it("derives a stable request id from the complete planning request", () => {
    const request = parseWorkspaceCodingRequest(["--path=src/a.ts", "change it"]);
    expect(request).toBeDefined();
    const base = {
      workspaceId: "workspace-1",
      expectedWorkspaceUpdatedAt: 10,
      request: request!
    };
    const first = defaultWorkspaceCodingRequestId(base);
    expect(first).toMatch(/^workspace_code_[0-9a-f]{24}$/u);
    expect(defaultWorkspaceCodingRequestId(base)).toBe(first);
    expect(defaultWorkspaceCodingRequestId({ ...base, request: { ...request!, checks: ["typecheck"] } })).not.toBe(first);
  });

  it("advertises the plan-only command as plan-code", () => {
    expect(WORKSPACE_CODE_USAGE).toContain("workspace plan-code");
    expect(WORKSPACE_CODE_USAGE).toContain("--path=<workspace-file>");
  });
});
