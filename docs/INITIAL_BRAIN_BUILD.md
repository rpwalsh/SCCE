# Reproducible multicorpus initialization

Build the packages and configure local PostgreSQL as described in the [quickstart](../QUICKSTART.md). Prepare local Wikipedia dump/index files, Gutenberg texts, human-authored Dolly and OpenAssistant transcripts, and the code corpus. Enable the Wikipedia corpus in the runtime configuration. Configure `security.informationAccess` and `security.defaultSourceInformationLabel`; lexical sources use that exact source label. Nothing in this workflow downloads a corpus or uses a language model.

Start a new build with a new ignored output configuration. The supervisor creates a fresh physical database through the normal database-creation tool:

```powershell
node tools/run-brain-initialization.mjs --config scce.config.json --output-config scce.initial-brain.local.json --receipt .scce/initial/receipt.json --wikipedia-dump corpus/wiki/enwiki.xml.bz2 --wikipedia-index corpus/wiki/enwiki-index.txt.bz2 --gutenberg corpus/gutenberg --dolly corpus/dolly/transcripts --oasst corpus/oasst/train --code corpus/code/repos --english-only --budget-bytes 5000000000 --node-heap-mb 7168
```

Replace the corpus paths with your prepared files. English-only mode uses the `en` subdirectory of the OpenAssistant training root. `--fresh-config` is available only for an already created, migrated, verified empty brain database. Existing source or learned rows refuse that mode. See [offline code dependency context](oss-project-context.md) when the code corpus needs a pinned dependency manifest.

The database budget covers the complete physical database. The default guard is 200,000,000 bytes and incorporates measured batch growth. The supervisor derives a heap checkpoint below the declared Node heap. A heap setting does not include PostgreSQL or the operating system. Optional source workers retain their separate explicit execution policy and process RSS guard.

Run the identical command again after an external interruption. The supervisor reads the durable build state and adds `--resume` itself. It preserves the database, source selection, cursors, and completed ordinary corpus checkpoints. Changed corpus scope, budget, completion target, or lexical manifest refuses reuse. A durable source/publication failure stops automatic restarts. After correcting an environmental failure without changing the pinned scope, explicitly invoke `build-5gb-multicorpus-brain.mjs` with the same builder arguments and `--resume`; a successful publication clears its durable failure. Use a new output configuration and receipt for a changed build.

## Optional pinned lexical annotations

Local UD CoNLL-U and WordNet WN-LMF files can join the same initialization. They are optional: omitting the manifest preserves the ordinary corpus selection. A configured missing, changed, oversized, or incompatible resource is an error and is never silently skipped.

Create a local JSON manifest with this schema. Paths are relative to the manifest. Replace each declaration and hash with the exact acquired resource's metadata:

```json
{
  "schema": "scce.initial_lexical_resources.v1",
  "resources": [
    {
      "id": "ud-resource",
      "path": "ud.conllu",
      "format": "conllu",
      "contentHash": "sha256_<64 lowercase hex digits>",
      "sourceUri": "<pinned upstream source URI>",
      "lexiconId": "<treebank identity and revision>",
      "language": "<declared language>",
      "license": "<exact resource license>",
      "maxSourceBytes": 10000000
    },
    {
      "id": "wordnet-resource",
      "path": "wordnet.xml",
      "format": "wordnet",
      "contentHash": "sha256_<64 lowercase hex digits>",
      "sourceUri": "<pinned upstream source URI>",
      "lexiconId": "<WN-LMF Lexicon id:version>",
      "language": "<WN-LMF Lexicon language>",
      "license": "<WN-LMF Lexicon license>",
      "maxSourceBytes": 100000000
    }
  ]
}
```

The example byte bounds are operator capacities, not required source sizes. Set each `maxSourceBytes` to the whole-source capacity you permit. The parser accepts UTF-8 and detects gzip by its bytes; both encoded and decoded bytes must fit. For an uncompressed file, its byte length is a sufficient input capacity. Each resource requires a unique `id`, `sourceUri`, and path. WN-LMF must contain one lexicon, and its `id:version`, language, and license must exactly match the manifest. CoNLL-U identity, language, and license come from the pinned manifest; annotations come from the file.

Compute a resource hash without altering the file:

```powershell
'sha256_' + (Get-FileHash -Algorithm SHA256 corpus/lexical/ud.conllu).Hash.ToLowerInvariant()
```

After filling all resource pins, hash the exact manifest and add both flags to the initialization command:

```powershell
$lexicalManifestHash = 'sha256_' + (Get-FileHash -Algorithm SHA256 corpus/lexical/manifest.json).Hash.ToLowerInvariant()
# Append to the same initialization command:
# --lexical-manifest corpus/lexical/manifest.json --lexical-manifest-hash $lexicalManifestHash
```

The builder verifies every pin before creating the database. After each required ordinary corpus has committed a batch, normal language-identity finalization establishes measured resident identities. Lexical publication then uses `ingestUdLexicalCorpus` or `ingestWordnetCorpus`, which call the ordinary `trainLanguageCorpusText` source/checkpoint transaction. It retains the original annotation source, the language-text derivative, and source-owned typed projections. Their ordinary reports join the same final unified brain selection; no separate brain is activated.

Every lexical publication uses the global physical database budget and guard. A resource may additionally declare `maxDatabaseGrowthBytes` as an optional operator bound. There is no mandatory predicted amplification ratio. A completed resource resumes through read-only checks of its pin, durable report, current compiler/component recipes, source label, complete active projection headers, and exact pattern IDs. It can therefore replay after ordinary filling has reached the guard, without admitting new training beyond that guard.

Completion finalizes current language assignments again and publishes their stable catalog/assignment metadata after activation. Inspect `status`, `checks`, `lexicalResources`, `finalization.languageIdentities`, and `lastFailure` in the receipt. Resource receipts retain both the exact input pin and the ordinary derivative binding. Completion requires all ordinary corpus acceptance cases, current language finalization, retained dialogue publication, source-brain validation, and the physical budget check. These are build/readiness checks; they do not certify answer quality.

Start the server with `scce.initial-brain.local.json` to serve this brain. `--checkpoint-smoke-out .scce/initial/smoke.json` optionally runs the source-bound corpus smoke after completion.
