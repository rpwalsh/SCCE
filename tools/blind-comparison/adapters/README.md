# Production native bridges

These adapters call existing product lanes. They contain no repair or generation rules. Actual producer refusals and unsupported languages become completed failed outcomes; setup, transport and adapter faults remain errors. The objective grader treats `identity.productOutcome:"failed"` as false even if an unchanged file happens to pass a validator. Both outcomes remain visible in the report. Human work still requires independent ratings.

Use these absolute argument vectors as the two frozen plan systems (the surrounding seal/collect/grade commands are in the parent README):

```json
[
  "ABS_NODE", "ABS/tools/blind-comparison/adapters/scce-native.mjs",
  "--server", "http://127.0.0.1:PORT", "--run-id", "UNIQUE_CAMPAIGN_NONCE",
  "--cli", "ABS/packages/cli/dist/index.js", "--config", "OPERATOR_CONFIG",
  "--schema", "CANONICAL_CAMPAIGN_SCHEMA"
]
```

```json
[
  "ABS_NODE", "ABS/tools/blind-comparison/adapters/reference-native.mjs",
  "--runner", "ABS/tools/sealed-eval/harness/adapters/reference-ollama.mjs",
  "--runner-args", "JSON_ARRAY_OF_EXPLICIT_EXISTING_RUNNER_OPTIONS",
  "--model-digest", "INDEPENDENTLY_RECORDED_MODEL_SHA256"
]
```

The reference options must include `--corpus-manifest` pointing to a pinned **empty** `{"documents":[]}` manifest, `--model qwen2.5:3b`, explicit context/output/thread/device/seed settings and an adequate request timeout. The adapter fixes the existing declared runner to natural replies with no separate retrieval; the complete shared public packet supplies its sources and files. No new model endpoint or product model dependency is introduced. Pin the existing reference runner, all adapter modules/transitive helpers, Node binary, code build and public preparation/source snapshots. Set the reference system's `expectedModelDigest` to the same digest. Allow `SCCE_API_BEARER_TOKEN` explicitly in the candidate's `environmentKeys`; credentials never belong in case files. Optional `--cli-environment-keys JSON_ARRAY` forwards only explicitly allowed variables to the official CLI.

Choose a fresh campaign nonce and scope each case to a unique `caseId`; this gives the product stable per-case source URIs and conversations across steps without reusing an earlier campaign's dialogue. A public source correction uses the same source ID at a later step. The candidate ingests only that step's public source delta, then submits the ordinary task prompt. The reference sees the same ordered public source history in its context. Do not place the private pool, seed, rubrics or validators in either adapter's workspace or source corpus.

## Public task contract

`public.outputContract` is a JSON **string** containing the following shared machine contract. It is visible to both systems. The adapter selects the operation from this typed field; it never infers an operation from English prose or substitutes a generated implementation.

```json
{
  "schema": "scce.blind-native-task.v1",
  "operation": "code_repair",
  "maxPublicAttempts": 4,
  "writablePaths": ["src/module.ext"],
  "targetPaths": ["src/module.ext"],
  "publicChecks": [{"argv":["ABS_PUBLIC_CHECK_EXECUTABLE","ARGUMENT"]}],
  "approvals": [],
  "validationPolicy": {
    "schemaVersion":"scce.patch-validation-policy.v1",
    "id":"PUBLIC_REGISTERED_POLICY_ID",
    "commands":[{"executable":"ABS_PUBLIC_CHECK_EXECUTABLE","argv":["ARGUMENT"],"checkIds":["compiler","tests"]}],
    "timeoutMs":30000,"maxOutputBytes":131072,
    "maxWorkspaceFiles":100,"maxWorkspaceBytes":1048576,"environment":{}
  }
}
```

Use real values derived from the sealed fixture/provider. The example quantities are declarations for an example task, not product defaults. `{node}` expands to the frozen operator Node binary in `publicChecks`; the corresponding policy command uses that actual absolute binary. Shared public check argv and candidate validation-policy argv must match exactly, with common cwd and scrubbed environment. The policy cannot exceed the plan's shared time/output budgets. `writablePaths` lists the exact files the task permits changing, including any new generated tests. Public fixture tests and docs outside that list are protected against modification. Only public feedback can be sent back during attempts; held-out native checks run later in the private grader.

### Route and category mapping

| Registered category | Operation | Actual candidate lane |
|---|---|---|
| chat | `turn` | Ordinary `/api/turn?full=1`, actual prompt and stable conversation |
| creative | `turn`, `requestedAuthority:"creative"` if the task requests it | Same ordinary turn producer |
| corpus facts | `turn`, public sources and their admission/trust | `/api/ingest` then ordinary factual turn |
| code repair, any admitted language | `code_repair` | Official CLI `code --root=<public workspace> --path=... --validation-policy=...`; shared learned proposer/code mouth |
| code generation, any admitted language | `code_generation` | Verified ordinary program artifacts, or workspace turn → reviewable native plan → exact approved patch transaction |
| learning updates | `learning_update`, ordered source steps | Official `/api/ingest` with current public delta → ordinary turn; later questions test the actual new knowledge |
| agentic/tool use | `tool_use` | Exact public typed `/api/executive/run` goal, or ordinary action turn with actual capability-success events |

Chat, creative, factual and learning contracts still declare `maxPublicAttempts`, `writablePaths` (usually `[]`), `publicChecks` (possibly `[]`) and `approvals` (usually `[]`). Put the requested answer format in the actual public prompt, or in `responseInstruction`, which is appended unchanged to the candidate prompt and included in the reference's shared contract. Answers remain the actual product text; the adapter does not translate prose into gold-compatible JSON or convert an abstention with an English detector. Use private semantic/native validators appropriate to that public response contract.

Factual negatives should use the same public `answerMode:"answer_or_abstain"`, `requestedAuthority:"factual"` contract for **both positive and negative cases**. An ordinary candidate answer is normalized to `{"status":"answered","answer":"actual text"}`. A real 422 `scce.runtime.withheld_surface.v1` receipt with a declared withheld reason and no answer becomes `{"status":"abstained","answer":null}` under that factual contract. A conflicting nonfactual receipt authority is rejected. Semantic epistemic-force values do not determine abstention. The reference must emit one of those exact JSON forms. No English refusal substring or expected answer is consulted. Both raw response and normalized outcome hashes are retained. The private validator decides whether abstention is correct: the same receipt passes an unsupported negative and loses a supported positive. Unsupported code/tool operations and unrelated 422s remain failures. Raw chat and creative text is never wrapped in an invented explanation or automatically judged.

For each step with sources, include explicit public `sourceAdmission` and `sourceTrust` objects accepted by `/api/ingest` (six trust dimensions, independence group, access scope and license status). Optional `sourceMediaTypes` maps source IDs to media types; otherwise text/plain is used. These are the source owner's declarations, not scores derived by the evaluator. Public source bytes and their SHA-256 enter the ingestion receipt; task prompts, reference replies and private validation feedback are never ingested by this bridge.

For `code_generation`, select the lane explicitly. `programMode:"verified_artifacts"` sends an ordinary program turn and accepts only `program.readiness.verified` artifacts whose count, IDs and content hashes match. The adapter writes those emitted bytes to the public workspace and runs the shared public checks. `programMode:"workspace_plan"` (the default) additionally requires `validationPolicyId`, `validationChecks` and `targetPaths`. It calls `/api/workspace/init` for the current public workspace, supplies the typed workspace selector on the turn and applies only the returned native plan through `/api/workspace/patch`. Include `workspace.patch.apply` in `approvals` only if the sealed task authorizes it. The adapter approves only the exact pending plan for that capability, then repeats the identical request; native validation and rollback remain authoritative. No plan is treated as execution. The server must already register the public policy, allow the collector workspace under its allowed roots and permit mutation. Workspace-plan cases must run serially because the existing product selects the latest workspace globally. Private validators are never registered as server policies.

Generation may explicitly set `allowNewFiles:true` to admit new local source/test artifacts while preserving every original public file outside `writablePaths`. Unchanged original artifacts can be emitted by identity; changed driver/check/spec bytes remain forbidden. This accommodates the product's required generated tests without authorizing test weakening. The reference gets the same scope and native structured-output schema; raw human tasks omit structured format. Tool execution artifacts used only inside an isolated executor are retained as execution provenance rather than blindly copied into the requested public output scope; actual requested file effects must exist or be emitted as verified artifacts before capture.

Repair uses the official CLI because `/api/workspace/code` always uses the server-configured workspace root and accepts no per-request root. The CLI's public `--root` routes to the same learned repair path while preserving its native compile/test gate and rollback. The current producer has a minimum four-iteration ceiling; preregister an appropriate public attempt budget. If its actual reported attempts exceed the sealed budget the adapter returns a failed budget outcome. The same declared attempt count bounds reference proposal/public-feedback rounds. The reference accepts only exact JSON `{"answer":"...","artifacts":{"path":"complete text"}}`; no fence stripping, language guessing or repair templates are used. Both sides run the identical public checks against actual files. Directory deletion/binary artifact tasks are outside this current text-artifact envelope and must be preregistered as uncovered rather than silently removed.

For explicit local tool tasks, include the product's exact `scce.local_executive_goal.v1` value in `executiveGoal` and allow `process.build_test` when intended. Its public tasks contain their source artifacts and native build/test commands with cwd `.`. Scope episode/goal/task IDs uniquely per campaign so historical ACTS replay does not masquerade as a fresh execution. The candidate sends that goal unchanged to the real executive and requires a succeeded disposition. The reference must select the exact supplied goal in its strict machine response (`executiveGoal` plus `answer` and `artifacts`); the host then executes the same dependency-ordered public build/test jobs in isolated public subdirectories. A proposal, prose claim or successful scheduling alone does not count. Broader natural-language tool planning uses the actual ordinary action turn; it must return real `CapabilitySucceeded` events, including any preregistered `requiredCapabilityIds`, and no failure events. Unsupported or unexecuted actions fail. This bridge does not claim that a fixed public build/test goal establishes general autonomous tool use.

## Conditions the operator must establish

No live service is started by these modules. The independent operator must supply the already-built SCCE CLI, running configured server, installed pinned reference, real public source preparation and adequate context window. Candidate server and CLI must address the same declared brain/config. The unique nonce separates dialogue/source identities; it does **not** isolate the canonical corpus or reset remote caches. Use independently audited preparation/snapshots or ensure both systems have access to the entire same cumulative public corpus. A namespace alone is not an evidence-access sandbox. Generated answers from prior cases must not become an undeclared reference advantage or source leak. Language acquisition/training must use the ordinary source producer and be attested; an HTTP ingestion receipt alone does not prove a particular model learned the new fact.

Trusted-host limits remain as documented in the parent README: no OS sandbox, network block, RAM/CPU/GPU quota or remote-process kill guarantee is implied. Bind public tool capabilities and measured resource limits in the external provider attestation. Check that full public context fits the pinned reference context window without truncation. A provider/transport/setup failure blocks the campaign; a real producer refusal is scored as failure and retained for improvement. Neither a rehearsal nor a partially supported campaign can establish broad superiority.
