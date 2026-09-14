// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CODING_TURN_REQUEST_SCHEMA,
  parseTurnWorkspaceCodingRequest,
  workspaceCodingInputForProgramGraph
} from "../routes.js";
import type { ProgramGraph } from "@scce/kernel";
import type { WorkspaceCodingPatchPlanningInput } from "@scce/adapters-node";

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

  it("binds only the completed turn's source-bound ProgramGraph to workspace planning", () => {
    const input: WorkspaceCodingPatchPlanningInput = {
      workspaceId: "workspace.1",
      expectedWorkspaceUpdatedAt: 7,
      requestId: "request.1",
      requestText: "build the selected program",
      requestedPaths: ["src/index.ts"],
      validationPlan: {
        validatorId: "trusted-host-pnpm-validate.v1",
        checks: ["compiler"]
      }
    };
    const program = {
      id: "program.1",
      files: [],
      hydration: {
        valid: true,
        program: {
          provenanceEvidenceIds: ["evidence.2", "evidence.1", "evidence.2"]
        }
      }
    } as unknown as ProgramGraph;

    const bound = workspaceCodingInputForProgramGraph(input, program);

    expect(bound).toMatchObject({
      program,
      evidenceIds: ["evidence.2", "evidence.1"]
    });
    expect(workspaceCodingInputForProgramGraph(input, undefined)).toBeUndefined();
    expect(workspaceCodingInputForProgramGraph(input, {
      ...program,
      hydration: {
        ...program.hydration!,
        valid: false
      }
    })).toBeUndefined();
    expect(workspaceCodingInputForProgramGraph(input, {
      ...program,
      hydration: {
        ...program.hydration!,
        program: {
          ...program.hydration!.program,
          provenanceEvidenceIds: []
        }
      }
    })).toBeUndefined();
  });
});
