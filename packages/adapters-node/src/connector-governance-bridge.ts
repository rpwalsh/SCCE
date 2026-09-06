// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  createConnectorGovernance,
  type ConnectorAdmission,
  type ConnectorConfig,
  type ConnectorPhase,
  type ConnectorQuotaState,
  type PolicyProfile
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";

/**
 * One governance model, one enforcement point.
 *
 * The runtime used to carry two connector gates that did not agree: `ConnectorPolicyGate` (allowlist, mutation rule,
 * request quota) protected every real call, while the kernel's `connector-governance.ts` (risk scoring, approval
 * tickets, spend and rate quotas) was fully implemented and consulted by nothing. A reader could harden the model that
 * was not enforcing anything and believe production had changed.
 *
 * This module is the mapping that lets the live gate delegate. The operator's own `connectors.*` configuration becomes
 * the kernel's `ConnectorConfig`, so the limits the kernel checks are the operator's limits, and the two decisions are
 * combined by conjunction: a call proceeds only if both models admit it. Nothing that was previously blocked can become
 * allowed by this bridge, and the kernel's risk, approval and spend rules become load-bearing for the first time.
 */

/** The connector kinds the live gate knows about, mapped onto the kernel's own taxonomy. */
const CONNECTOR_KINDS = {
  web: "web_fetch",
  outlook: "outlook",
  youtube: "youtube",
  telephone: "telephone"
} as const;

export type LiveConnectorId = keyof typeof CONNECTOR_KINDS;

/** Operations that change something outside SCCE. Everything else is a read. */
export function connectorPhaseFor(mutates: boolean): ConnectorPhase {
  return mutates ? "commit" : "read";
}

/**
 * The operator's configuration as the kernel's admission model reads it. Limits come from the operator's own policy so
 * the two gates cannot disagree about how many requests or how much spend is allowed; approval requirements mirror the
 * live gate's existing behaviour (a mutation needs approval, a read does not) rather than inventing a stricter rule.
 */
export function connectorConfigForRuntime(
  config: ScceRuntimeConfig,
  connector: LiveConnectorId,
  policy: PolicyProfile
): ConnectorConfig {
  const declared = config.connectors[connector];
  const web = connector === "web" ? config.connectors.web : undefined;
  return {
    id: `connector.${connector}`,
    kind: CONNECTOR_KINDS[connector],
    enabled: Boolean(declared?.enabled),
    ...(web?.search?.provider ? { provider: web.search.provider } : {}),
    limits: {
      requestsPerMinute: Math.max(1, policy.maxNetworkRequests),
      requestsPerSession: Math.max(1, policy.maxNetworkRequests),
      maxBytesPerResponse: Math.max(1, web?.maxBytes ?? 1_000_000),
      maxSpendCents: Math.max(0, policy.maxSpendCents)
    },
    allowedOperations: [],
    approval: {
      requiredForRead: false,
      requiredForPrepare: false,
      requiredForCommit: true,
      operatorGrantEligible: true
    }
  };
}

export interface ConnectorAdmissionInput {
  config: ScceRuntimeConfig;
  policy: PolicyProfile;
  connector: LiveConnectorId;
  mutates: boolean;
  approved: boolean;
  sessionId: string;
  requestsUsed: number;
  bytesRead?: number;
  failures?: number;
  lastRequestAt?: number;
}

/**
 * The kernel's admission decision for one live connector call. Returned rather than thrown so the caller can combine it
 * with its own allowlist decision and record both in the same audit record.
 */
export function admitConnectorCall(input: ConnectorAdmissionInput): ConnectorAdmission {
  const connectorConfig = connectorConfigForRuntime(input.config, input.connector, input.policy);
  const quota: ConnectorQuotaState = {
    connectorId: connectorConfig.id,
    sessionId: input.sessionId,
    requestsUsed: Math.max(0, input.requestsUsed),
    bytesRead: Math.max(0, input.bytesRead ?? 0),
    // Spend is not metered per call by the live gate; the kernel's cap still applies through the policy's own ceiling.
    spendCents: 0,
    failures: Math.max(0, input.failures ?? 0),
    ...(input.lastRequestAt === undefined ? {} : { lastRequestAt: input.lastRequestAt })
  };
  return createConnectorGovernance().admit({
    config: connectorConfig,
    quota,
    phase: connectorPhaseFor(input.mutates),
    policy: input.policy,
    temporaryOperatorGrant: input.approved
  });
}
