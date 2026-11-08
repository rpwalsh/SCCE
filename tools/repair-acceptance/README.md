# Map-write repair integrity

This offline acceptance case checks the harmful `Map.set` to `Map.get` mutation discussed in [CODE_LANE](../../docs/CODE_LANE.md). It uses the complete unchanged `paired-evaluation-statistics.ts` source from revision `4bc275b`, frozen before repair changes in `68b3325`. [case.json](cases/map-write-loss/case.json) records the source path, captured-byte hash, canonical-LF hash, Git blob identity, exact mutations, intended behavior and preserved behavior.

The old documentation's literal `byFamily.set(id, bucket)` is absent from the current source. The current equivalent is `byFamily.set(record.taskFamilyId, bucket)`. Replacing it with `byFamily.get(record.taskFamilyId)` leaves the family map empty while passing the real TypeScript compiler. This mutation is a manually crafted verifier negative control. It is not presented as current SCCE generation or as a successful repair.

The test-authored unit checks require both observed families, their sample counts and signed means, unchanged input records, invalid-result rejection and preserved Holm correction. The E2E check runs a native Node CLI against a separate six-record input. These are configured behavior tests inside the workspace, not a blind external evaluation. These wrappers/assertions are not ingested training data.

```powershell
$env:NODE_OPTIONS='--max-old-space-size=512'
$env:SCCE_TEST_HEAP_MB='512'
$env:SCCE_REPAIR_INTEGRITY_RECEIPT='.tmp/map-write-integrity-current.json'
node node_modules/vitest/vitest.mjs run packages/adapters-node/src/__tests__/code-lane-map-write-integrity.test.ts
```

The current measured result is seven passing checks:

| Check | Observed result |
| --- | --- |
| Original source, compiler + unit + E2E | All commands pass; source and other files unchanged |
| Crafted harmful edit, compiler + unit transaction | Compiler passes; unit assertion fails; transaction refuses before commit; all original hashes preserved |
| Crafted harmful edit, compiler + E2E transaction | Compiler passes; CLI assertion fails; transaction refuses before commit; all original hashes preserved |
| Crafted harmful edit, explicit compiler-only transaction | Edit commits; legacy TypeScript verifier reports `buildSucceeded: true`, `testsRun: false`; actual project tests fail; original is restored through passing native validation |
| Dropped argument, current actual compiler-owned proposer | TS2554 remains; `no_proposal`, zero attempts and unchanged broken bytes; no learned proposer was supplied |
| TS2551 spelling defect, compiler-only repair | The real compiler-owned `fixName:spelling` action restores the exact original source; receipt is `compiler_only`, `testsRun: false`, `testsSucceeded: null`; configured unit/E2E commands also pass when run separately afterward |
| TS2551 spelling defect, configured native-policy repair | The same actual action restores the exact original; receipt is `executed_tests`, with build and tests passing; configured unit/E2E commands pass again afterward |

The transaction cases use `executeWorkspacePatchTransaction` and `runStructuredPatchValidation`. The current repair trial uses `createWorkspaceCodeMouthPorts` and `runCodeMouth`, including the real compiler proposer. The receipt retains exact source/mutation hashes, command arguments, exit statuses, diagnostics and rollback evidence. No canonical storage, server, Ollama, solver or extra dependency is used.

Every code-mouth result now includes `verification` with schema `scce.code_mouth_verification.v1`, scope (`compiler_only`, `executed_tests`, or `unknown`), status (`passed`, `failed`, or `unknown`), and `buildSucceeded`, `testsRun`, `testsSucceeded`. Unexecuted or unrecorded tests have `testsSucceeded: null`. The receipt describes the last verification observation; `outcome` and `appliedOperations` still determine whether an edit survived. CLI JSON, HTTP JSON, and accepted-patch event payloads retain it. A compiler-only nested decision no longer claims that tests succeeded.

Both repair benchmarks keep their existing compiler/byte-restoration metrics and add `verificationClass` plus a separate `executedTestsRepair` field. An absent, inconsistent, failed, or unknown receipt cannot count as executed tests. This is evidence of the configured checks, not universal behavioral correctness.

`tools/self-repair-benchmark.mjs` is an older compiler-and-byte-restoration benchmark using a configured canonical runtime. It is not the command above. This acceptance case establishes the integrity and limits of existing validation policies; it does not measure corpus-trained generation quality or prove that an arbitrary test suite covers the owner's intended behavior.
