# Completing one explicitly planned source brain

This workflow publishes structural source-brain readiness through `completeInitialSourceBrainBuild`. It does not certify conversational competence, answer quality, or a comparative release gate. It neither copies an older learned brain nor activates an incomplete training subset.

Use the normal configured database, migrated schema, information-access context, and active corpus-segmentation declaration. The declared segmentation snapshot must cover the stored owners the normal trainer will use. Acquire sources and consolidate that snapshot before training. Keep the same configuration and owner context throughout this sequence.

Create a UTF-8 JSON manifest before training:

```json
{
  "schema": "scce.storedSourceBrainPlan.v1",
  "sourceId": "my-complete-cohort",
  "rootPath": "C:/corpus",
  "selectedItems": [
    {"sourceVersionId":"actual-stored-evidence-version", "canonicalUri":"wikipedia://actual-owner", "contentHash":"<64 hex content hash>", "byteLength":1234},
    {"canonicalUri":"file:///C:/corpus/dialogue/session.json", "contentHash":"<64 hex decoded training-text hash>", "byteLength":456, "sourceFileHash":"<64 hex raw session.json file hash>"}
  ],
  "reportFiles": [{"path":"wiki-report.json"}, {"path":"dialogue-report.json"}]
}
```

List every planned stored source and every planned human, code, documentation and book file, including the full selected dialogue directory. Do not list a report subset as the whole cohort. Stored owners require exact source-version IDs. A human file may omit its version ID before first training; its exact URI, raw file hash, decoded training-text hash and UTF-8 byte length remain mandatory. Finalization resolves the resulting real version and checks its canonical metadata. Normal dialogue training records the raw file hash as `sourceHash`; its source content hash covers the decoded text, which can differ from the declared-transcript JSON bytes. OSS and Gutenberg instead pin the raw file content hash and byte length, retaining all actual derived owners.

Run the existing trainers with manifest-aware activation deferral. On Windows PowerShell 5, use a UTF-8-preserving stdout redirect, rather than its UTF-16 default redirection. For example, from the repository after the normal build:

```text
cmd /d /c "node packages/cli/dist/index.js --config=scce.config.json corpus train stored --brain-manifest=C:/build/plan.json --max-total-bytes=67108864 --max-source-attempts=100000 --min-article-bytes=0 > C:/build/wiki-report.json"
cmd /d /c "node packages/cli/dist/index.js --config=scce.config.json corpus train dialogue C:/corpus/dialogue --brain-manifest=C:/build/plan.json > C:/build/dialogue-report.json"
```

Set source-attempt, byte, heap, and file bounds for the actual cohort. The shown bounds are operational examples, not a source-selection or quality threshold. With a manifest, stored training selects the explicit stored owner IDs instead of a global catalog window. Each ordinary file producer checks its own prepared canonical URI, raw file hash, decoded source binding and complete projection set against the manifest before learning that file. An extra eligible file is a fatal refusal rather than a skipped or silently learned input; no separate directory walk or duplicate URI/hash algorithm chooses the learning input. Earlier planned files keep normal resumable checkpoints if a later file is refused. Existing cursor/heap limits still apply; any incomplete report refuses finalization. Dialogue continues through the normal human-authority and auxiliary-component producers. None of the normal stored, dialogue, OSS, GitHub OSS or Gutenberg trainers activates a standalone subset when `--brain-manifest` is supplied.

After all reports are complete, add each report file's exact SHA-256 as its `reportFiles[].sha256`. Paths resolve relative to the manifest directory. Preserve the source selection unchanged. Report files and manifest together must fit the explicit finalization byte budget:

```text
node packages/cli/dist/index.js --config=scce.config.json corpus finalize-stored --manifest=C:/build/plan.json --max-total-bytes=67108864
```

This command checks the pinned files, full report coverage, canonical source blobs and derivation parents, promoted evidence ownership, every reported profile and n-gram structure, and learned identity assignments. Metadata validation uses bounded exact-ID work pages, with no 512-owner total ceiling. Missing owners or artifacts, changed file bindings, skips, source cursors, interruption, heap stops and failed batches prevent activation. The existing lifecycle alone performs READY?ACTIVE with the empty-active atomic guard; an unrelated active brain is never replaced. Repeating the same frozen manifest is idempotent only while its canonical source/artifact validation remains valid.

Start the normal server against that same configuration after successful activation. Verify its active-brain marker and ordinary tool/turn behavior separately. Structural publication alone is not evidence that the brain can answer an arbitrary language task.

## Code and books in the same planned brain

Use the same `--brain-manifest` flag with `corpus train oss`, `corpus train oss-github`, and `corpus train gutenberg`. Their ordinary reports, including the outer GitHub acquisition report, belong in the same `reportFiles` list. Preserve GitHub's actual pinned commit, snapshot inventory and acquisition provenance. File hashes in that inventory are not substitutes for completed language-training reports.

One OSS physical file can produce two raw parent IDs because code and adjacent prose have different real corpus namespaces. Keep one physical manifest item for that URI/hash and declare **every** actual projection. Do not assign different fake URIs to the projections, choose one parent arbitrarily, or rewrite their identities:

```json
{
  "canonicalUri": "<normal sourceUriBase>#path=src%2Ffile.ts",
  "contentHash": "<raw file SHA-256>",
  "sourceFileHash": "<same raw file SHA-256>",
  "byteLength": 1234,
  "projections": [
    {"sourceSystemId":"<CORPUS_SOURCE_SYSTEM_IDS.ossCode>", "projection":"code_surface_tokens"},
    {"sourceSystemId":"<CORPUS_SOURCE_SYSTEM_IDS.ossDocs>", "projection":"code_adjacent_prose"}
  ]
}
```

Use the actual exported opaque corpus IDs. The canonical URI is exactly the ordinary trainer's source URI; its existing `--source-uri-base` option can explicitly bind a local repository's identity before training. All projections of a physical file share that same URI. A documentation file declares its `ossDocs` `verbatim` projection. A Gutenberg item declares the actual `gutenberg` corpus ID and `transformId: "scce.gutenberg.boilerplate-strip.v1"`. Each declaration may additionally pin its actual `originalSourceVersionId`, child `sourceVersionId`, or transform ID. A physical item with several raw parents must use these per-projection identities rather than an ambiguous single top-level version ID.

The finalizer checks the complete declared projection set against canonical raw and derived metadata and keeps every parent in the existing replay manifest. Missing adjacent prose, a changed transform, duplicate projection or foreign parent refuses publication. Full normal OSS windows may be combined only with matching immutable source/snapshot provenance and complete declared file coverage; truncated inventories, failed files, unfinished project-contract closure, heap stops and incomplete cursors refuse. Gutenberg skips and heap stops also refuse.

Context-only configuration/declaration files can remain canonical dependencies of the source-owned project compiler. Do not manufacture language profiles or n-gram structures for them, or turn acquisition inventory/closure entries into fake language-training reports. Only the ordinary producer's actual language reports enter the language-artifact checks. If it really produced a language projection of a file, declare and retain that projection as well; source dependencies and their ownership checks remain in the existing producer/storage path.

Run each normal trainer with the shared manifest, save its complete UTF-8 report, pin its report hash, and invoke the same `corpus finalize-stored` command once for the entire cohort. This is one publication path for the planned brain; none of these commands adds a separate activation or quality gate.

The shared pre-learning file admission callback also covers the existing GitHub-to-OSS forwarding path. Dialogue supplies raw transcript-file bytes separately from canonical decoded training-text bytes, using the same NFC/NUL normalization helper as its normal compiler. Without a manifest, the callback is absent and source identity, corpus recipes, learning decisions and ordinary trainer completion remain unchanged. Actual parent/child version pins are still checked against canonical persisted records at finalization.
