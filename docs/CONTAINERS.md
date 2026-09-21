# SCCE containers

Containers package the existing Node/Postgres application. They do not establish
trained language, calibration, recovery correctness, or comparative quality.
The host database and its empty `scce6_runtime` are not migrated by this setup.
**Finish ingestion, training, calibration and validation on the host first.
Keep Docker services stopped throughout preparation.** Then restore a verified
backup and required model assets into Docker before starting the frontend/API.

## Images and capabilities

| Target | Purpose | Native tools |
| --- | --- | --- |
| `runtime` | Server, graph/proof/mouth, text/code/office/spreadsheet adapters, packaged OCR dependencies | Node and pnpm |
| `runtime-media` | Same server with native PDF rendering and video extraction | Also Poppler and FFmpeg |
| `worker` | Existing CLI ingestion, training and calibration commands for all source types | Also Git, Python, bzip2, Poppler and FFmpeg |
| `evaluation` | Source, development dependencies, existing rehearsal and evaluation tools | Worker tools plus the build/test toolchain |

All targets share Node 24.18.0, pnpm 10.28.2 and the pinned Debian-based Node
image. The database image is pinned by digest: PostgreSQL **16.14**, pgvector
**0.8.3**, with `pg_trgm` available. This is a new qualification environment,
not a claim of parity with the host's PostgreSQL 16.11 / Windows collation.
New container databases use UTF-8 and `C.UTF-8`; processes use UTC.

The frontend is already served by the API server (`packages/ui` is included in
the application image). Frontend, server/API and backend therefore all run in
Docker, in two resident containers. A separate frontend service would duplicate
the existing serving path without reducing memory use.

### This 16 GB machine

The supplied limits budget **1 GiB for Postgres**, **2 GiB for one server**, and
**4 GiB for one heavy worker or evaluation job**. Node heap ceilings are 1536 MiB
for serving and 3072 MiB for heavy jobs; the remaining container allowance covers
native buffers and other process memory. The Wikipedia resident-memory checkpoint
threshold is 3072 MiB. Training order, vocabulary and shard size remain unchanged.
These limits bound resource use; they do not prove every training batch fits.

Run one heavy job at a time. Stop the server during throughput/qualification runs
when possible. Worker and evaluation profiles are opt-in, but profiles are not a
global job scheduler: manually launching both can exceed the intended budget.
Do not run the disposable test database alongside a large production ingest.
The observed Docker engine ceiling on this machine is about 7.53 GiB, leaving
the other half of physical RAM for Windows and host applications. Keep native
SCCE ingestion stopped while using the container worker; do not give each Node
process a 7 GB heap. CPU/memory use of Windows, the editor and the existing native
server still needs to be included in the machine budget.

Source code analysis does not require installing every compiler. Execution-based
checks for Java, Rust, Go, PHP, Ruby, Kotlin, Swift or C/C++ need their respective
toolchains in a separately pinned image derived from `worker`. A language is not
qualified merely because its source can be ingested. Container deployment also
does not turn the trusted-host patch validator into an untrusted-code sandbox.
No Docker daemon socket is mounted.

## Data layout

Mount one corpus root read-only at `/data/corpora`, with as many source families
and languages as needed. Example directories:

```text
/data/corpora/
  wikipedia/       full dumps and their matching indexes
  gutenberg/       books and prose
  oss/             pinned source repositories and documentation
  multilingual/   Bibles, parallel text and other language corpora
  dialogue/       human-authored conversations
  documents/      plain text, HTML, PDF and office documents
  spreadsheets/   workbook sources
  images/         scanned pages and visual evidence
  audio/          source recordings supported by configured adapters
  video/          video/sensor files
```

Directories are deployment paths, not a new ontology or a promise that every
format has a parser. Existing adapters and the source-neutral corpus registry
retain their contracts and provenance. Generic files use the existing ingest
path; Gutenberg, OSS, Wikipedia and dialogue use their existing CLI commands.
Custom registry entries may be configured without changing Compose. Multilingual
corpora retain source language identities; they are not folded into English.

`/data/models` is a separate read-only mount for local visual/OCR model assets and
`calibration/prod-calibrations.json`. Models are not downloaded at ingestion.
Enable visual/sensor features and point them at actual mounted assets in a local
config when needed. Missing assets do not establish a working capability.

Sources can stay in their current directories. Use additional mounts as shown in
`deploy/compose.corpora.example.yaml`; add equivalent entries for every external
corpus directory you use. The verified English Wikipedia directory on the current
machine is `C:/Users/react/OneDrive/Documents/yopp/data/wiki`. Set
`SCCE_WIKIPEDIA_DIR` to that directory when using the example override. The sample
config names the full `enwiki-latest-pages-articles-multistream.xml.bz2` and its
plain-text `enwiki-latest-pages-articles-multistream-index.txt`, not a shard.
Mounting a file does not authorize or start ingestion.

Postgres uses a named volume. Workspace and temporary state have separate named
volumes; evaluation has its own workspace/scratch volumes and `/results` output
mount. Published brain/provenance state still belongs in Postgres. Evaluation
tools with their own output flags must be pointed at `/results` to export files.

## Prepare deployment files without starting Docker

```powershell
node tools/container-init.mjs
docker compose config --quiet
```

The initializer creates absent random secret files and empty mount directories;
it preserves existing secrets and does not touch databases or corpora. Defaults
bind the API to host loopback port 3874, leaving the native server's 3873 alone.
Postgres has no published host port. To run native development against this new
database, explicitly add a loopback-only port in a local Compose override.

Copy `deploy/.env.example` to ignored `deploy/.env.local` for path overrides and
pass `--env-file deploy/.env.local`. A custom config is mounted as one read-only
file, so adjacent host `.local.json` overlays are not implicitly imported. Put
intended non-secret effective settings in that file. Password and API token files
are injected into the existing application environment by the entrypoint, not
baked into images. Automatic public web acquisition defaults off.

## Handoff after host preparation

Do not initialize an empty Docker schema and treat it as the prepared brain.
Finish the host recovery/qualification gates, quiesce writers, and export the
prepared schema with PostgreSQL logical backup tooling. Record the backup hash,
brain manifest and validation results. Preserve the host database for rollback.

After starting Docker, restore into a fresh database volume with the required
extensions. Verify source/model/provenance counts and active-manifest identity
against the host, and mount matching model/calibration assets. Logical restore
rebuilds indexes under the container's declared Linux collation. Start the
frontend/API only after restored-brain checks pass.

That handoff has **not** run: the host schema remains empty. Compose is deployment
tooling, not an automated brain qualification gate. All services require an
explicit profile; plain `docker compose up` starts none. The commands below
belong after host preparation, with restoration between database and API startup:

```powershell
docker compose build worker server evaluation
docker compose --profile handoff up -d postgres
# Restore and verify the prepared database before proceeding.
docker compose --profile serve up -d server
```

Use `serve-media` / `server-media` instead of `serve` / `server` if native PDF and
video processing is needed by the server. Do not start both on the same port.
The worker defaults to help; it never starts a corpus run on `compose up`.
Server startup with an empty brain does not imply readiness to answer questions.

After handoff, the optional worker can inspect a corpus without starting training:

```powershell
docker compose run --rm worker node packages/cli/dist/index.js corpus inspect /data/corpora/gutenberg
```

Production ingestion remains gated on the build plan's parsing, durable replay,
publication and qualification requirements. In particular, the outstanding
stop/resume language-batch identity issue is not fixed by containerization.
Builder/server process separation does not by itself enforce candidate/active
artifact isolation; that remains an application/storage release gate.

## Disposable rehearsals

Docker rehearsals also remain stopped until host preparation is complete.
The commands below are for that later phase.

The standalone test project has its own database, network and volume, no host
database port, no real corpus mounts, and no production credentials:

```powershell
docker compose -f compose.test.yaml build rehearsal
docker compose -f compose.test.yaml up -d postgres-test
docker compose -f compose.test.yaml run --rm rehearsal
docker compose -f compose.test.yaml run --rm rehearsal node tools/live-adapter-rehearsal.mjs
```

These execute existing lifecycle/storage and ingestion/answer adapter rehearsals.
Only this test project's volume is disposable:

```powershell
docker compose -f compose.test.yaml down --volumes
```

For the ordinary deployment use `docker compose down` without `--volumes` to
retain its database. Never substitute the production Compose file in the test
cleanup command. A kill/restart test must check contribution and manifest identity
as well as counts; a restarted container is not itself evidence of exact replay.

## Reproducible records

Qualification builds must use a clean, committed source archive, not a bind mount
of a changing checkout. Set `SCCE_REVISION` to that full commit and build all
targets from that archive. Local `development` tags are explicitly unqualified.
Keep the built image itself or push it to an authorized registry and retain its
digest; rebuilding later is a separate build even with the same labels.

`tools/container-record.mjs` records the built image content ID and available
registry digests, source revision label, pinned base, Node/ICU versions, Postgres
image/version, config hash and optional brain-manifest hash. It records environment
identity, never invents a passing qualification record. Store it beside the actual
test/benchmark outputs and corpus manifests.

For performance comparisons, record host versus container execution and the
corpus filesystem location. On Docker Desktop, Windows bind mounts and native
Linux storage can have different costs. Measure representative ingestion before
moving corpus storage; never silently substitute a smaller dump. See Docker's
[WSL guidance](https://docs.docker.com/desktop/features/wsl/best-practices/).
