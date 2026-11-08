# Reproducible corpus acquisition

These tools acquire exact source material and record its identity. They do not report downloaded files as trained artifacts, activate a brain, or certify chat, coding, or translation quality.

`dump-plan.json` pins complete Wikimedia multistream XML files and their matching indexes. Each member has a published SHA-1 and exact length. The catalog uses the latest fully checksummed available snapshot for each selected edition: English is October 2026, and the other selected editions are November 2026. The total is 81,863,535,936 bytes. Klingon's Wikimedia edition was closed and moved offsite; it is explicitly unavailable in this plan.

## Local acquisition

Run with Python 3.10 or later from any directory:

```sh
python tools/corpus-acquisition/prepare-full-wikipedia.py
python tools/corpus-acquisition/read-wikipedia-block.py enwiki "Optical telescope"
python tools/corpus-acquisition/acquire-tatoeba.py
python tools/corpus-acquisition/acquire-github.py
```

Generated files stay under the ignored `corpus-build/` directory beside the scripts. The Wikipedia block reader scans the matching index, requests exactly one compressed byte range, rejects ignored or inconsistent ranges, and preserves compressed source bytes, page XML, extracted wikitext, page/revision identities, and source coordinates. It does not claim unread pages were ingested.

GitHub selection means the top 20 nonfork, unarchived repositories by stars for each of 20 code languages. This first build selects at most 32 source and 16 documentation files per repository, 128 KiB per file and 2 MiB per repository. Every selected and skipped file is recorded; these are bounded selections, not complete repository copies.

Tatoeba preparation retains contributors, sentence IDs, direct source-provided translation links, export hashes, and train/calibration/test partitions. Spanish exports do not establish Mexican regional usage. Gujarati and Haitian Creole coverage is sparse. Source-provided links are observations, not independently certified translations.

## GitHub source storage

The acquisition workflow runs only on `codex/scce-corpus-20261108`. It copies full pinned Wikimedia XML and indexes to an **unpublished draft release**, using at most two edition jobs at once. Files larger than 1 GiB are stored in ordered chunks. Each chunk has SHA-256; every complete file must match its published SHA-1 and exact length before its edition manifest can be marked complete.

The workflow does not overwrite conflicting assets or modify a published release. `latest-source-status.json` distinguishes running, incomplete, and complete source acquisition and always marks `trainedBrain: false`.

To reassemble a large file, concatenate the assets in the order recorded by its edition manifest, then verify the recorded complete-file SHA-1 and SHA-256. Retain that manifest and the original Wikimedia attribution and license information.

## SCCE training and qualification

Use SCCE's existing ingestion/training paths on acquired material. See `docs/CORPUS_TRAINING.md` and `docs/INGESTION_BRAIN_BUILD_PLAN.md`. Preserve original/derivative source identities, input-bound resume, transaction boundaries, and lifecycle gates. Neither a download nor an activation receipt establishes answer quality. Incomplete Wikipedia builds remain unqualified.
