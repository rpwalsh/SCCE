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

List every planned stored source and every planned human file, including the full selected dialogue directory. Do not list a report subset as the whole cohort. Stored owners require exact source-version IDs. A human file may omit its version ID before first training; its exact URI, raw file hash, decoded training-text hash and UTF-8 byte length remain mandatory. Finalization resolves the resulting real version and checks its canonical metadata. Normal dialogue training records the raw file hash as `sourceHash`; its source content hash covers the decoded text, which can differ from the declared-transcript JSON bytes.

Run the existing trainers with manifest-aware activation deferral. On Windows PowerShell 5, use a UTF-8-preserving stdout redirect, rather than its UTF-16 default redirection. For example, from the repository after the normal build:

```text
cmd /d /c "node packages/cli/dist/index.js --config=scce.config.json corpus train stored --brain-manifest=C:/build/plan.json --max-total-bytes=67108864 --max-source-attempts=100000 --min-article-bytes=0 > C:/build/wiki-report.json"
cmd /d /c "node packages/cli/dist/index.js --config=scce.config.json corpus train dialogue C:/corpus/dialogue --brain-manifest=C:/build/plan.json > C:/build/dialogue-report.json"
```

Set source-attempt, byte, heap, and file bounds for the actual cohort. The shown bounds are operational examples, not a source-selection or quality threshold. With a manifest, stored training selects the explicit stored owner IDs instead of a global catalog window. Existing cursor/heap limits still apply; any incomplete report refuses finalization. Dialogue continues through the normal human-authority and auxiliary-component producers. Neither trainer activates a standalone subset when `--brain-manifest` is supplied.

After all reports are complete, add each report file's exact SHA-256 as its `reportFiles[].sha256`. Paths resolve relative to the manifest directory. Preserve the source selection unchanged. Report files and manifest together must fit the explicit finalization byte budget:

```text
node packages/cli/dist/index.js --config=scce.config.json corpus finalize-stored --manifest=C:/build/plan.json --max-total-bytes=67108864
```

This command checks the pinned files, full report coverage, canonical source blobs and derivation parents, promoted evidence ownership, every reported profile and n-gram structure, and learned identity assignments. Metadata validation uses bounded exact-ID work pages, with no 512-owner total ceiling. Missing owners or artifacts, changed file bindings, skips, source cursors, interruption, heap stops and failed batches prevent activation. The existing lifecycle alone performs READY?ACTIVE with the empty-active atomic guard; an unrelated active brain is never replaced. Repeating the same frozen manifest is idempotent only while its canonical source/artifact validation remains valid.

Start the normal server against that same configuration after successful activation. Verify its active-brain marker and ordinary tool/turn behavior separately. Structural publication alone is not evidence that the brain can answer an arbitrary language task.
