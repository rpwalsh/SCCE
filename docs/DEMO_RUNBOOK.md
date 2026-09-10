# Demo runbook

How to run SCCE in front of an audience, what to ask it, and how to reproduce every number shown.
Everything here runs against the real `scce3_runtime` brain over the product's own HTTP API; nothing is staged.

## Before the room

1. Start the server and wait for readiness (warmup hydrates the resident graph and language memory, ~2-3 minutes):

   ```sh
   pnpm build
   bash scripts/restart-server.sh          # kills the old process, starts a new one, waits for /api/ready
   curl -s http://127.0.0.1:3873/api/ready # {"ok":true,...} when it is ready to answer
   ```

   `/api/ready` answers instantly during warmup (503 with the warmup phase) and never runs a table scan on the
   request path; the exact table counts it reports are refreshed in the background every ten minutes.

2. Smoke the chat surface from the terminal before opening a browser:

   ```sh
   node tools/live-probe.mjs --file tools/probe-questions.txt
   ```

   Each line prints the status, wall-clock, evidence count and the answer. Expect single-digit seconds per turn
   and a citation (`Source: <title> (<url>)`) on every factual answer. Run it once before the room: the first
   question that touches a language role pays that role's hydration (10-20 s), and the probe pays it for you.
   For a creative request the first one is slow for the same reason; ask one yourself before the audience does.

3. Open the workbench at `http://127.0.0.1:3873/`. The header shows only the product name and a status dot
   (green idle, amber while a turn runs, red when the runtime is not ready). The gear opens the developer panel
   (evidence tree, approvals, settings, inspector, trace); leave it closed for the audience unless they ask to see
   the proof.

   A question can be carried in the link: `http://127.0.0.1:3873/?q=Who%20is%20Ada%20Lovelace%3F` asks on arrival.

## What to ask, and what it shows

| Ask | What the audience sees | Why it matters |
|---|---|---|
| `Who is Albert Einstein?` | A biographical sentence from the Albert Einstein article, cited | Retrieval from a 1.7M-node graph over 80k spans, answered from the subject's own article |
| `Who was Alfred the Great?` | The article's opening definition, cited | Multi-word names with connectors ("the", "of") are one subject, not two |
| `Did Apollo 11 land on Mars?` | The Apollo 11 lead: it landed on the Moon | A false premise is corrected from evidence, not agreed with |
| `What is the capital of Greece?` | "I don't have a grounded source about Greece in what I've ingested, so I won't guess." | No source, no answer: the corpus holds Athens but no Greece article, and it says so instead of inventing |
| `What was Albert Einstein's shoe size?` | A decline | The unanswerable half of the reference comparison: fabrication is the failure mode the design refuses |
| Click **Details** under any answer | The proof object: obligations, evidence bindings, contradiction and support mass | Every answer carries its own audit; nothing here is a model's opinion of itself |

Ask in either casing; `who is ada lovelace` works the same as `Who is Ada Lovelace?`.

## The comparison against a local model

`tools/reference-comparison-large.mjs` asks the same corpus-verified questions to SCCE and to `qwen2.5:3b` on
the same machine. The model is handed the article in its prompt, the arrangement most favourable to it; SCCE
retrieves from its whole corpus. Half of the questions are unanswerable from the article on purpose, so a
refusal is scored as well as a correct answer, and every question is checked against the article text before it
is asked. Run it against the live server:

```sh
node tools/reference-comparison-large.mjs --server=http://127.0.0.1:3873 --out=artifacts/parity-dataset/reference-comparison-live.json
```

The table it prints (correct / wrong / declined / fabrications / cited / mean latency) is the one to quote;
the JSON keeps every answer verbatim.

## Screenshots

`node tools/capture-screenshots.mjs` re-captures `docs/screenshots/workbench-*.png` with a headless Edge or
Chrome against the running server, each shot asking its question through the `?q=` link and waiting for the
answer. Re-run it after any change to the workbench so the pictures in the README are of the build being shown.

## If something goes wrong in the room

- **Every turn is slow (>15s)**: another process is holding the database (an ingest, a benchmark, or a second
  runtime). Check `pg_stat_activity`; the readiness scan is single-flight and cannot be the cause any more.
- **A red bubble instead of an answer**: the API returned an error, not a decline; declines render as an
  assistant message. The bubble text is the server's error verbatim; the developer panel's terminal has the
  request log.
- **The status dot is red**: the runtime reported not ready. `curl /api/ready` shows whether warmup is still
  running or Postgres is unhealthy.
- **Restart**: `bash scripts/restart-server.sh` from the repository root. It never deletes anything.
