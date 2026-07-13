# Ablation wiring requirements

The production runtime now receives an explicit immutable evaluation
configuration. It is parsed once before runtime construction rather than read
from mutable per-question globals.

Suggested shape:

```ts
export interface EvaluationCondition {
  conditionId: string;
  disableRelationPotential: boolean;
  disableQueryDiffusion: boolean;
  disablePowerWalk: boolean;
  disableGraph: boolean;
  lexicalOnly: boolean;
  disableLearnedSemantics: boolean;
  disableSupportEngine: boolean;
  deterministicMouth: boolean;
  disableLanguageMemory: boolean;
  disableIncrementalLearning: boolean;
  disableShardRouter: boolean;
  cacheNamespace: string;
  seed: string;
  clockIso: string;
}
```

Every component boundary should receive the condition explicitly and emit a trace event. Do not let downstream code infer the condition from missing output alone.

## Cache rule

Every cache key must include:

- brain hash;
- corpus hash;
- source/build hash where applicable;
- condition ID;
- algorithm/configuration version;
- injected clock/seed when relevant.

Ablated conditions must never read caches produced by `full`.

## Current wiring

All eleven required condition IDs are defined in
`packages/kernel/src/evaluation-flags.ts`. `no_graph` also disables relation
potential, query diffusion, and PowerWalk; `lexical_only` additionally disables
learned semantics. `no_shard_router` is rejected outside the
`performance-recovery` scope.

The production turn emits `componentEntered`, `componentBypassed`, and
`cacheRead` events with condition/config/cache identities. The independent
verifier rejects disabled-component entry or cache reads, missing bypasses,
foreign cache owners, invalid event order, and mismatched identities. Components
that are genuinely not applicable emit an explicit `not-applicable` bypass;
the adapter does not invent an entry event.

This is wiring evidence, not contribution evidence. In particular, a full run
with no configured frozen relation model uses `identity_unconfigured`, and a
brain without fitted PowerWalk representation state cannot demonstrate a
PowerWalk uplift. Those states must be sealed and recorded before interpreting
full-minus-ablation results. No official ablation run has occurred.
