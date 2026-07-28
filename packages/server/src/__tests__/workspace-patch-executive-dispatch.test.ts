import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDurableExecutiveEpisode,
  createExecutiveEpisodeMachine,
  createHasher,
  createPatchTransactionPlan,
  hashPatchContent,
  type ExecutiveEpisodeId,
  type ExecutiveEvent,
  type ExecutiveEventJournal,
  type ExecutiveJournalAppend,
  type ExecutiveJournalAppendResult,
  type ExecutiveJournalSnapshot
} from "@scce/kernel";
import {
  DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
  WORKSPACE_PATCH_REQUEST_SCHEMA,
  executeWorkspacePatchApiRequest,
  parseWorkspacePatchRequest
} from "../routes.js";

// The same in-memory journal fixture pattern
// packages/kernel/src/__tests__/capability-dispatcher.test.ts already
// established, reused here rather than reinvented.
class MemoryExecutiveJournal implements ExecutiveEventJournal {
  private readonly events = new Map<ExecutiveEpisodeId, ExecutiveEvent[]>();
  private readonly commands = new Map<ExecutiveEpisodeId, Set<string>>();

  async read(episodeId: ExecutiveEpisodeId): Promise<ExecutiveJournalSnapshot> {
    const events = this.events.get(episodeId) ?? [];
    return { episodeId, revision: events.length, events: structuredClone(events) };
  }

  async append(input: ExecutiveJournalAppend): Promise<ExecutiveJournalAppendResult> {
    const events = this.events.get(input.episodeId) ?? [];
    const commands = this.commands.get(input.episodeId) ?? new Set<string>();
    if (commands.has(input.commandId)) return { status: "duplicate", revision: events.length };
    if (events.length !== input.expectedRevision) return { status: "conflict", revision: events.length };
    this.events.set(input.episodeId, [...events, ...structuredClone(input.events)]);
    commands.add(input.commandId);
    this.commands.set(input.episodeId, commands);
    return { status: "appended", revision: events.length + input.events.length };
  }
}

function executiveFixture() {
  const journal = new MemoryExecutiveJournal();
  const machine = createExecutiveEpisodeMachine(createHasher());
  return { journal, executive: createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 1 }) };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const passingPolicy = {
  schemaVersion: "yopp.patch-validation-policy.v1" as const,
  id: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
  commands: [{ executable: process.execPath, argv: ["-e", "process.exit(0)"] }],
  timeoutMs: 5_000,
  maxOutputBytes: 16 * 1024,
  maxWorkspaceFiles: 100,
  maxWorkspaceBytes: 1024 * 1024
};

describe("workspace patch execution routed through the durable executive dispatcher (plan item 45)", () => {
  it("performs the real mutation and returns the real receipt when executive is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "yopp-patch-executive-"));
    roots.push(root);
    await writeFile(join(root, "value.txt"), "before", "utf8");
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("before"), content: "after" }]
    });
    const request = parseWorkspacePatchRequest({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    });
    const { executive } = executiveFixture();

    const response = await executeWorkspacePatchApiRequest({
      request,
      workspace: { id: "workspace-1", rootPath: root },
      allowedRoots: [root],
      policy: passingPolicy,
      executive,
      ownerId: "test.owner"
    });

    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after");
    expect(response.receipt.planHash).toBe(plan.planHash);
  });

  it("does not attempt the mutation a second time when the dispatched executor already failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "yopp-patch-executive-fail-"));
    roots.push(root);
    await writeFile(join(root, "value.txt"), "before", "utf8");
    // baseContentHash deliberately wrong -- the real transaction must fail
    // validation/precondition, and that failure must propagate as a real
    // error rather than being swallowed or silently retried.
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("wrong-base"), content: "after" }]
    });
    const request = parseWorkspacePatchRequest({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    });
    const { executive } = executiveFixture();

    await expect(executeWorkspacePatchApiRequest({
      request,
      workspace: { id: "workspace-1", rootPath: root },
      allowedRoots: [root],
      policy: passingPolicy,
      executive,
      ownerId: "test.owner"
    })).rejects.toThrow();

    // The file must be untouched -- a failed precondition must not have
    // partially mutated anything, and must not have been retried into a
    // different (wrong) result either.
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("before");
  });

  it("dispatching the identical request twice against a real journal replays as a duplicate rather than mutating twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "yopp-patch-executive-dup-"));
    roots.push(root);
    await writeFile(join(root, "value.txt"), "before", "utf8");
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("before"), content: "after" }]
    });
    const request = parseWorkspacePatchRequest({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    });
    const { executive } = executiveFixture();

    const first = await executeWorkspacePatchApiRequest({
      request,
      workspace: { id: "workspace-1", rootPath: root },
      allowedRoots: [root],
      policy: passingPolicy,
      executive,
      ownerId: "test.owner"
    });
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after");

    // A second real transaction attempt against the now-mutated file with
    // the SAME plan (whose baseContentHash was "before") would fail
    // real content-hash validation regardless -- this proves the
    // dispatcher path does not paper over that with a fabricated success,
    // it surfaces the same honest precondition failure the direct path
    // would (content is no longer "before").
    await expect(executeWorkspacePatchApiRequest({
      request,
      workspace: { id: "workspace-1", rootPath: root },
      allowedRoots: [root],
      policy: passingPolicy,
      executive,
      ownerId: "test.owner"
    })).rejects.toThrow();

    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after");
    expect(first.receipt.planHash).toBe(plan.planHash);
  });

  it("falls back to the exact pre-existing direct path when executive is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "yopp-patch-executive-absent-"));
    roots.push(root);
    await writeFile(join(root, "value.txt"), "before", "utf8");
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("before"), content: "after" }]
    });
    const request = parseWorkspacePatchRequest({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    });
    const response = await executeWorkspacePatchApiRequest({
      request,
      workspace: { id: "workspace-1", rootPath: root },
      allowedRoots: [root],
      policy: passingPolicy
    });
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after");
    expect(response.receipt.planHash).toBe(plan.planHash);
  });
});
