# Independent application acceptance

Run an owner-published, hash-pinned application plan against the ordinary local product:

```powershell
node tools/application-acceptance.mjs OWNER_PLAN.json --plan-sha256=LOWERCASE_SHA256 --config=scce.config.json --out=.scce/verification/application-acceptance.json
```

The runner reads the configured bearer token (or `SCCE_API_BEARER_TOKEN`) and server URL (`SCCE_SERVER_URL` may override it). Only credential-free loopback URLs are accepted. It uses ordinary compact `/api/turn`, verifies artifact-wire references, and performs exact `/api/session/approve` / unchanged-request retries. It never grants operator authority or requests full diagnostics.

The plan schema remains `scce.application_acceptance_plan.v1`. Required categories are `typescript_web_crud`, `python_service_cli`, `kotlin_android_phonebook`, and `semantic_debug_repair`; additional categories/languages are allowed. These are required qualification cells, not a claim that every backend exists. Missing toolchains, unsupported output languages, absent applications, or failed checks remain failures. The original semantic-repair cell retains its ordered failing/passing build and test requirements.

Each case contains:

- `id`, `category`, `expectedLanguage`, a public `spec`, and exact `requiredGeneratedPaths`.
- `publicValidation: { permission, toolInventory, sha256 }`. The permission is the existing `scce.blind-native-validation-permission.v1` descriptor, published by the owner **before generation**, with exact provider, native build/test commands, ephemeral working directory, tool identity, target/protected paths, and file/byte bounds. `toolInventory` is the corresponding public `native-tools.json` object. `sha256` hashes the canonical JSON `{permission, toolInventory}`. Permissions never come from generated manifests.
- `heldOut: { files, command, args, cwd, env? }`. Every file declares `kind: "unit" | "e2e"`, `sourcePath`, `targetPath`, and its lowercase SHA-256. Both kinds are mandatory. Paths stay inside the plan and isolated check directories; tests cannot overwrite `generated/` or `.acceptance-result.json`.

An unavailable required cell may instead declare `coverageBlocker: {schema: "scce.application_coverage_blocker.v1", languageId, reasonId, detail}`. Its exact required category, language and public spec remain in the plan, but it supplies no fabricated `publicValidation` or `heldOut`. The runner records that cell as **failed**, performs no API/native action for it, and the aggregate cannot pass. An ordinary cell missing its permission/checks remains invalid.

Only the public spec and conversation identity reach SCCE. Independent test files, their contents, expected values, and the fresh execution nonce are never ingested or submitted. After output, the runner verifies readiness and all returned file hashes, reads the hash-verified `program.graph.json` language/commands, checks them against the published permission, and requires real successful native build/test events and execution receipts. If an approval occurred, final file identities must equal the approved identities.

Generated files go under a new OS temporary directory's `generated/` subtree. Independently pinned checks are copied outside that subtree **after** output. The trusted check command receives scrubbed OS-support environment plus explicitly pinned check environment and:

```text
SCCE_GENERATED_ROOT
SCCE_ACCEPTANCE_CASE
SCCE_ACCEPTANCE_RUN_NONCE
SCCE_ACCEPTANCE_RECEIPT_PATH
```

The independent command must actually assert the application behavior, exit successfully, and write a fresh `scce.application_test_receipt.v1` JSON object with matching `caseId` and `runNonce`. Its `tests` array must contain separate `unit` and `e2e` rows, positive integer executed/passed counts, zero failures, and exact `generatedArtifacts: [{path, sha256}]` exercised by those assertions. Exit zero or printed passing text without a valid receipt does not pass. The runner rehashes all generated and independent test files after execution, rejecting modifications or disappearance.

Budgets come from the existing blind campaign defaults: one shared 180-second case budget, 2 MiB response/process-output and generated-artifact bounds, 4 MiB plan/check-file bound, and at most four distinct approval steps. Approval retries and independent execution consume the same case time budget. No budget is raised for a failing cell. Reports preserve plan/spec/permission/response/artifact hashes, native attempt command/output hashes and timings, approval calls, independent process outcome/counts, and failures. Temporary workspaces remain named in the report for inspection; remove only those exact owned directories after review.

This is a trusted-host independent-check harness, not an OS sandbox. Untrusted generated code shares the host filesystem with the check process; immutable-file rechecks detect changes but do not prove filesystem secrecy against a hostile program. A runner self-test passing does not establish SCCE application quality, blindness against hostile filesystem access, or successful unsupported-language generation. Only actual generated output passing the owner's independent assertions qualifies the relevant cell.
