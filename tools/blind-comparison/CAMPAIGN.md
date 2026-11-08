# Default local campaign: no handpicked cases required

After installing the frozen repository dependencies/build and starting the configured local SCCE service with the pinned reference already installed, run:

```powershell
node tools/blind-comparison/campaign.mjs run --out .tmp/independent-campaign
```

This is a **real SCCE versus local reference campaign**, not the deterministic fixture rehearsal. It discovers the repository's ordinary local config without printing/copying credentials, checks readiness, obtains the actual installed reference digest using the existing declared host probe, inventories native toolchains, freezes code/build/provider/scorer/tool identities, then starts an automated custodian subprocess. Only after freeze verification does that subprocess draw a cryptographic selection seed and generate fresh synthetic sources and private checks. Collection uses the production native bridges. Anonymous human ballots and an explicitly incomplete report are emitted afterward. No cloud account, deployment or operator-authored test cases are needed.

The reference is explicitly configured for a 32768-token context and up to 4096 output tokens. Typed public task contracts select the model's native structured-output schema per request; raw chat/creative text is unconstrained. These settings leave the legacy runner defaults unchanged. The existing declared runner sends no-truncation/no-shift controls and fails visibly on exhausted output. Verify the installed runtime actually supports those controls and residency/context accounting before collecting; the runtime version is recorded, and unsupported/older implementations are not silently certified.

Preparation now verifies those conditions automatically **through the existing declared runner** before freeze. A 48000-byte synthetic ASCII input at 1024-token context must be rejected with HTTP400 and typed `exceed_context_size_error` evidence reporting the actual prompt/context counts. No English error-message guessing is accepted. A subsequent short native-schema probe at the real campaign settings must satisfy a schema-only random nonce absent from its contradictory plain-text prompt, record normal completion, and restore exact model/digest/runtime/context/device residency. Ignored schema/truncation controls, changed identities, missing machine accounting or exhausted output stop setup. The frozen `preparation/reference-admission.json` contains only hashes and allowlisted metadata, no raw prompt/error or grading material.

Resource choices can be preregistered explicitly, for example:

```powershell
node tools/blind-comparison/campaign.mjs run --diagnostic --out .tmp/local-diagnostic --threads 4 --device cpu --context-tokens 32768 --output-tokens 4096 --max-reference-model-bytes 4000000000
```

The optional model-byte ceiling applies to the daemon's **reported model allocation at admission**, not total server/product RAM, process RSS, or an operating-system memory quota. If omitted, the observed allocation is recorded as the admitted observational bound. Per-answer residency remains in the existing reference receipts; this preflight does not invent runtime memory enforcement. Process RSS and total product RAM remain unmeasured/null. Threads/device are requested settings, not a fabricated hard OS CPU/GPU isolation claim.

For the first diagnostic iteration, use:

```powershell
node tools/blind-comparison/campaign.mjs run --diagnostic --out .tmp/local-diagnostic
```

Diagnostic mode uses two fresh cases per cell, records missing providers/toolchains as blocking errors and can never establish superiority. The default held-out campaign uses twelve per cell, a paired sign-test threshold of 0.05 per cell, zero losses and a strict win in every cell. Missing native providers/toolchains refuse held-out collection; their complete inventory is written to `coverage-blockers.json`. Do not tune the threshold or discard difficult languages after seeing results. Fixes require a new implementation freeze, new output directory and new custodian seed. Do not reuse a disclosed evaluation set as fresh evidence.

The default manifest declares TypeScript, JavaScript, Python, Rust and Go native fixtures plus English, Russian, Spanish and Catalan natural tasks. It is a declaration of **campaign sources and tasks**, not proof that SCCE has admitted or mastered them. The canonical admitted model inventory, if present at `.tmp/admitted-language-inventory.json`, is automatically snapshotted and unioned. Use `--admitted-public-manifest FILE` for an independent public-source inventory. Formal legacy-language declarations remain in coverage even when unavailable. Script identities such as Latin/Cyrillic are retained as source metadata and never treated as locale labels. The report separately records prior model admission, case source preparation, toolchain presence and privately proven task outcomes.

## What gets tested

The cells remain separate in reports; no overall average hides a losing language, task family or missing judge:

- Two-turn practical chat with a changed constraint, and two-turn creative scenes with continuity, motives and an unresolved choice. Quality stays ungraded until independent anonymous ballots are supplied.
- Source facts drawn from fresh test-authored directories, using private selection among differently worded questions. Supported and unsupported questions share the **same public category and response contract**. Their positive/negative labels and grading values remain private until outputs are fixed.
- Live source corrections followed by a second lookup in the same conversation. Earlier and updated source bytes reach both systems in the same step order. Future updates are not shown early.
- Native repair and generation in each declared formal language, with separate stateful-directory and piecewise-numeric cells. Both see the same source/specification/immutable driver/public checks. Private validation adds fresh keys, overwrites, deletion, key isolation, Unicode/prototype-shaped keys, missing values and unseen numeric boundaries. Public examples alone cannot satisfy the private checks by memorizing constants.
- Autonomous inspect/aggregate/write/verify tasks under a bounded `workspace.read`, `workspace.write`, `public.check` policy. No plan is supplied. These remain distinct from execution of a supplied typed dependency-ordered local goal. A plan, prose claim or prewritten-goal execution does not certify autonomous planning.

The factory is test-authored and frozen, not a model judge. All invented directory entries, names, desks, extensions, keys and binders are synthetic. A secret seed changes the actual requests, values and private checks after implementation freeze. A fixed balanced pool is generated per cell and all its preregistered cases are selected; opaque IDs and keyed rankings determine order. This guarantees positive/negative and task-family coverage without exposing gold labels or allowing post-result selection. Factory design is known; that limits the claim to this finite registered task distribution. Broader applications, additional languages and capabilities need additional independently registered providers. No finite suite proves universal superiority.

## Custody and independent operation

Automatic mode records `automated-custodian-on-trusted-operator-host`, **not independent custody**. Its seed and private pool live in an OS temporary directory outside the repository/public ingestion root. The collecting process receives only the sealed public bundle and a metadata receipt. Private native grading runs after the collection checkpoint on a receipts-only copy under the custodian root, so private checks never enter a source-ingestion workspace. The runner does not claim OS isolation or protection against a malicious host/submission; use external containment for that condition.

A genuinely separate custodian can use the same factory without inventing cases:

```powershell
node tools/blind-comparison/campaign.mjs prepare --out .tmp/external-campaign
# Independently record freezeDigest from prepared.json before creating/disclosing the secret seed.
node tools/blind-comparison/campaign.mjs custodian --prepared .tmp/external-campaign/prepared.json --freeze-digest FREEZE_SHA --private-root ABS_PRIVATE_DIRECTORY_OUTSIDE_REPOSITORY --seed-file ABS_PRIVATE_SEED_FILE
```

The custodian command verifies every frozen artifact before generating the pool. It emits only custody paths/hashes, not the seed or gold. Preserve that receipt as `custody.json`, transfer only its `publicBundleRoot` into `OUT/public`, and run the normal collection command from the parent README using `bundleDigest`. Independently record the checkpoint digest. An external seed alone does not fabricate an independent-person attestation. The same frozen provider and seed regenerate case content; pin host tool identities too when reproducing native commands.

## Resume, shards and final judging

```powershell
node tools/blind-comparison/campaign.mjs resume --out .tmp/independent-campaign
```

Accepted receipts are reused and their journal hashes rechecked. The code and frozen files must still match; changing the product during a campaign refuses continuation. Partial collection can use `--shard-count N --shard-index I`; every later shard must use the same N. Missing shards remain missing cells, never successes. Keep independent freeze, seal and checkpoint commitments outside the mutable run directory. Do not remove a stale shard lock until the prior collector is proven dead.

After independent reviewers return the complete rating file, calculate its SHA-256 externally and finish with the exact checkpoint printed by collection:

```powershell
node tools/blind-comparison/campaign.mjs finish --prepared OUT/prepared.json --custody OUT/custody.json --checkpoint OUT/checkpoint.json --checkpoint-digest CHECKPOINT_SHA --ratings RATINGS.json --ratings-digest RATINGS_FILE_SHA
```

`finish` emits every cell plus a private-family breakdown, showing positive refusal losses separately from correct negative abstentions, and keeps native/public failures visible. The registered judge ID defaults to `independent-judge`; see the parent rubric schema. Never generate or forge those ballots. Until they exist, broad superiority is not established even when objective constraints pass.

## Experimental limits

The bootstrap binds inputs and provides executable tasks; it cannot certify an honest operator, an independent custodian, a clean initial remote brain, a complete historical source-admission inventory, or equal OS resource quotas. The unique campaign nonce separates conversations and source IDs, not the whole canonical corpus. Declare any prior corpus available to the product and the reference, prevent private evaluation material from being ingested, and preserve event/source preparation receipts. Keep future case updates sequestered until their turn. Do not ingest this benchmark's factory/private checker code as training material. The existing reference receives full current public packets; its pinned context window must fit them without truncation. Source/script metadata is not a task-success score.

Default process containment is explicitly trusted-host: environment/workspace/tool allowlists, elapsed/output/artifact limits and declared call limits; no fabricated CPU/RAM/GPU/network sandbox is claimed. Existing product routes may have additional intrinsic limits; returned overruns or unsupported operations are retained as failures. External isolation/resource attestations remain necessary for corresponding claims. Public preparation, acquisition and actual operation time are included in collection; unmeasured resource quantities are not silently zeroed. The result is a finite-scope experiment, not a universal product claim.
