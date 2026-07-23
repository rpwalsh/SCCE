import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CODING_TURN_REQUEST_SCHEMA,
  parseTurnWorkspaceCodingRequest
} from "../routes.js";

describe("workspace coding chat request", () => {
  it("uses the server turn text and a structured diagnostic selector", () => {
    const input = parseTurnWorkspaceCodingRequest({
      schemaVersion: WORKSPACE_CODING_TURN_REQUEST_SCHEMA,
      workspaceId: "workspace.1",
      expectedWorkspaceUpdatedAt: 7,
      requestId: "request.1",
      requestedPaths: ["src/index.ts"],
      diagnosticCodes: [2552],
      validationPlan: {
        validatorId: "trusted-host-pnpm-validate.v1",
        checks: ["compiler"]
      }
    }, "исправить символ");

    expect(input).toMatchObject({
      requestText: "исправить символ",
      requestedPaths: ["src/index.ts"],
      diagnosticCodes: [2552]
    });
    expect(input).not.toHaveProperty("authorization");
    expect(input).not.toHaveProperty("execution");
  });

  it("rejects prose and authority fields inside the compiler selector", () => {
    expect(() => parseTurnWorkspaceCodingRequest({
      schemaVersion: WORKSPACE_CODING_TURN_REQUEST_SCHEMA,
      workspaceId: "workspace.1",
      expectedWorkspaceUpdatedAt: 7,
      requestId: "request.1",
      requestText: "different text",
      requestedPaths: ["src/index.ts"],
      diagnosticCodes: [2552],
      validationPlan: {
        validatorId: "trusted-host-pnpm-validate.v1",
        checks: ["compiler"]
      },
      authorization: { granted: true }
    }, "turn text")).toThrow(/unexpected:/u);
  });
});
