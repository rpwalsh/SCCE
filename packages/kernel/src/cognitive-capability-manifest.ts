// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * What cognition is actually running, stated so it cannot be mistaken for what merely exists.
 *
 * Relation potential is wired end to end -- config to runtime to kernel to field engine, called on every turn --
 * and no config has ever supplied it a model, so every production turn takes `if (!input.model) return identity()`.
 * It reported that as `not-applicable`, which is false: it IS applicable, and the learned artifact simply does not
 * exist. So the architecture diagram, the traces and the ablation table all looked healthy for a mechanism that has
 * never once participated in a turn. That is worse than dead code, because dead code is obvious.
 *
 * The ablation it invited -- full against no-relation-potential -- was really identity against nothing, and proved
 * exactly zero.
 *
 * THE INVARIANT: a subsystem that silently degrades to identity must never report itself as operational.
 *
 * Three independent facts, never collapsed into one word, because an operator can be running and unmeasured
 * (query diffusion: ten iterative operations per activation, cost unknown) or measured and useless on this traffic
 * (anchor evidence search: 23.3% of CPU, changed nothing in 2,126 invocations). Those need different responses:
 * one needs instrumentation, the other needs scheduling, and neither needs an algorithm change.
 */

export type CognitiveCapabilityStatus =
  /** Running, and doing its work. */
  | "active"
  /** Running, and this particular input genuinely does not call for it. */
  | "bypassed_not_applicable"
  /** Wired and reachable, but its learned artifact does not exist, so it degrades to identity. NOT "working". */
  | "inert_unconfigured"
  /** Switched off deliberately, by condition or configuration. */
  | "disabled_explicitly"
  /** Attempted and failed. */
  | "failed"
  /** No reachable call path from a production turn. */
  | "unreachable";

/**
 * The lifecycle a learned component must complete before it may call itself active. Presence of an optional config
 * key is not enough: an untrained component is untrained, not "working, returned identity".
 */
export type LearnedArtifactState = "untrained" | "fitted" | "validated" | "promoted";

export interface CognitiveCapability {
  readonly id: string;
  readonly status: CognitiveCapabilityStatus;
  /** Whether a turn records this operator's own cost. False means its economics are unknown, not zero. */
  readonly traced: boolean;
  /** For a learned component, how far its artifact got. Absent for components that learn nothing. */
  readonly artifact?: LearnedArtifactState;
  /** Identifier of the artifact in use, when one is. */
  readonly artifactId?: string | null;
  /** Fixed parameters worth seeing beside the status, such as iteration counts nobody has justified. */
  readonly parameters?: Readonly<Record<string, number | string | boolean | null>>;
  /** Why it is in this state, when the status alone does not say. */
  readonly note?: string;
}

export interface CognitiveCapabilityManifest {
  readonly schema: "scce.cognitive_capability_manifest.v1";
  readonly capabilities: readonly CognitiveCapability[];
  /** Capabilities that are running but whose cost and contribution are unmeasured. */
  readonly observationalBlindSpots: readonly string[];
  /** Capabilities an architecture diagram would show as present that contribute nothing. */
  readonly inert: readonly string[];
}

export function buildCognitiveCapabilityManifest(
  capabilities: readonly CognitiveCapability[]
): CognitiveCapabilityManifest {
  return {
    schema: "scce.cognitive_capability_manifest.v1",
    capabilities,
    observationalBlindSpots: capabilities.filter(row => row.status === "active" && !row.traced).map(row => row.id),
    inert: capabilities.filter(row => row.status === "inert_unconfigured" || row.status === "unreachable").map(row => row.id)
  };
}

/**
 * A learned component is active only when a promoted artifact is actually in hand. Anything short of that is
 * reported as inert, never as a successful run.
 */
export function learnedCapabilityStatus(input: {
  artifact: LearnedArtifactState;
  explicitlyDisabled?: boolean;
}): CognitiveCapabilityStatus {
  if (input.explicitlyDisabled) return "disabled_explicitly";
  return input.artifact === "promoted" ? "active" : "inert_unconfigured";
}

/** Every capability that appears in an architecture description, so one can never be quietly omitted. */
export const COGNITIVE_CAPABILITY_IDS = [
  "relation-potential",
  "query-diffusion",
  "powerwalk",
  "anchor-evidence-search",
  "semantic-retrieval",
  "language-hydration",
  "proof-entailment",
  "contradiction-check"
] as const;
