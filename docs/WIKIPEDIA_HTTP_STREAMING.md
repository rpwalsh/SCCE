# Wikipedia ingestion over HTTP ranges

The existing Wikipedia V3 ingestor can read a pinned Wikimedia multistream source through a small `.remote.json` descriptor. It keeps the matching index locally, requests one indexed compressed block at a time, and passes that block to the existing bzip2 decoder, page parser, training journal and PostgreSQL transaction path. It does not write a complete XML dump locally or require GitHub Actions.

Existing local XML/bzip2 archives use the same CLI and parser directly. Pass their paths and matching indexes; no acquisition script or HTTP descriptor is needed.

## Prepare sources

The acquisition tools use Python 3.11 or later and its standard library. From `tools/corpus-acquisition`:

```sh
python prepare-full-wikipedia.py
python prepare-remote-wikipedia.py
```

The first command inventories fully checksummed dated snapshots and acquires their matching compressed indexes. The second checks those indexes, probes a single byte of each remote XML source, and writes descriptors plus `corpus-build/full-wikipedia/remote-sources.json`. No XML mirror is started.

A descriptor has this shape; use actual published checksums and the source's observed strong ETag:

```json
{
  "schema": "scce.wikipedia.remote_multistream.v1",
  "url": "https://dumps.wikimedia.org/EDITION/DATE/EDITION-DATE-pages-articles-multistream.xml.bz2",
  "byteLength": 123456,
  "expectedSha1": "PUBLISHED_XML_SHA1",
  "indexSha256": "SHA256_OF_THE_MATCHING_LOCAL_INDEX",
  "etag": "\"OBSERVED_STRONG_ETAG\""
}
```

The descriptor's filename retains the original dump name and appends `.remote.json`. For example, `htwiki-20261101-pages-articles-multistream.xml.bz2.remote.json`. Configure `runtime.corpora.wikipedia.dumpPath` to that file and `indexPath` to its matching index. Keep the usual local, untracked PostgreSQL configuration.

## Run

Build the repository, then use the existing CLI:

```sh
npm run build
node packages/cli/dist/index.js --config scce.config.json ingest wiki /absolute/path/htwiki-20261101-pages-articles-multistream.xml.bz2.remote.json --index=/absolute/path/htwiki-20261101-pages-articles-multistream-index.txt.bz2
```

For continued ingestion across configured page and heap checkpoints:

```sh
node packages/cli/dist/index.js --config scce.config.json ingest wiki firehose /absolute/path/htwiki-20261101-pages-articles-multistream.xml.bz2.remote.json --index=/absolute/path/htwiki-20261101-pages-articles-multistream-index.txt.bz2 --child-heap-mb=3072 --heap-checkpoint-mb=2300
```

The heap values above are operational limits for a constrained runner, not a memory qualification for an entire corpus. An explicit `--max-pages` or `--max-blocks` remains a requested bounded run. Configure the ordinary per-segment page cap in the config when using the firehose to continue to EOF.

When running through an environment-provided HTTP proxy on Node 24, set `NODE_USE_ENV_PROXY=1` so child CLI processes inherit proxy support. No proxy or database credentials belong in the descriptor or repository.

## Identity, recovery and completion

- Each response must be HTTP 206 with the exact requested `Content-Range`, complete byte count and pinned ETag. Requests include `If-Match`. A full-file HTTP 200 response is rejected before its body is read.
- Compressed and decompressed block sizes remain bounded. Original compressed offsets, source URL, ETag and a SHA-256 of each fetched block are carried into page provenance.
- The input manifest hashes the local descriptor and index and retains the remote URL, length, expected full-file SHA-1 and ETag. Its dump hash describes the descriptor bytes; it does not claim that unread XML was hashed.
- Source changes invalidate the existing resume identity. Language training and progress still use the existing atomic commit and replay rules.
- The manifest retains the existing compiler and normalization identities. Resume across changed compiler semantics follows the current identity checks.
- XML-escaped index titles and XML page titles are each decoded once before strict page-ID/title comparison. Different encoding layers remain mismatches.
- A complete sequential run verifies the published full-source SHA-1 from the ranges it already read. A resumed run verifies the full source through a bounded-memory read at EOF. That verification does not retain a local XML dump. The verified digest is recorded in the final stream checkpoint.
- Early page, block, owner and heap stops do not claim EOF or a complete remote checksum. Parser/checksum completion does not substitute for learned-artifact, replay, speech, calibration and runtime qualification; the existing lifecycle gates remain in force.
- SIGINT and SIGTERM cancel pending HTTP reads and decoding through the existing owner-stop/journal path. Library callers can supply an `AbortSignal` to the ingestor or stream. An abort never publishes a verified EOF; restart with the same descriptor/index to resume from durable progress.

There is no current Wikimedia multistream edition for Klingon. Its absence is recorded separately from the available editions.
