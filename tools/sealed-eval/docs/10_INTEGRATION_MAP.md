# SCCE integration map

The `yopp-*` integration basenames below are retained compatibility identifiers for
the SCCE evaluation interface.

The current production and evaluation boundaries are:

- condition identity, incompatibility checks, and cache material:
  `packages/kernel/src/evaluation-flags.ts`;
- component event recording and verification:
  `packages/kernel/src/evaluation-trace.ts` and
  `tools/sealed-eval/integration/yopp-trace-verifier.mjs`;
- evidence bytes and offsets: `packages/kernel/src/evidence.ts`;
- graph construction: `packages/kernel/src/graphbuild.ts`;
- empirical alpha normalization: `packages/kernel/src/alpha.ts`;
- frozen relation model and source-neutral graph-edge projection:
  `packages/kernel/src/relation-potential.ts`, consumed by
  `packages/kernel/src/field.ts`;
- personalized random walk/query diffusion: `packages/kernel/src/ppf.ts` and
  `packages/kernel/src/field.ts`;
- typed second-order walk and learned sparse PPMI state:
  `packages/kernel/src/powerwalk.ts` and
  `packages/kernel/src/powerwalk-ppmi.ts`, consumed by the production turn in
  `packages/kernel/src/kernel.ts`;
- lexical and learned semantic retrieval: `packages/kernel/src/retrieval.ts`
  and `packages/kernel/src/semantic-memory-index.ts`;
- support, contradiction, and proof: `packages/kernel/src/entailment.ts`,
  `packages/kernel/src/support-assessment.ts`,
  `packages/kernel/src/semantic-proof-*`, and
  `packages/kernel/src/proof-carrying-answer.ts`;
- language memory: `packages/kernel/src/language-memory-runtime.ts`,
  `packages/kernel/src/language-induction.ts`, and `packages/kernel/src/ngram-*`;
- mouth and final hard surface: `packages/kernel/src/mouth.ts`,
  `packages/kernel/src/surface-realizer.ts`, and
  `packages/kernel/src/walsh-surface-energy.ts`;
- incremental learning and training: `packages/kernel/src/learning-*` and
  `packages/kernel/src/training-orchestrator.ts`;
- shard routing: `packages/kernel/src/brain-shards.ts` and Node importers;
- brain lifecycle: `packages/kernel/src/brain-lifecycle.ts`, with the canonical
  PostgreSQL implementation in `packages/adapters-node/src/postgres.ts`;
- coding primitives: `packages/kernel/src/program-*` and
  `packages/adapters-node/src/program-repair.ts`;
- content-addressed patch application:
  `packages/kernel/src/patch-transaction.ts`,
  `packages/adapters-node/src/workspace-patch-transaction.ts`, and
  `packages/adapters-node/src/structured-patch-validation.ts`;
- reviewed patch transport: `POST /api/workspace/patch` in
  `packages/server/src/routes.ts` and the command in
  `packages/vscode/src/extension.ts`;
- full turn: `packages/kernel/src/kernel.ts`,
  `packages/kernel/src/runtime-orchestrator.ts`, and
  `packages/kernel/src/scce-runtime.ts`;
- normal evaluation bridge:
  `tools/sealed-eval/integration/yopp-jsonl-adapter.mjs`.

Evaluation flags execute in the production kernel, field, retrieval, support,
mouth, learning, and shard boundaries. The harness observes them; it does not
emulate their behavior. The relation-potential full path is an explicit identity
fallback when no frozen model is configured, and PowerWalk expansion needs
fitted state. A run that intends to estimate either component's contribution
must seal and verify that fitted state before comparing it with the ablation.

No coding JSONL adapter currently binds sealed tasks to the coding and patch
boundaries. The patch endpoint accepts reviewed caller-supplied plans; patch-plan
generation is still missing. The VS Code extension and trusted-host validator
therefore are not evidence of coding-agent or IDE parity.
