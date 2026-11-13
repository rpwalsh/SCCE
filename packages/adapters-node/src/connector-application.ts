// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, invokeRuntimeCapability, requireCapabilityResult,
  type ApprovalPort, type JsonValue, type PolicyProfile, type RuntimeCapabilities } from "@scce/kernel";

export function connectorOperationIdentity(input: { ownerId: string; operationId: string; capabilityId: string }): { episodeId: string; taskId: string } {
  const identity = createHasher().digestHex(canonicalStringify(input));
  return { episodeId: `episode_connector_${identity}`, taskId: `task_connector_${identity}` };
}

export async function executeConnectorOperation(input: {
  capabilities: RuntimeCapabilities;
  approvals: ApprovalPort;
  ownerId: string;
  policy: PolicyProfile;
  operationId: string;
  capabilityId: string;
  payload: JsonValue;
}): Promise<JsonValue> {
  const capability = input.capabilities.catalog().find(row => row.id === input.capabilityId);
  if (!capability?.configured) throw new Error(`capability unavailable: ${input.capabilityId}`);
  const hasher = createHasher();
  const identity = connectorOperationIdentity({ ownerId: input.ownerId, operationId: input.operationId, capabilityId: input.capabilityId });
  return requireCapabilityResult(await invokeRuntimeCapability({
    capabilities: input.capabilities, ...identity,
    ownerId: input.ownerId, policyVersionId: `policy_${hasher.digestHex(canonicalStringify(input.policy))}`,
    capabilityId: input.capabilityId, payload: input.payload,
    approved: !capability.mutates && !capability.requiresApproval || input.approvals.isApproved({ capabilityId: input.capabilityId, input: input.payload })
  }));
}
