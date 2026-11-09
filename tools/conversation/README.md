# Prepare pinned human OASST conversations

```powershell
node tools/conversation/prepare-oasst.mjs --archive ABS_PINNED_MESSAGES.jsonl.gz --capture ABS_CAPTURE.json --license ABS_LICENSE --out .scce/corpus-bootstrap/NEW_OASST_CAPTURE --limits ca=128 --mode root-pairs
```

The command is file-only: it never calls SCCE, PostgreSQL or a model. It verifies archive bytes/SHA against the captured revision, retains the pinned license, then selects by hashes of source root/message IDs. Every retained message must be reviewed, not deleted, nonsynthetic, have no model attribution and retain the original source role. Selection is not based on prompt text, topic, diagnostic output or benchmark answers. Output counts show all available verified roots, retained roots/messages and rejection reasons; a requested limit is never represented as achieved when the source has less data.

Create the output's parent directory first. The selected output directory itself must not exist; existing preparations and source archives are never overwritten.

`root-pairs` keeps one actual direct human request/reply branch per top-level source root. `paths` permits complete verified root-to-assistant paths, keeping each true parent edge and rejecting missing ancestors, cycles, tree mismatches, locale changes and nonalternating edges. Siblings and unrelated pairs are never concatenated into a fake continuous conversation. Per-locale limits are explicit (`ca=128,ru=128,en=128,es=128`), and roots are independent in selection. Requesting more data changes the hash-order prefix; it does not change a chosen source record's content.

Each `train/LOCALE/*.json` is the existing `scce.dialogue_transcript.v1` shape. Speech is normalized to NFC, with exact Unicode code-point turn ranges. Metadata retains original text/JSON-line hashes, original/NFC spans and hashes, message/root/parent IDs, source review/model flags (including absent-versus-null), archive revision/SHA/URL and license hash. No request authority, factual truth or documentary support is inferred from words. Actual parent edges authorize conversation scope only.

The default 64 KiB document bound matches the existing dialogue trainer's evidence-chunk bound, so a complete retained conversation can remain in one source span. Metadata-index bytes, source-record bytes and path-turn limits are declared resource bounds; overflow fails rather than inventing truncation. Between the two archive passes, selected records use **one owned binary spool** with offset/length/SHA256 locators charged to the metadata index. There is no file per source message. The spool closes and unlinks on success, errors, or cooperative `AbortSignal`/CLI cancellation. Cancellation does not preempt synchronous work already in progress. A failed output has no completed `preparation.json`; do not ingest its partial training directory.

Without packing flags, each source path retains the existing individual transcript layout. Optional packing preserves the same eligible roots, hash ranking, surfaces and true parent edges while placing several independent conversations in a bounded output file:

```powershell
node tools/conversation/prepare-oasst.mjs --archive ABS_PINNED_MESSAGES.jsonl.gz --capture ABS_CAPTURE.json --license ABS_LICENSE --out .scce/corpus-bootstrap/NEW_PACKED_OASST_CAPTURE --limits en=10000,ru=10000,es=10000,ca=10000 --mode root-pairs --max-record-bytes 4000000 --max-document-bytes 65536 --max-index-bytes 67108864 --max-spool-bytes 67108864 --pack-max-serialized-bytes 262144 --pack-max-text-bytes 65536
```

Both packing bounds are required together and cover the **entire serialized JSON** (including provenance) and exact UTF-8 speech text respectively. A complete path that cannot fit refuses the preparation; no speech or metadata is clipped and no selected path is silently dropped. Packing works for both `root-pairs` and full `paths`. Conversation roots remain independent: only actual parent edges receive `replyToTurnIndex`, and no edge connects packed conversations. Source record/tree IDs, original/NFC hashes and code-point ranges remain auditable. Each selected record's full non-text raw fields (including human-review, model/deletion flags and absent-versus-null fields) are retained once in its lineage entry; common archive/capture/license provenance occurs once per packed canonical source. Every emitted transcript is checked by the kernel's `validateDeclaredTranscriptSource` (run from a normally built checkout).

All byte/count bounds must be positive safe integers. `--max-spool-bytes` is an explicit disk budget; if omitted it derives a finite upper bound from the existing per-locale path/record budgets, without adding an implicit source filter. It is not a whole-machine RAM or free-disk guarantee. The index includes spool locators. API callers may pass `signal` and an awaited `onProgress` observer for `spool.opened`/`spool.complete`; the observer receives the temporary path for resource auditing, never new training authority.

`preparation.json` remains outside locale training roots. Its `locales.*.retainedDocuments` counts source conversations, while `training[].expectedDocuments` and `documents[]` count actual output files. For packed outputs, `documents[].serializedBytes`/`sha256` pin the JSON file and `textBytes`/`textSha256` pin its NFC speech text. Use those exact physical-file hashes, text hashes/lengths, and file URIs when declaring the existing source-brain plan; do not confuse a serialized-file hash with the decoded speech hash. Preserve the complete manifest and license alongside training output.

Root/operator may then run the **ordinary dialogue trainer**, independently of the preparation command:

```powershell
node packages/cli/dist/index.js corpus train dialogue .scce/corpus-bootstrap/NEW_PACKED_OASST_CAPTURE/train/ca --language=ca --max-files=ACTUAL_EXPECTED_DOCUMENTS --max-file-bytes=262144
```

Use the actual retained count and the existing private owner information label/config. Keep locale roots isolated and pass the source alias explicitly. The trainer publishes ordinary source profiles, conversational constructions and request-act observations. Preparation alone proves no conversational competence. Conversation-only annotations do not create the neutral evidence-bearing contrast required by request-act hydration; genuinely source-supported QA/annotations may still be required. Do not weaken that gate, invent authority labels, or ingest any diagnostic/private case to make a prior failure pass. Train before a new implementation/source freeze and fresh evaluation seed; report new coverage honestly.
