# Independent blind comparison

This is an evaluation tool, outside SCCE. It does not generate product behavior. A passing report describes only its preregistered finite coverage; it cannot prove superiority on every possible task or language. No production SCCE/Qwen result is supplied here.

The default inventory includes `math_reasoning` in EN/RU/ES/CA, bringing its declared cells from 44 to 48. This uses ordinary natural-language turns for both systems, with no source teaching, calculator API, forced arithmetic representation, or reference JSON/schema constraint. Each unchanged even per-cell count balances single-operation and multistep families; the seed chooses fresh integers and operations. Families and exact results remain private. The translated public contract requests one signed base-ten integer; private grading rejects refusals, wrong values, prose, equations and extra numeric answers. Existing code-numeric vectors and all other cells and acceptance thresholds remain unchanged. These cells measure capability; their presence does not imply SCCE passes them.

Run the complete offline protocol rehearsal from a clean output directory:

```powershell
node tools/blind-comparison/cli.mjs smoke --out .tmp/blind-rehearsal
node --test tools/blind-comparison/tests/*.test.mjs
```

The rehearsal has chat, creative writing, source facts including an unsupported negative, JavaScript repair with native hidden assertions, a multistep source task, and a source correction. Its two deterministic fixture adapters are **neither SCCE nor Qwen**. The agentic fixture exercises the multistep contract; it does not demonstrate autonomous tool use. Chat/creative ballots are deliberately ungraded. `comparativeGatePassed` remains false even if all rehearsal ballots are supplied.

Ordinary dialogue training now finalizes its exact trained profile assignments after source publication. For a brain prepared by an older build, run the existing metadata-only finalizer against the same config/schema before preparing a new campaign:

```powershell
node packages/cli/dist/index.js --config scce.config.json --schema YOUR_BRAIN language identities --rebuild
```

This reads stored profile signatures and assigns learned identities; it does not reingest or recompile source files. The serving kernel reloads the persisted catalog on the durable language-memory revision. Campaign preparation calls the authenticated read-only `/api/language/finalization` endpoint and freezes its receipt: every accessible current profile must have a known identity, the loaded and durable catalog digests must match, the read must span one stable revision, and an actual brain activation must exist. Missing assignments or a stale server block setup. `preparation/candidate-finalization.json` preserves counts/digests and the actual active-brain marker. It is an identity-finalization check, not a task-capability or locale-coverage certificate; shared script and supplied language aliases never count as proof of competence. Existing coverage gaps and failed cases remain visible.

## Roles and custody

1. Implementer freezes the implementation, adapters, scorer, public corpora, resource provider and preregistration. Save the printed freeze digest outside the working directory. Freeze all transitive adapter dependencies, binaries, build/brain manifests and public training snapshots as artifact files; pin a tree by listing every file or a verified immutable archive. A git commit string alone does not pin uncommitted files or a build. Pinned files are streamed through SHA-256 again before collection and grading.
2. Independent custodian supplies the case pool and secret selection seed **after** that freeze. The tool cannot certify when a person knew a seed: record a dated custody attestation externally. Pool IDs must be lexicographically sorted and unique. Deterministic SHA-256 ranking chooses the registered number of cases in every category/language/grader cell. Insufficient cells fail sealing. The public seal commits the pool, seed, selected public packets and private grading hashes.
3. Runner receives only `sealed/public`, verified implementation artifacts and the public source/preparation snapshots. Custodian keeps `sealed/private`, the pool, seed and validator files off the collection host when possible. Do not ingest grading files, rubrics, expected answers or future source updates. A multi-step case exposes only the current and previous public steps.
4. Runner executes both systems with equal public context and shared budgets, saves the checkpoint digest externally, then gives fixed outputs to the custodian. Do not retry failed cases selectively or tune against the held-out set. A new implementation requires a new freeze and fresh held-out selection.
5. Custodian creates anonymous ballots and gives them to independent human judges. Judges return ratings with a separately communicated file SHA-256. Native private checks run only after the output checkpoint; their feedback never goes to a system. Custodian publishes the report, every cell and case failure, resource attestation, freeze/seal/checkpoint commitments, and eventually the seed/pool for independent selection replay. Publish private checks only after this evaluation set is retired.

## One collection command after sealing

With an independently supplied bundle digest and prepared production adapters:

```powershell
node tools/blind-comparison/cli.mjs collect --bundle sealed/public/bundle.json --bundle-digest BUNDLE_SHA --out run --checkpoint-out checkpoint.json
```

The same command resumes accepted receipts without calling either adapter again. Keep the printed checkpoint digest outside `run`. Interrupted attempts without an accepted receipt can run again; accepted error receipts are retained. A stale `shard-N.lock` after a machine crash requires the operator to establish that the old collector is dead before removing that lock. Do not run two collectors for the same shard.

For independent shards, use the same `--shard-count N` and distinct `--shard-index I`, sharing the output directory. Case assignment is index modulo N and system order is counterbalanced using the existing head-to-head measurement helper. After all shards finish, run `checkpoint --bundle ... --bundle-digest ... --out run --checkpoint-out checkpoint.json`. Partial runs produce missing cases, never a win. Collection processes one case and output at a time. The selection reservoir and seal indexes scale with the preregistered selected count, not full pool payload; declare bounded shard pools for larger campaigns. There is no hidden fixed case cap.

## Prepare, seal, judge and report

```powershell
node tools/blind-comparison/cli.mjs freeze --plan plan.json --out freeze.json
node tools/blind-comparison/cli.mjs seal --freeze freeze.json --freeze-digest FREEZE_SHA --pool private/pool.jsonl --seed private/seed.txt --out sealed
# Transfer public material and collect using the command above; return run and checkpoint.
node tools/blind-comparison/cli.mjs blind --bundle sealed/public/bundle.json --bundle-digest BUNDLE_SHA --out run --key sealed/private/key.json --checkpoint checkpoint.json --checkpoint-digest CHECKPOINT_SHA --ballots ballots
node tools/blind-comparison/cli.mjs grade --bundle sealed/public/bundle.json --bundle-digest BUNDLE_SHA --out run --key sealed/private/key.json --checkpoint checkpoint.json --checkpoint-digest CHECKPOINT_SHA --ratings ratings.json --ratings-digest RATINGS_FILE_SHA --report report.json
```

Omit ratings arguments to obtain an explicitly pending report. `report.json` lists category **and language and grading mode**, all case outcomes and checks. Missing, ungraded, unsupported, infrastructure errors or any local loss blocks the gate. Ties alone do not establish a win. The first registered system is the candidate. The exact one-sided paired sign test must meet the preregistered `maximumOneSidedPPerCell` (strictly below 0.5); the gate also requires `minimumPairsPerCell`, zero losses and at least one strict win in every cell. Choose meaningful sample sizes in advance. The tool does not turn small samples into a universal superiority claim or pool away a losing language.

## Provider and adapter contracts

See [adding task/language providers](EXTENDING.md) for the existing external-pool workflow with unchanged graders, and [process resource accounting](PROCESS-RESOURCES.md) for optional `--process-policy` measurements frozen before selection.

The generated rehearsal `plan.json` and `pool.jsonl` are executable examples. Replace fixture identities and `purpose` with `heldout` for a real campaign. Register the strongest required cells before selection, including unsupported languages. Each plan lists shared positive budgets (`timeMs`, `outputBytes`, `caseBytes`, `artifactBytes`, `maxSteps`), two system identities, absolute pinned adapter command argument vectors, allowed environment names, categories supported, source preparation and resource identities, independent judge IDs and the acceptance rule. Pin every public corpus snapshot and each source-preparation receipt. A source update is a later public step, rather than a hidden mutation to one system's corpus. Put any source-specific tool instructions in the shared public packet. An implementation archive, model manifest/digest, scorer archive and isolation receipt belong in `artifacts`.

Held-out plans additionally require a `model` artifact, reference `identity:{model:"qwen2.5:3b",...}` and its 64-hex `expectedModelDigest`. Both system preparations must be objects containing the same complete `publicCorpusArtifacts` list and their own pinned `receiptArtifact`. Set `coverageInventoryArtifact` to an artifact with role `coverage`: its independently owned JSON `{cells:[{category,language,grading},...]}` must include every required category and ingested language. Omitting any inventory cell refuses freezing. This prevents dropping an inconvenient language from a later report; the custodian remains responsible for a complete inventory of the user's intended tasks.

Adapters are arbitrary external providers invoked without a shell, once per visible step, in a fresh directory holding the shared public files. Standard input is one `scce.blind-input.v1` JSON line: category, language, output contract, visible steps, prior responses, budgets and isolation declaration. Standard output must be exactly one JSON object:

```json
{"status":"ok","answer":"text or exact semantic JSON","artifacts":{"src/example.ext":"complete file text"},"identity":{"modelDigest":"pinned digest when required"}}
```

Use `unsupported` or `error` instead of silently omitting a task. Artifacts use relative slash-separated paths; parent traversal, drive paths and duplicate private-validator targets are rejected. Public sources are explicit `{id,text}` values; public file content is a path-to-text object. No private metadata keys are accepted in the public case schema. Native validators and semantic gold are committed separately and never sent to adapters. Providers must limit tools/workspaces/network/credentials as attested: a tool transcript, allowlist and environment/resource policy must be pinned with the provider. There is no built-in unconstrained shell tool. To support arbitrary languages or real agent tasks, provide a production adapter that uses SCCE's ordinary review/rollback path and the reference's same public tools; seal private native checks in that language. Unsupported operations remain visible failures.

`adapters/reference-bridge.mjs` invokes the existing declared sealed-eval reference process unchanged. Its argv accepts `--runner ABS_PATH_TO_EXISTING_REFERENCE`, `--runner-args JSON_ARRAY`. Supply an empty corpus manifest (`{"documents":[]}`), `--model qwen2.5:3b`, explicit context/output/device/thread/seed options and a public manifest as those runner arguments. Both bridges serialize the same complete public packet as prompt, so the reference receives the same source text and files instead of being compared closed-book against an ingested corpus. The inherited reference system instructions are part of the pinned adapter identity. Set `expectedModelDigest` on the reference system; its actual returned model digest must match. Preserve model/runtime/device receipts and freeze the public source budget: the operator must ensure the full prompt fits the declared context window, without silent truncation.

`adapters/scce-text.mjs --server URL` uses the existing authenticated measurement client and ordinary `/api/turn`. Allow `SCCE_API_BEARER_TOKEN` explicitly in `environmentKeys`. It supports text tasks only and rejects code, agentic and learning-update categories. A full product adapter must call the real code, learning and tool operations; this text bridge cannot certify those capabilities. Bind the SCCE build, brain snapshot, source-admission list and preparation receipt, so extra ingested sources cannot confer an undeclared information advantage. Preparation attestations are an independent audit requirement, not something a JSON hash proves.

Each private pool row is `{id,category,language,grading,public:{steps,outputContract},private:{...}}`. Semantic checks compare complete parsed JSON against one exact expected value per step, preserving values/types/extra fields and negative contracts; no substring matching or English refusal detector is used. Native checks specify `argv` (`{node}` expands to the pinned operator Node binary) and private files `{path,target}`; file bytes are committed by the seal, copied only after output fixation, and exit status is the result. Include native regression tests and API/scope preservation in those validators. Human checks specify `dimensions` and a concrete `rubric`; a rating is `{ballotId,judgeId,humanAttestation:true,preference:"A"|"B"|"tie",scores:{A:{dimension:0},B:{dimension:0}},rationale}` with every registered dimension scored 0–4. No automatic model judge is provided. One registered independent judge per ballot is the current protocol; use a separately preregistered adjudication process before submitting a final rating.

## Isolation and resource limits

The built-in provider is a **trusted-host process runner, not an OS sandbox**. It scrubs ambient environment variables, uses a fresh public working directory, rejects path traversal and bounds elapsed time, output and submitted artifacts. It does not prevent filesystem or network access, inspect an adapter's remote server state, constrain descendants on Windows, or enforce memory/CPU/GPU limits. Private files on the same host are not inaccessible. Its command timeout kills the child (POSIX process group); hostile or remote processes need an external containment provider. Do not claim access/resource equality from this runner alone. The manifest must name the actual isolation provider, pinned attestation and limitations; use an external sandbox plus externally measured CPU/RAM/device/network quotas for adversarial or resource-equality claims. Credentials must be adapter-specific and never grant access to private grading material. Receipt hashes do not prove a dishonest adapter followed its policy. Unattested conditions invalidate the experiment independently of numerical scores.

Journal/checkpoint hashes detect corruption relative to independently retained commitments; they are not signatures or tamper-proof hardware. Keep freeze, seal, checkpoint and human-rating digests in independent custody. Run metadata and system identities are omitted from judge ballots; answer style can still reveal identity and judges must disclose guesses/conflicts. Replaying a campaign verifies all frozen files, public packets, private gold, validators, receipts and journal heads before grading.
