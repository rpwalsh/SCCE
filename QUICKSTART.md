# SCCE quickstart

Build a local brain from a small collection you choose, then use the same runtime to inspect it and ask questions. PostgreSQL holds durable state; ingestion, reasoning and language realization run on your CPU.

## Install and build

Use Node.js `>=24.18.0 <25`, pnpm, and a local PostgreSQL instance. From the repository:

```sh
pnpm install
pnpm build
```

## Configure your local database

Put your local PostgreSQL connection settings in the ignored `scce.config.local.json`, which overlays `scce.config.json`. The account needs permission to create databases; the existing `postgres` maintenance database can supply the initial connection:

```json
{
  "database": {
    "url": "postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/postgres",
    "schema": "scce"
  }
}
```

Create a fresh physical database for this brain build:

```sh
node tools/create-brain-database.mjs --config scce.config.json --output-config scce.first-brain.local.json
```

The tool creates, migrates and verifies a new database, confirms its source and learned tables are empty, and writes its connection settings to the new ignored config. It refuses an existing database or output file. Choose a new output path for each new build. Acquisition, consolidation, learning, publication and serving for that build all use the same configuration.

## Teach a bounded first collection

Put a short README or Markdown document you own in `corpus/first-brain/`, then run:

```sh
pnpm scce --config scce.first-brain.local.json corpus train oss corpus/first-brain --docs-only --max-files=1 --max-file-bytes=65536
```

This compiles document evidence, cognitive structures and language memory into PostgreSQL. Inspect the returned report for completed files, skipped files and resource stops before adding material. One source can contribute its own observations; a source-count minimum does not decide whether its exact facts are usable. The default CLI heap allowance is 3 GiB; whole-machine memory also includes PostgreSQL, the browser and the operating system. The whole-machine 8 GB qualification remains open.

See [corpus training](docs/CORPUS_TRAINING.md) for larger bounded collections, resumable imports and other source formats.

## Start and use the brain

```sh
pnpm server --config scce.first-brain.local.json
```

Open `http://127.0.0.1:3873/`. `/api/ready` reports startup readiness. Ask about a concrete fact in your document, inspect its supporting evidence, then ask about something the document does not establish. The runtime records decisions and outcomes in the same durable store. Restarting the server reopens that state.

The gear opens evidence, approvals, settings and trace inspection. [Workspace runtime](docs/WORKSPACE_RUNTIME.md) covers governed local actions; [the user guide](docs/USER_GUIDE.md) covers learning and operation.

## Use the Pages interface

[Static Pages workbench](packages/ui/STATIC_PAGES.md) explains the static export and authenticated browser connection to your local server. The operator's device runs the brain. Cloudflare Pages serves the interface assets.

## Verify a change

`pnpm test` builds the packages and runs the repository checks. Capability and resource results have their own revision-bound evidence in the [evaluation index](docs/README.md#evidence-and-evaluation) and [recovery audit](docs/INGESTION_RECOVERY_AUDIT.md).
