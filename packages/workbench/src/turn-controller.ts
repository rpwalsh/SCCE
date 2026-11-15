// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { StartTurnInput } from "./__generated__/WorkbenchStartMutation.graphql";

export interface PendingCapabilityApproval {
  planId: string;
  capabilityId: string;
  fingerprint: string;
  reason: string;
  input: unknown;
  approvalScope?: unknown;
}
interface Decision { operationId: string; confirmed: boolean }
export interface SavedTurnSubmission {
  schema: "scce.workbench.turn_submission.v1";
  scope: string;
  input: StartTurnInput;
  decisions: Record<string, Decision>;
}
export interface TurnControllerPorts {
  reserve(): Promise<string>;
  start(input: StartTurnInput): Promise<void>;
  approve(input: { operationId: string; planId: string }): Promise<{ planId: string; capabilityId: string }>;
  reject(input: { operationId: string; planId: string }): Promise<{ planId: string; capabilityId: string }>;
  cancel(taskId: string): Promise<void>;
}
type SubmissionStore = Pick<Storage, "getItem" | "setItem">;
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

export function pendingCapabilityApproval(value: unknown): PendingCapabilityApproval | undefined {
  const pending = object(object(value)?.pendingApproval);
  if (!pending || ![pending.planId, pending.capabilityId].every(item => typeof item === "string" && item.length > 0 && item.length <= 256)
    || typeof pending.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(pending.fingerprint) || pending.input === undefined) return undefined;
  return { planId: pending.planId, capabilityId: pending.capabilityId, fingerprint: pending.fingerprint,
    reason: typeof pending.reason === "string" ? pending.reason : "", input: structuredClone(pending.input),
    ...(pending.approvalScope === undefined ? {} : { approvalScope: structuredClone(pending.approvalScope) }) };
}

function freezeInput(value: unknown): StartTurnInput {
  const input = object(value), allowed = ["operationId", "text", "sessionId", "conversationId", "requestedAuthority", "workspaceActionContext", "clientMutationId"];
  if (!input || Object.keys(input).some(key => !allowed.includes(key)) || typeof input.operationId !== "string" || !input.operationId
    || typeof input.text !== "string" || !input.text.trim() || input.text.length > 20_000) throw Error("Saved task request is unavailable or invalid; start a new task.");
  const context = input.workspaceActionContext;
  if (context != null && (!object(context) || Object.keys(context).some(key => !["schema", "workspaceId", "expectedWorkspaceUpdatedAt", "policyId"].includes(key))
    || context.schema !== "scce.workspace.action-context.v1" || typeof context.workspaceId !== "string" || !context.workspaceId
    || typeof context.policyId !== "string" || !context.policyId || !Number.isSafeInteger(context.expectedWorkspaceUpdatedAt))) throw Error("Saved workspace context is invalid; start a new task.");
  const copy = structuredClone(input) as StartTurnInput;
  if (copy.workspaceActionContext) Object.freeze(copy.workspaceActionContext);
  return Object.freeze(copy);
}

export class WorkbenchTurnController {
  readonly #inFlight = new Map<string, Promise<void>>();
  constructor(readonly ports: TurnControllerPorts, readonly store: SubmissionStore, readonly scope: string,
    readonly newOperationId: () => string = () => crypto.randomUUID()) {}
  #key(taskId: string) { return `scce.workbench.submission:${encodeURIComponent(this.scope)}:${taskId}`; }
  load(taskId: string): SavedTurnSubmission | undefined {
    const text = this.store.getItem(this.#key(taskId));
    if (!text) return undefined;
    const saved = object(JSON.parse(text));
    if (saved?.schema !== "scce.workbench.turn_submission.v1" || saved.scope !== this.scope || saved.input?.operationId !== taskId || !object(saved.decisions)) {
      throw Error("Saved task request belongs to a different local state.");
    }
    return { schema: saved.schema, scope: saved.scope, input: freezeInput(saved.input), decisions: saved.decisions };
  }
  #save(submission: SavedTurnSubmission) { this.store.setItem(this.#key(submission.input.operationId), JSON.stringify(submission)); }
  async submit(text: string, options: Omit<StartTurnInput, "text" | "operationId"> = {}, reserved?: (taskId: string) => void): Promise<string> {
    const captured = structuredClone(options);
    const taskId = await this.ports.reserve(), input = freezeInput({ ...captured, operationId: taskId, text });
    this.#save({ schema: "scce.workbench.turn_submission.v1", scope: this.scope, input, decisions: {} });
    reserved?.(taskId);
    await this.ports.start(input);
    return taskId;
  }
  decideAndResume(taskId: string, proposal: PendingCapabilityApproval, choice: "approve" | "reject"): Promise<void> {
    const active = this.#inFlight.get(taskId);
    if (active) return active;
    const result = this.#decide(taskId, proposal, choice).finally(() => this.#inFlight.delete(taskId));
    this.#inFlight.set(taskId, result);
    return result;
  }
  async refreshProposal(taskId: string) {
    const saved = this.load(taskId);
    if (!saved) throw Error("The exact submitted request is not saved in this browser.");
    await this.ports.start(saved.input);
  }
  async #decide(taskId: string, proposal: PendingCapabilityApproval, choice: "approve" | "reject") {
    const saved = this.load(taskId);
    if (!saved) throw Error("The exact submitted request is not saved in this browser. Approval and continuation are unavailable here.");
    const context = object(proposal.input)?.workspaceContext;
    if (context && !same(context, saved.input.workspaceActionContext)) throw Error("The proposed action differs from this task's saved workspace scope.");
    const key = `${choice}:${proposal.fingerprint}`;
    const decision = saved.decisions[key] ?? { operationId: this.newOperationId(), confirmed: false };
    saved.decisions[key] = decision; this.#save(saved);
    const receipt = await this.ports[choice]({ operationId: decision.operationId, planId: proposal.planId });
    if (receipt.planId !== proposal.planId || receipt.capabilityId !== proposal.capabilityId) throw Error("The approval receipt does not match the reviewed action.");
    decision.confirmed = true; this.#save(saved);
    if (choice === "reject") await this.ports.cancel(taskId);
    else await this.ports.start(saved.input);
  }
}
