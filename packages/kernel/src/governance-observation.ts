import type { JsonValue, PolicyProfile } from "./types.js";
import { toJsonValue } from "./primitives.js";

export interface GovernanceControlObservation {
  available: boolean;
  passed: boolean;
  reason: string;
  evidence: JsonValue;
}

export interface EventLedgerGovernanceObservation extends GovernanceControlObservation {
  events: number;
  latestLedgerHash?: string;
}

export interface RollbackGovernanceObservation extends GovernanceControlObservation {
  artifactsChecked: number;
  artifactsReady: number;
}

export interface KillSwitchGovernanceObservation extends GovernanceControlObservation {
  state: "armed" | "triggered" | "unavailable" | "invalid";
  independentlyConfigured: boolean;
}

export interface LeaseGovernanceObservation extends GovernanceControlObservation {
  enumerable: boolean;
  activeLeases: number;
  connectorAuthorityReady: boolean;
  executorAuthorityReady: boolean;
  revocableActiveLeases: number;
}

export interface PendingMutationGovernanceObservation extends GovernanceControlObservation {
  enumerable: boolean;
  pending: number;
  mutationIds: string[];
}

export interface PolicyIntegrityGovernanceObservation extends GovernanceControlObservation {
  fingerprint: string;
  expectedFingerprint?: string;
  fingerprintValid: boolean;
  signatureValid: boolean;
}

/**
 * Whether the event ledger's append-only guarantee is actually enforced at
 * the database level, not just assumed. `updateDenied`/`deleteDenied`
 * reflect the connected role's real Postgres privileges on the events
 * table (the load-bearing control -- a role that can UPDATE/DELETE events
 * makes the hash chain meaningless regardless of application-level
 * discipline); `protectiveTriggerPresent` is defense-in-depth information,
 * not sufficient on its own since a role with table privileges can still
 * bypass a trigger.
 */
export interface ImmutabilityGovernanceObservation extends GovernanceControlObservation {
  updateDenied: boolean;
  deleteDenied: boolean;
  protectiveTriggerPresent: boolean;
}

export interface GovernanceObservation {
  schema: "scce.governance.observation.v1";
  observedAt: number;
  eventLedger: EventLedgerGovernanceObservation;
  rollback: RollbackGovernanceObservation;
  killSwitch: KillSwitchGovernanceObservation;
  leases: LeaseGovernanceObservation;
  pendingMutations: PendingMutationGovernanceObservation;
  policyIntegrity: PolicyIntegrityGovernanceObservation;
  immutability: ImmutabilityGovernanceObservation;
  ready: boolean;
  failures: string[];
  audit: JsonValue;
}

export interface GovernanceProbe {
  observe(input: { policy: PolicyProfile; now: number }): Promise<GovernanceObservation>;
}

export type GovernanceObservationControls = Omit<
  GovernanceObservation,
  "schema" | "observedAt" | "ready" | "failures" | "audit"
>;

export function governanceObservation(
  observedAt: number,
  controls: GovernanceObservationControls
): GovernanceObservation {
  const checks: Array<[string, GovernanceControlObservation]> = [
    ["event-ledger", controls.eventLedger],
    ["rollback", controls.rollback],
    ["kill-switch", controls.killSwitch],
    ["leases", controls.leases],
    ["pending-mutations", controls.pendingMutations],
    ["policy-integrity", controls.policyIntegrity],
    ["immutability", controls.immutability]
  ];
  const failures = checks
    .filter(([, observation]) => !observation.available || !observation.passed)
    .map(([name, observation]) => `${name}:${observation.reason}`);
  const ready = failures.length === 0;
  return {
    schema: "scce.governance.observation.v1",
    observedAt,
    ...controls,
    ready,
    failures,
    audit: toJsonValue({
      schema: "scce.governance.observation.v1",
      observedAt,
      ready,
      failures,
      controls
    })
  };
}

export function unavailableGovernanceObservation(
  observedAt: number,
  reason = "governance_probe_unavailable"
): GovernanceObservation {
  const unavailable = (name: string): GovernanceControlObservation => ({
    available: false,
    passed: false,
    reason,
    evidence: { control: name, observed: false }
  });
  return governanceObservation(observedAt, {
    eventLedger: { ...unavailable("event-ledger"), events: 0 },
    rollback: { ...unavailable("rollback"), artifactsChecked: 0, artifactsReady: 0 },
    killSwitch: {
      ...unavailable("kill-switch"),
      state: "unavailable",
      independentlyConfigured: false
    },
    leases: {
      ...unavailable("leases"),
      enumerable: false,
      activeLeases: 0,
      connectorAuthorityReady: false,
      executorAuthorityReady: false,
      revocableActiveLeases: 0
    },
    pendingMutations: {
      ...unavailable("pending-mutations"),
      enumerable: false,
      pending: 0,
      mutationIds: []
    },
    policyIntegrity: {
      ...unavailable("policy-integrity"),
      fingerprint: "",
      fingerprintValid: false,
      signatureValid: false
    },
    immutability: {
      ...unavailable("immutability"),
      updateDenied: false,
      deleteDenied: false,
      protectiveTriggerPresent: false
    }
  });
}
