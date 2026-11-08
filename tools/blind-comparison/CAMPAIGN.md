# Default local campaign: no handpicked cases required

## Engineer prerequisites

Start from a clean clone at the revision being evaluated, using Node.js `>=24.18.0 <25`, the repository's pinned pnpm version, and PostgreSQL. For example, before any freeze or secret selection:

```powershell
git clone https://github.com/rpwalsh/SCCE.git
cd SCCE
git checkout YOUR_EVALUATED_REVISION
pnpm install --frozen-lockfile
pnpm build
```

Follow the [quickstart](../../QUICKSTART.md) to create your local database and ignored `scce.config.local.json`; keep credentials local. Initialize or upgrade that configured schema with `pnpm scce db migrate`. Compile your declared public starter sources through the [normal corpus training commands](../../docs/CORPUS_TRAINING.md), inspect the completed active source-brain receipt, and use that same config/schema when serving. An empty database, incomplete source build, or unknown language identities does not meet campaign preparation's finalization contract. The parent [README](README.md) gives the metadata-only identity finalizer for an older brain. Record the initial brain and available public corpora; installing source files without compiling them is not training, and compiling them is not a task-success claim.

Install the local Ollama runtime and `qwen2.5:3b` reference model before preparation, and make the Python, Rust and Go native checkers available through the existing verifier discovery. Node and the installed TypeScript dependency supply the other two formal-language checkers. Preparation records the actual resolved executables and model digest and checks schema/context controls; missing tools or failed checks remain blockers. The reference is an evaluation dependency, not an SCCE runtime dependency.

Start SCCE with `pnpm server` using the same local configuration. A custom config must be passed consistently to CLI training, serving and the campaign's `--config FILE`; the configured local URL, authentication and schema must agree. The campaign output directory must fall inside the runtime's configured `allowedRoots`, since public code workspaces are ingested there. Do not change those frozen inputs during collection.

## One-command locally custodied run

With these prerequisites complete, run:

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
- Ordinary natural-language arithmetic in English, Russian, Spanish and Catalan, balancing single-operation and multistep tasks with fresh private integers and operations. Both systems receive the same number-only instruction through their ordinary turn path. Exact private integer grading rejects refusals, wrong values, prose, equations and extra numbers; no calculator representation or answer is supplied.
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

**Current portability limitation:** the signed preparation and freeze contain absolute paths, including `prepared.out`, artifact files, interpreter/tool binaries and adapter arguments. `custodian` rehashes those files and requires `prepared.json` at its original signed location. A separate host therefore needs a byte-identical, path-preserving mirror of the frozen public implementation/build/artifacts and preparation directory, on a compatible host filesystem. Copying only `prepared.json` and `freeze.json` to a new root will fail. Do not rewrite signed paths or hashes to bypass this check. If a mirror is unavailable, prepare a new freeze at the intended paths before the custodian chooses a fresh seed. Configure any required local credentials independently; no credential transfer is required by this workflow.

On the collection host, preserve `OUT` as the original absolute preparation directory, copy only the sealed public tree to `OUT/public`, and save the custodian's emitted metadata receipt as UTF-8 `OUT/custody.json`. The pool, seed, private key and private validators stay on the custodian host. Collect with:

```powershell
node tools/blind-comparison/cli.mjs collect --bundle OUT/public/bundle.json --bundle-digest BUNDLE_SHA --out OUT/run --checkpoint-out OUT/checkpoint.json
```

After collection, retain the printed checkpoint digest independently. Return `OUT/checkpoint.json` plus `OUT/run/run.json`, `OUT/run/journal-*.jsonl` and `OUT/run/receipts/` to the corresponding original paths on the custodian's frozen mirror. Preserve their bytes; include every collected shard. Run the `finish` command below **on that custodian host**, where the signed `custody.privateRoot` and `custody.privateKeyFile` still exist. `finish` makes its own receipts-only grading copy there. Anonymous ballots can leave that host for judges; return only their complete ratings file and independently recorded digest. The collection host does not need the private key or validators to collect or checkpoint.

## Resume, shards and final judging

```powershell
node tools/blind-comparison/campaign.mjs resume --out .tmp/independent-campaign
```

Accepted receipts are reused and their journal hashes rechecked. The code and frozen files must still match; changing the product during a campaign refuses continuation. Partial collection can use `--shard-count N --shard-index I`; every later shard must use the same N. Missing shards remain missing cells, never successes. Keep independent freeze, seal and checkpoint commitments outside the mutable run directory. Do not remove a stale shard lock until the prior collector is proven dead.

After independent reviewers return the complete rating file, calculate its SHA-256 externally and finish with the exact checkpoint printed by collection:

```powershell
node tools/blind-comparison/campaign.mjs finish --prepared OUT/prepared.json --custody OUT/custody.json --checkpoint OUT/checkpoint.json --checkpoint-digest CHECKPOINT_SHA --ratings RATINGS.json --ratings-digest RATINGS_FILE_SHA --require-pass
```

`finish` emits every cell plus a private-family breakdown, showing positive refusal losses separately from correct negative abstentions, and keeps native/public failures visible. The registered judge ID defaults to `independent-judge`; see the parent rubric schema. Never generate or forge those ballots. Until they exist, broad superiority is not established even when objective constraints pass.

For CI and final handoff, `--require-pass` returns exit status 0 only when the normal verified grading path computes `comparativeGatePassed: true`; a false or pending gate returns 1 after writing the report and printing its path/digest. It does not trust an edited prior report or change any threshold, cell or judge requirement. The flag also works on `run` and `resume`. Without it, generating a valid incomplete/failed report still exits 0, including the ordinary diagnostic workflow; protocol and infrastructure errors still fail.

## Experimental limits

The bootstrap binds inputs and provides executable tasks; it cannot certify an honest operator, an independent custodian, a clean initial remote brain, a complete historical source-admission inventory, or equal OS resource quotas. The unique campaign nonce separates conversations and source IDs, not the whole canonical corpus. Declare any prior corpus available to the product and the reference, prevent private evaluation material from being ingested, and preserve event/source preparation receipts. Keep future case updates sequestered until their turn. Do not ingest this benchmark's factory/private checker code as training material. The existing reference receives full current public packets; its pinned context window must fit them without truncation. Source/script metadata is not a task-success score.

Default process containment is explicitly trusted-host: environment/workspace/tool allowlists, elapsed/output/artifact limits and declared call limits; no fabricated CPU/RAM/GPU/network sandbox is claimed. Existing product routes may have additional intrinsic limits; returned overruns or unsupported operations are retained as failures. External isolation/resource attestations remain necessary for corresponding claims. Public preparation, acquisition and actual operation time are included in collection; unmeasured resource quantities are not silently zeroed. The result is a finite-scope experiment, not a universal product claim.
