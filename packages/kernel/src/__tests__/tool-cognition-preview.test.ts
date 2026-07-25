import { describe, expect, it } from "vitest";
import { createAutonomousToolCognition } from "../tool-cognition.js";
import { DEFAULT_POLICY } from "../safety.js";
import type { Capability } from "../types.js";

describe("tool cognition capability plan preview", () => {
  it("produces real scored objectives for an action-shaped request without materializing any executable plan", () => {
    const cognition = createAutonomousToolCognition({ now: () => 1_000 });

    const preview = cognition.previewPlans({
      request: "Please edit config.ts to add the missing export and run the build to verify it compiles.",
      capabilities: capabilities(),
      policy: DEFAULT_POLICY,
      actionCommitment: 0.4
    });

    expect(preview.objectives.length).toBeGreaterThan(0);
    expect(preview.scored.length).toBeGreaterThan(0);
    for (const score of preview.scored) {
      expect(score.fit).toBeGreaterThanOrEqual(0);
      expect(score.fit).toBeLessThanOrEqual(1);
      expect(score.evi).toBeGreaterThanOrEqual(0);
      expect(score.risk).toBeGreaterThanOrEqual(0);
      // must never materialize an executable/approval artifact
      expect((score as unknown as { status?: unknown }).status).toBeUndefined();
    }
  });

  it("never previews a commit-phase candidate under a policy that forbids mutation", () => {
    const cognition = createAutonomousToolCognition({ now: () => 1_000 });

    const preview = cognition.previewPlans({
      request: "What year was the Eiffel Tower completed?",
      capabilities: capabilities(),
      policy: DEFAULT_POLICY,
      actionCommitment: 0
    });

    expect(DEFAULT_POLICY.allowMutation).toBe(false);
    expect(preview.scored.some(score => score.phase === "commit")).toBe(false);
  });

  it("offers a real alternative candidate per objective when more than one capability fits", () => {
    const cognition = createAutonomousToolCognition({ now: () => 1_000 });

    const preview = cognition.previewPlans({
      request: "Search for and retrieve the latest release notes from the project repository.",
      capabilities: capabilities(),
      policy: DEFAULT_POLICY,
      actionCommitment: 0
    });

    const byObjective = new Map<string, number>();
    for (const score of preview.scored) byObjective.set(score.objectiveId, (byObjective.get(score.objectiveId) ?? 0) + 1);
    expect([...byObjective.values()].some(count => count > 1)).toBe(true);
  });
});

function capabilities(): Capability[] {
  return [
    { id: "filesystem.read", label: "filesystem.read", kind: "filesystem", mutates: false, risk: 0.1, requiresApproval: false, configured: true, metadata: {} },
    { id: "filesystem.write", label: "filesystem.write", kind: "filesystem", mutates: true, risk: 0.45, requiresApproval: true, configured: true, metadata: {} },
    { id: "process.build_test", label: "process.build_test", kind: "process", mutates: true, risk: 0.5, requiresApproval: true, configured: true, metadata: {} },
    { id: "network.search", label: "network.search", kind: "network", mutates: false, risk: 0.32, requiresApproval: false, configured: true, metadata: {} },
    { id: "network.fetch", label: "network.fetch", kind: "network", mutates: false, risk: 0.35, requiresApproval: false, configured: true, metadata: {} }
  ];
}
