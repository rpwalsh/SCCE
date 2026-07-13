# Ablation protocol

Ablation is meaningful only when one component changes and all other relevant conditions remain fixed.

## Required conditions

| ID | Disabled or constrained subsystem | Purpose |
|---|---|---|
| `full` | none | Production candidate |
| `no_relation_potential` | evidence-conditioned relation potential | Measure relation-strength contribution |
| `no_query_diffusion` | personalized random walk with restart | Measure query-conditioned graph diffusion |
| `no_powerwalk` | typed temporal second-order walk features | Measure typed temporal walk contribution |
| `no_graph` | graph traversal and graph-derived features | Compare evidence retrieval without graph reasoning |
| `lexical_only` | learned semantics and graph features | Establish lexical retrieval floor |
| `no_support_engine` | claim-support/contradiction assessment | Measure support layer and unsupported claims |
| `deterministic_mouth` | learned/candidate mouth realization | Measure language realization separately from reasoning |
| `no_language_memory` | corpus-induced language memory | Measure language-memory contribution |
| `no_incremental_learning` | learning updates during evaluation | Prevent adaptation and measure update effect |
| `no_shard_router` | physical routing optimization only | Performance/recovery test, not answer-quality test if corpus access differs |

## Isolation requirements

Every condition must have:

- a typed immutable configuration;
- a configuration hash;
- a separate cache namespace;
- a component execution trace;
- a verifier that fails if a disabled component was entered or its cache was read;
- identical source corpus bytes and question set;
- identical resource limits;
- identical scorer and judging process.

If disabling a component requires rebuilding the brain, build and seal a separate brain manifest. Do not compare a full brain with an ablated brain that contains less source content without explicitly classifying the test as an architecture-cost comparison.

## Order effects

Run conditions in randomized order or on independent clean clones. Learning and caches must not carry over. When multi-turn context is evaluated, each condition receives the same turn sequence and initial state.

## Interpretation

- A positive full-minus-ablation delta suggests contribution under the tested distribution.
- A zero or uncertain delta does not prove the component is useless globally.
- A negative delta suggests the component harms that metric or category.
- Do not combine categories until preregistered weights are applied.
- Correct for multiple comparisons when claiming statistical significance across many ablations.

## Current Yopp implementation

All listed condition IDs are wired into the production runtime with immutable
configuration hashes, condition-specific cache namespaces, and component traces.
The trace verifier rejects disabled-component execution, disabled-component
cache reads, missing bypass events, and cross-condition cache ownership.
`no_shard_router` is limited by code to `performance-recovery` scope.

This implementation status is not an ablation result. No official sealed
full-versus-ablation comparison has run. Before interpreting relation-potential
or PowerWalk deltas, the custodian must verify that the sealed full brain has a
frozen representative relation model and fitted PowerWalk representation state;
their explicit unconfigured/no-data paths cannot establish uplift.
