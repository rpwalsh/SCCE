# Prepare pinned human OASST conversations

```powershell
node tools/conversation/prepare-oasst.mjs --archive ABS_PINNED_MESSAGES.jsonl.gz --capture ABS_CAPTURE.json --license ABS_LICENSE --out .tmp/oasst-human-prepared --limits ca=128 --mode root-pairs
```

The command is file-only: it never calls SCCE, PostgreSQL or a model. It verifies archive bytes/SHA against the captured revision, retains the pinned license, then selects by hashes of source root/message IDs. Every retained message must be reviewed, not deleted, nonsynthetic, have no model attribution and retain the original source role. Selection is not based on prompt text, topic, diagnostic output or benchmark answers. Output counts show all available verified roots, retained roots/messages and rejection reasons; a requested limit is never represented as achieved when the source has less data.

`root-pairs` keeps one actual direct human request/reply branch per top-level source root. `paths` permits complete verified root-to-assistant paths, keeping each true parent edge and rejecting missing ancestors, cycles, tree mismatches, locale changes and nonalternating edges. Siblings and unrelated pairs are never concatenated into a fake continuous conversation. Per-locale limits are explicit (`ca=128,ru=128,en=128,es=128`), and roots are independent in selection. Requesting more data changes the hash-order prefix; it does not change a chosen source record's content.

Each `train/LOCALE/*.json` is the existing `scce.dialogue_transcript.v1` shape. Speech is normalized to NFC, with exact Unicode code-point turn ranges. Metadata retains original text/JSON-line hashes, original/NFC spans and hashes, message/root/parent IDs, source review/model flags (including absent-versus-null), archive revision/SHA/URL and license hash. No request authority, factual truth or documentary support is inferred from words. Actual parent edges authorize conversation scope only.

The default 64 KiB document bound matches the existing dialogue trainer's evidence-chunk bound, so a complete retained conversation can remain in one source span. Metadata-index bytes, source-record bytes and path-turn limits are declared resource bounds; overflow fails rather than inventing truncation. Only selected source messages are materialized between the two archive passes. Temporary materialization is removed after preparation. Provenance manifests/license stay outside the locale training roots so the ordinary trainer does not mistake them for conversations.

Root/operator may then run the **ordinary dialogue trainer**, independently of the preparation command:

```powershell
node packages/cli/dist/index.js corpus train dialogue .tmp/oasst-human-prepared/train/ca --language=ca --max-files=128 --max-file-bytes=4000000
```

Use the actual retained count and the existing private owner information label/config. Keep locale roots isolated and pass the source alias explicitly. The trainer publishes ordinary source profiles, conversational constructions and request-act observations. Preparation alone proves no conversational competence. Conversation-only annotations do not create the neutral evidence-bearing contrast required by request-act hydration; genuinely source-supported QA/annotations may still be required. Do not weaken that gate, invent authority labels, or ingest any diagnostic/private case to make a prior failure pass. Train before a new implementation/source freeze and fresh evaluation seed; report new coverage honestly.
