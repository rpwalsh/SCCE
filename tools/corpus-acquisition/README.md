# Local corpus acquisition

These tools preserve source bytes, source identities and acquisition manifests. SCCE's existing ingestion and training commands produce learned artifacts and qualification records.

## Use an existing archive

An existing local archive needs no acquisition step. Keep its matching multistream index beside it or pass the index explicitly:

```sh
node packages/cli/dist/index.js --config scce.config.json ingest wiki /path/to/existing.xml.bz2 --index=/path/to/matching-index.txt.bz2
```

The local archive stays on the ordinary parser, admission, training and checkpoint path.

## Prepare a pinned HTTP input

The scripts require Python 3.11 or later. Run from the repository root:

```sh
python tools/corpus-acquisition/prepare-full-wikipedia.py
python tools/corpus-acquisition/prepare-remote-wikipedia.py
```

The first command uses `pinned-wikipedia-plan.json` to acquire and verify matching indexes. The second probes one byte of each pinned XML source, captures its strong ETag, and writes `.remote.json` descriptors under the ignored `corpus-build/` directory. The XML archive remains remote.

Pass a descriptor and its matching local index to the same `ingest wiki` command. Each request must return the exact requested HTTP 206 range, pinned ETag and byte count. Source changes invalidate resume identity. See [Wikipedia HTTP streaming](../../docs/WIKIPEDIA_HTTP_STREAMING.md) for the descriptor and checkpoint contracts.

SIGINT and SIGTERM cancel pending reads and stop at the existing safe checkpoint boundary. The usual `ingest wiki status --stop` and stop-file controls remain available. Resume with the same unchanged input; an interrupted or bounded run retains its incomplete status. Full remote-source checksum verification occurs at EOF.

The acquisition workflow runs locally. It creates no Actions workflow, hosted mirror or release assets.

## Optional source collections

```sh
python tools/corpus-acquisition/read-wikipedia-block.py enwiki "Optical telescope"
python tools/corpus-acquisition/acquire-tatoeba.py
python tools/corpus-acquisition/acquire-github.py
```

The block reader preserves compressed source bytes, page XML, derived wikitext, source coordinates and hashes. GitHub acquisition records its selected commit and bounded source/documentation selection: up to 32 code files, 16 documentation files, 128 KiB per file and 2 MiB per repository. The manifest records selected and skipped files.

Tatoeba acquisition retains sentence and contributor identities, direct source translation links, export hashes and partitions. Those links are source observations. The catalog's Spanish edition does not establish Mexican regional usage; sparse or unavailable editions remain explicitly recorded.

Keep original and derivative identities through SCCE ingestion. Downloads and parser completion do not establish training completion, brain activation or answer quality. The existing lifecycle and qualification gates remain authoritative.
