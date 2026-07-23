# Hostile Code Review

Date: 2026-07-06
Reviewer posture: adversarial production review, not marketing copy.
Scope: repository source, scripts, configs, and docs under `packages`, `tools`, `docs`, root configs, and examples, excluding generated `dist`, `node_modules`, coverage, `.git`, `.scce`, and `.tmp`.

This is not a 100,000-line reprint of the repository with comments beside every line. That would be evasion disguised as diligence. This review uses repository-wide static scans, build/test/audit commands, targeted hot-path inspection, and exact file-line findings. Every source area was included in the command coverage; every defect below cites the line that makes the claim reviewable.

## Executive Verdict

This repo is not in buyer-grade production condition.

It has real architecture and serious local-runtime ideas, but the current state fails its own structural test, fails its own aggregate audit path, exposes unauthenticated mutating HTTP routes, ships default wildcard web fetch policy, contradicts its own Postgres contract, loses persisted semantic frame embeddings on read, has multiple answer-runtime lanes despite "one lane" claims, and records durable proof/construct/emission state through best-effort background writes in core turn paths.

The charitable interpretation is "serious alpha runtime core." The hostile interpretation is "production claims are ahead of invariants." The code itself supports the hostile interpretation.

## Verification State

Commands actually run:

```powershell
git status --short
jq '.scripts' package.json
pnpm repo:shape
pnpm repo:deps
pnpm test:structural
pnpm build
pnpm repo:dead
pnpm repo:cruise
rg --files packages tools docs examples
rg -n "TODO|FIXME|HACK|stub|placeholder|provisional|heuristic|fallback|temporary|fake|mock|unsupported" packages tools docs examples -g '!dist' -g '!node_modules' -g '!coverage'
rg -n "auth|authorization|Bearer|token|api key|apikey|session|cookie|csrf|cors|origin" packages/server packages/adapters-node packages/cli packages/kernel tools -g '!dist' -g '!node_modules'
```

Observed results:

- `git status --short`: no initial tracked changes.
- `pnpm repo:shape`: passed. Reported 300 files, 109,801 total lines, 98,261 code lines. TypeScript was 239 files, 99,296 lines, 93,355 code lines.
- `pnpm build`: passed.
- `pnpm repo:dead`: passed with no output.
- `pnpm test:structural`: failed. One test failed in `packages/kernel/src/__tests__/discourse-state.test.ts`.
- `pnpm repo:deps`: failed. Madge reported four circular dependencies, including source cycles in `packages/kernel/src/calibration-spine.ts`, `packages/kernel/src/dialogue-pragmatics.ts`, `packages/kernel/src/storage.ts`, and duplicate `dist` cycles from local build output.
- `pnpm repo:cruise`: failed. `dependency-cruiser` config is missing.
- Therefore `pnpm test` fails and `pnpm scce:audit` cannot pass because `package.json:11` chains `test:structural`, and `package.json:26` chains `repo:shape`, `repo:deps`, `repo:dead`, and `test`.

## Severity Scale

- P0: blocks release, buyer trust, security posture, or core correctness.
- P1: breaks durable contract, debuggability, architecture guardrail, or important runtime behavior.
- P2: creates operational risk, maintainability drag, or test/tooling drift.
- P3: documentation, hygiene, and non-blocking quality debt.

## P0 Findings

### P0-1: The Current Test Suite Fails

Evidence:

- `package.json:11` defines `test` as `pnpm test:structural && node tools/release-gate.mjs`.
- `package.json:12` defines `test:structural` as `vitest run packages/kernel/src/__tests__/runtime-coherence.test.ts packages/kernel/src/__tests__/discourse-state.test.ts`.
- `packages/kernel/src/__tests__/discourse-state.test.ts:5` says the runtime must bind a sparse continuation to prior evidence.
- `packages/kernel/src/__tests__/discourse-state.test.ts:30` asserts `expect(state).toBeTruthy()`.
- `packages/kernel/src/discourse-state.ts:64` returns `undefined` when `surface.unitCount < 4`.

The failing behavior is not mysterious. The test asks for sparse continuation binding; the implementation rejects sparse continuation before calculating sparse binding confidence. That is directly inverted behavior.

Additional rot signal:

- `packages/kernel/src/__tests__/discourse-state.test.ts:8` contains mojibake text where the intent appears to be Korean sparse follow-up text. A multilingual runtime cannot tolerate corrupted source test text in the exact test that is supposed to protect multilingual discourse continuation.

Production consequence:

No release gate, audit document, or buyer claim can honestly say tests are green until this is fixed.

Minimal remediation:

Change the specificity gate in `buildDiscourseObjectState` so sparse surfaces are eligible when a recent evidence-bearing carrier exists, and repair the test file encoding. Add at least one ASCII sparse follow-up and one real UTF-8 Korean sparse follow-up case.

### P0-2: Unauthenticated HTTP API Includes Mutating Database, Ingestion, Workspace, Connector, Training, Turn, and Benchmark Routes

Evidence:

- `packages/server/src/routes.ts:17-72` declares the API route surface.
- `packages/server/src/routes.ts:23-24` exposes `/api/db/init` and `/api/db/migrate`.
- `packages/server/src/routes.ts:31-45` exposes connector and telephone routes.
- `packages/server/src/routes.ts:47-65` exposes ingest, codebase ingest, workspace init/ingest/ask/outcome, train, and turn routes.
- `packages/server/src/routes.ts:75-96` handles requests with request id, trace, dispatch, and error handling. There is no authentication or authorization check.
- `packages/server/src/routes.ts:112-118` runs database migration from HTTP.
- `packages/server/src/index.ts:35-41` creates a raw HTTP server and passes every request to `handleRequest`.

The default config binds to loopback:

- `scce.config.json:3-5` uses `127.0.0.1:3873`.

That default is helpful, but it is not an auth model. The route layer itself is not production-public-safe. The moment this server is bound to `0.0.0.0`, reverse-proxied, tunneled, or exposed by a desktop helper, the route surface is writable.

Production consequence:

For a public product, this is a release blocker. It exposes data mutation, data ingestion, connector reads, connector writes behind approval sessions, and benchmark execution with no caller identity boundary.

Minimal remediation:

Require an explicit auth mode at startup for all non-loopback binds. Add middleware before `dispatch` that enforces bearer token, mTLS, local socket, or signed localhost session. Deny all mutating routes by default when auth is not configured. Add tests that assert unauthenticated requests to every `mutates: true` route fail.

### P0-3: Public Config Endpoint Leaks Local Filesystem Topology

Evidence:

- `packages/server/src/routes.ts:46` exposes `/api/config/public`.
- `packages/server/src/routes.ts:728-744` returns `config.server`, database schema and URL configured state, `workspaceRoot`, `tempRoot`, `maxFileBytes`, `allowedRoots`, `excludedPaths`, runtime tool availability, redacted connectors, and local master key configured state.
- `scce.config.json:16` includes `C:/Users/react/Downloads` in `runtime.allowedRoots`.
- `scce.config.json:27-28` include local Wikipedia dump paths under Downloads.

This endpoint is named "public" but contains environment topology. Redacting connector secrets is not enough when paths reveal local machine layout and data staging locations.

Production consequence:

On any exposed server, this becomes reconnaissance for file-ingest boundaries and local data layout.

Minimal remediation:

Split public client config from operator diagnostics. Public config should contain only client-required fields. Put path/tool/database topology behind authenticated admin inspection.

### P0-4: Wildcard Web Fetch Is Enabled by Default and Fetch Has No Real SSRF Guard

Evidence:

- `scce.config.json:47-50` enables the web connector with `allowedHosts: ["*"]`.
- `packages/adapters-node/src/connectors.ts:39-42` accepts any `http:` or `https:` URL and forwards it to `fetchWeb`.
- `packages/adapters-node/src/connector-policy.ts:92-99` accepts any `http:` or `https:` URL when `allowedHosts` contains `"*"`.
- `packages/adapters-node/src/connectors.ts:194` calls `fetch(url)`.
- `packages/adapters-node/src/connectors.ts:196-197` reads the full `arrayBuffer` before enforcing `maxBytes`.
- `packages/adapters-node/src/connectors.ts:289-292` and `packages/adapters-node/src/connectors.ts:306-309` read full search responses before enforcing `maxBytes`.

There is no DNS resolution block, no private-address block, no loopback/link-local/metadata IP block, no redirect policy, and no streaming byte cap. Wildcard host policy plus unauthenticated connector route is a production SSRF shape.

Production consequence:

An exposed server can be used to fetch internal URLs, metadata services, local admin panels, or large responses until memory pressure is hit. The current byte cap is after allocation, not before it.

Minimal remediation:

Default web connector to disabled or explicit allowlist. Add URL validation after DNS resolution. Block loopback, private, link-local, multicast, RFC1918, ULA, and cloud metadata ranges. Set fetch timeout and redirect limits. Enforce max bytes while streaming.

### P0-5: Secret Encryption Policy Is a Claim, Not an Enforced Invariant

Evidence:

- `scce.config.json:57-60` has an empty `security.localMasterKey`.
- `scce.config.json:70` sets `policy.encryptSecretsAtRest` to `true`.
- `packages/adapters-node/src/secrets.ts:14-23` can encrypt a secret only when a key is explicitly provided.
- `packages/adapters-node/src/secrets.ts:26-40` returns plaintext values unchanged unless they begin with `enc:v1:`.
- `packages/adapters-node/src/config.ts:123-152` validates core config but does not require `security.localMasterKey` when `policy.encryptSecretsAtRest` is true.

The config says secrets are encrypted at rest. The loader does not enforce it. Plaintext connector secrets remain legal.

Production consequence:

The policy field can mislead buyers, operators, and auditors. This is exactly the kind of gap that becomes an incident report sentence later.

Minimal remediation:

When `encryptSecretsAtRest` is true, fail config validation if any configured secret-like connector field is non-empty and not `enc:v1:`. Require `localMasterKey` for encrypted values. Add a config audit endpoint that returns pass/fail without exposing values.

## P1 Findings

### P1-1: The Runtime Is Not One Lane

The repository guide says the hot path should preserve a single inspectable path from evidence to observations, graph, alpha fabric, frontier activation, route scoring, proof, slot plan, mouth, and traceable answer.

The implementation contains multiple early lanes inside `kernel.turn`.

Evidence:

- `packages/kernel/src/kernel.ts:1697-1748` returns a deterministic arithmetic answer with empty evidence, skipped language acquisition, and skipped mouth.
- `packages/kernel/src/kernel.ts:1750-1758` starts a runtime self-question lane with empty evidence.
- `packages/kernel/src/kernel.ts:1964-2050` returns a `fast_local_evidence` answer before the full later planner/mouth path.
- `packages/kernel/src/kernel.ts:2468-2584` is the longer main path with construct persistence, mouth generation, PCA, validation, runtime coherence, and emission.

This may be a reasonable implementation strategy, but it directly contradicts "one lane, no fallback paths" style documentation unless these are formally modeled as subpaths with the same proof and trace contract.

Production consequence:

Bugs will be patched in one lane and missed in another. Security and evidence invariants will diverge. Buyers cannot reason about "the runtime" when there are multiple return contracts.

Minimal remediation:

Define a single `TurnPipelineResult` contract and force every lane through the same final proof, persistence, coherence, trace, and emission assembly. Arithmetic can be a candidate source; it should not be a separate runtime universe.

### P1-2: Durable Proof/Construct/Emission Persistence Is Often Best-Effort

Evidence:

- `packages/kernel/src/kernel.ts:293-295` defines `persistInBackground`, catches persistence failure, and appends a string to in-memory `failures`.
- `packages/kernel/src/kernel.ts:1972` stores fast proof in the background.
- `packages/kernel/src/kernel.ts:1988` stores fast construct in the background.
- `packages/kernel/src/kernel.ts:2014` stores fast validation in the background.
- `packages/kernel/src/kernel.ts:2029` stores fast emission in the background.
- `packages/kernel/src/kernel.ts:2478-2479` stores normal construct and spoken construct in the background unless a foreground condition is met.
- `packages/kernel/src/kernel.ts:2547` stores validation in the background.
- `packages/kernel/src/kernel.ts:2582` stores emission in the background.

The system can return a successful answer while durable proof, construct, validation, or emission records fail to persist.

Production consequence:

This violates the spirit of "Postgres-backed durable storage" and proof-carrying answers. An answer can be emitted without the durable proof path needed to debug it later.

Minimal remediation:

For any answer claiming source-grounded, certified, reasoned, or externally actionable force, persist proof, construct, validation, emission, and ledger events foreground in one transaction or a recoverable outbox. Reserve background writes for non-critical telemetry only.

### P1-3: Runtime Coherence Is Post-Hoc Demotion, Not Actual Repair

Evidence:

- `packages/kernel/src/kernel.ts:2490-2507` generates the mouth answer.
- `packages/kernel/src/kernel.ts:2535` records `MouthSpoken`.
- `packages/kernel/src/kernel.ts:2549` emits a raw emission.
- `packages/kernel/src/kernel.ts:2561-2584` then decides runtime coherence and only changes `assistantForce`.
- `packages/kernel/src/runtime-coherence.ts:53-115` calculates pressure after the answer exists.
- `packages/kernel/src/runtime-coherence.ts:107-110` only blocks when mouth surface failed or readiness is very high pressure.
- `packages/kernel/src/runtime-coherence.ts:151-162` mostly demotes assistant force and does not regenerate evidence, proof, candidate, or mouth surface.

The repair target ids include mouth regeneration and evidence activation, but the turn path does not execute repair. It labels problems after the answer has already been spoken.

Production consequence:

Bad answers can still ship as demoted answers. That is not a production coherence system; it is a post-hoc warning label.

Minimal remediation:

Move coherence before final emission. If coherence demands regeneration or evidence activation, actually re-enter the relevant stage or return an explicit blocked/insufficient answer.

### P1-4: Persisted Semantic Frame Embeddings Are Dropped on Read

Evidence:

- `packages/adapters-node/src/postgres.ts:328` creates `semantic_frames.embedding VECTOR(64) NOT NULL`.
- `packages/adapters-node/src/postgres.ts:380` creates an ivfflat embedding index.
- `packages/adapters-node/src/postgres.ts:1388-1417` writes embeddings through `vectorLiteral(frame.embedding, 64)`.
- `packages/adapters-node/src/postgres.ts:1257-1262` lists semantic frames without selecting `embedding`.
- `packages/adapters-node/src/postgres.ts:2162-2163` maps every read frame to `embedding: []`.

The database stores embeddings, indexes embeddings, and then the adapter discards them when reading.

Production consequence:

Hydrated semantic-frame memory cannot use persisted vectors after restart. Any translation, language memory, or semantic alignment path relying on frame embeddings is degraded or broken.

Minimal remediation:

Select `embedding::text` or an array conversion in `listSemanticFrames`, parse it back into 64 numbers, and add a round-trip test that writes and reads a semantic frame with non-zero embedding values.

### P1-5: Postgres Contract Does Not Match the Actual Adapter Schema

Evidence:

- `packages/kernel/src/postgres-contract.ts:114` declares required extensions `["pgcrypto", "vector"]`.
- `packages/kernel/src/postgres-contract.ts:225` verifies the contract only by checking those names are declared in the contract.
- `packages/adapters-node/src/postgres.ts:300` creates only the `vector` extension.
- `packages/kernel/src/postgres-contract.ts:242-249` says the `events` table has `payload` JSONB and `parents` JSONB.
- `packages/adapters-node/src/postgres.ts:303` creates `events` with `payload_json` JSONB, `parents TEXT[]`, and `ledger_hash`.

This is not harmless naming drift. It means the formal contract is not executable against the actual schema.

Production consequence:

The "Postgres contract" cannot be used as a reliable audit artifact. It is documentation with a verifier that verifies itself, not the live adapter.

Minimal remediation:

Generate the contract from the adapter migration definitions, or validate live schema against the contract. Make column names, types, extensions, and indexes match. Add a test that compares `postgres-contract.ts` to `schemaStatements`.

### P1-6: Database Migration Is `CREATE IF NOT EXISTS`, Not a Real Migration System

Evidence:

- `packages/adapters-node/src/postgres.ts:300-350` uses `CREATE EXTENSION`, `CREATE SCHEMA`, and many `CREATE TABLE IF NOT EXISTS` statements.
- The schema includes many indexed tables and evolving records.
- The visible migration path does not include versioned `ALTER TABLE` migrations for existing installs.

Production consequence:

Existing customers with an older schema can pass table-exists checks but miss new columns, column types, indexes, or extension state. That is how persistent production data gets stranded.

Minimal remediation:

Add schema version records with forward-only migrations. Verify required columns, types, nullability, indexes, and extensions at startup. Fail closed when an upgrade is required.

### P1-7: Route Validators Cast Unknown Bodies Into Domain Types

Evidence:

- `packages/server/src/routes.ts:405-409` accepts ingest if `path`, `uri`, or `content` exists and then casts to `IngestInput`.
- `packages/server/src/routes.ts:454-456` accepts train if `{ config }` exists and then casts to `TrainInput`.
- `packages/server/src/routes.ts:459-461` accepts turn if `text` is a non-empty string and then casts to `OwnerInput`.
- `packages/server/src/routes.ts:698-701` accepts benchmark if tasks or config exists and then casts to `BenchmarkInput`.
- `packages/server/src/routes.ts:709-725` parses JSON with a body limit but no schema validation and no content-type check.

Production consequence:

The public API boundary is not a typed boundary. It is TypeScript wish-casting after minimal shape checks.

Minimal remediation:

Use runtime schemas for every request body. Enforce field types, bounds, enum values, nested object sizes, path formats, connector options, and metadata limits before reaching the kernel.

### P1-8: Candidate Selection Is Still a Hand-Weighted Heuristic Core

Evidence:

- `docs/SERIOUS_VERSION_AUDIT.md:10-28` already admits major score systems are hard-coded or provisional.
- `packages/kernel/src/candidate.ts:315-328` computes base scores with fixed coefficients.
- `packages/kernel/src/candidate.ts:354-366` computes `candidateMass` with fixed coefficients.
- `packages/kernel/src/candidate.ts:369-388` wraps those scores in free energy, Boltzmann probability, and least-action vocabulary.
- `packages/kernel/src/candidate.ts:395-401` assigns fixed force weights.
- `packages/kernel/src/candidate.ts:220-227` and `packages/kernel/src/candidate.ts:262-269` mark support blends as provisional heuristic traces.

The naming is ambitious. The math is mostly hand-tuned utility scoring unless a calibrated model is actually governing decisions.

Production consequence:

Production claims about calibrated graph cognition are premature. The code may be useful, but the scoring path is not buyer-grade calibrated selection.

Minimal remediation:

Keep these as features and guards. Add calibrated selectors trained or at least fitted on held-out outcome data. Refuse to label a final decision as calibrated when the selected path is heuristic.

### P1-9: Answer Emitter Can Fall Back to the User's Request Text

Evidence:

- `packages/kernel/src/answer-emitter.ts:64-67` chooses `evidenceSurface || realizedSurface || sourceTextSurface(input.requestText, 360)`.

When evidence and realization fail, the answer can become a normalized slice of the request.

Production consequence:

This risks echo-as-answer behavior. Later guards may catch some cases, but this fallback belongs in an explicit insufficient-support boundary, not an answer emitter.

Minimal remediation:

Remove request-text fallback for factual answer emission. Return a typed insufficient-support surface with no evidence ids and an audit reason.

### P1-10: Multilingual Contract Conflicts With Typed Ingest Relation Seeds

Evidence:

- `docs/MULTILINGUAL_CONTRACT.md:3-5` says SCCE must not use English seed labels, English enums, English taxonomies, or hand-authored language-specific relation names.
- `packages/kernel/src/typed-ingest.ts:670-672` turns a raw relation string into `relationId`.
- `packages/kernel/src/typed-ingest.ts:693` uses `"observation_routes_to_store"`.
- `packages/kernel/src/typed-ingest.ts:698` uses `"dataset_contains_table"`.
- `packages/kernel/src/typed-ingest.ts:701` uses `"table_has_column"`.
- `packages/kernel/src/typed-ingest.ts:707` uses `"measurement_has_unit"`.
- `packages/kernel/src/typed-ingest.ts:713` uses `"formula_depends_on_cell"`.
- `packages/kernel/src/typed-ingest.ts:719` uses `"table_contains_time_series"`.
- `packages/kernel/src/typed-ingest.ts:725` uses `"figure_has_caption"`.
- `packages/kernel/src/typed-ingest.ts:738-745` uses log relation names like `"stream_contains_log_event"`.
- `packages/kernel/src/typed-ingest.ts:750-775` uses more English relation seeds for schema, derived observations, repositories, files, and symbols.
- `packages/kernel/src/typed-ingest.ts:840-848` emits English-ish feature tags like `"table"`, `"measurement"`, `"unit:unknown"`, `"time-series"`, and `"log-event"`.

Some of these are engineering primitive identifiers, not natural-language ontology labels. But the doc does not make that distinction, and the code currently gives relation identity to English-derived strings before hashing.

Production consequence:

The multilingual contract is overstated. It must either allow language-neutral engineering IDs expressed in English-like slugs, or the code must move to stable opaque relation IDs plus source-derived labels.

Minimal remediation:

Define a registry of language-neutral relation IDs with non-semantic IDs, and store source labels separately. Update docs to distinguish opaque internal slugs from source language labels if English-like slugs are intentionally retained.

## P2 Findings

### P2-1: Audit Tooling Is Broken or Polluted by Build Output

Evidence:

- `package.json:21` defines `repo:deps` as `madge packages --extensions ts,tsx --circular`.
- Running it after build processed `dist` output and reported duplicate source/dist cycles.
- The source cycles reported were:
  - `packages/kernel/src/calibration-spine.ts > packages/kernel/src/dialogue-pragmatics.ts`
  - `packages/kernel/src/storage.ts > packages/kernel/src/calibration-spine.ts`
- `package.json:22` defines `repo:cruise` as `depcruise packages --output-type err`.
- Running `repo:cruise` failed because `.dependency-cruiser.(c|m)js` is missing.

Production consequence:

The advertised audit commands are not reliable. One includes generated output; one cannot run.

Minimal remediation:

Change `repo:deps` to scan `packages/*/src` or exclude `dist`. Add dependency-cruiser config or remove the script from advertised audit paths. Break the real source cycles.

### P2-2: Trace Is Global, Synchronous, Weakly Identified, and Swallows Errors

Evidence:

- `packages/kernel/src/debug/trace.ts:31` creates trace ids from `Date.now()` and `Math.random()`.
- `packages/kernel/src/debug/trace.ts:45-58` creates a trace file and returns undefined if setup fails.
- `packages/kernel/src/debug/trace.ts:61-65` uses `appendFileSync` for each event and swallows write errors.
- `packages/server/src/index.ts:12-14` stores the trace handle on `globalThis`.
- `packages/server/src/routes.ts:78` reads `(globalThis as any).__sccTrace`.

Production consequence:

Tracing is not request-scoped, not concurrency-clean, can add synchronous IO latency to hot paths, and can silently disappear. That is debug-grade, not production observability.

Minimal remediation:

Pass trace context through request/runtime calls. Use async buffered writes or structured logging. Use UUIDs. Surface trace write failures in diagnostics.

### P2-3: God Files Undermine Low-Token Debugging

Largest files observed in the repo shape pass:

- `packages/kernel/src/kernel.ts`: 7,835 lines.
- `packages/kernel/src/mouth.ts`: 3,544 lines.
- `packages/kernel/src/language-memory-runtime.ts`: 3,129 lines.
- `packages/kernel/src/program-planner.ts`: 2,293 lines.
- `packages/adapters-node/src/postgres.ts`: 2,130 lines.
- `packages/adapters-node/src/scce2/scce2-to-v3-importer.ts`: 1,648 lines.
- `packages/kernel/src/typed-ingest.ts`: 1,530 lines.
- `packages/adapters-node/src/engineering-corpus-folder.ts`: 1,500 lines.
- `packages/adapters-node/src/workspace-runtime.ts`: 1,435 lines.

Production consequence:

The codebase advertises inspectability and low-token debugging, but the core behavior is concentrated in huge files. That makes regression review and agent-assisted debugging harder than necessary.

Minimal remediation:

Extract private modules around actual phase boundaries without creating a second runtime lane: turn pipeline stages, persistence/outbox, evidence selection, mouth planning, Postgres table stores, and config validation.

### P2-4: MCP Postgres Tool Uses Regex SQL Firewall and Silent Partial Failures

Evidence:

- `tools/scce-dev-mcp/src/tools/postgres.ts:3-5` uses regexes for blocked SQL and schema identifiers.
- `tools/scce-dev-mcp/src/tools/postgres.ts:29-35` interpolates the schema string into SQL after regex validation.
- `tools/scce-dev-mcp/src/tools/postgres.ts:41` swallows column inspection failures.
- `tools/scce-dev-mcp/src/tools/postgres.ts:46` swallows index inspection failures.
- `tools/scce-dev-mcp/src/tools/postgres.ts:53-80` implements read-only SQL gating with regexes, not a parser.

Production consequence:

This is acceptable-ish for local dev tooling, not for public diagnostic endpoints. Silent partial failure makes operators trust incomplete schema reports.

Minimal remediation:

Keep it local-only. Return partial failure warnings. Do not expand it into production admin tooling without proper SQL parsing or a fixed query API.

### P2-5: File Root Defaults Are Too Broad for an Unauthenticated API

Evidence:

- `scce.config.json:12-17` sets workspace root to `.`, temp root to `.tmp/scce-runs`, and allowed roots to `[".", "C:/Users/react/Downloads"]`.
- `packages/server/src/routes.ts:47-50` exposes ingestion/workspace mutation routes.
- `packages/server/src/routes.ts:728-744` exposes allowed roots through public config.

Production consequence:

Local-first does not mean "safe to expose local filesystem roots." With no auth, the configured root list becomes an attack surface.

Minimal remediation:

Require auth for all file ingestion. Hide root paths from public config. Treat non-workspace roots as explicit per-session operator grants.

## P3 Findings

### P3-1: Documentation Contradicts Current Reality

Docs that are honest:

- `docs/BUYER_GUIDE.md:31` says the repo is not a finished commercial deployment.
- `docs/BUYER_GUIDE.md:75` says it should be evaluated as a serious alpha runtime core.
- `docs/SERIOUS_VERSION_AUDIT.md:10-28` admits major scoring systems are provisional, hard-coded, or fallback.

Docs that are stale or too brave:

- `docs/REPO_COMPLETION_MAP.md:4` describes a path to "production-ready local AI runtime."
- `docs/REPO_COMPLETION_MAP.md:12-18` claims build pass, tests pass, circular deps none, one-lane architecture, and partial readiness.
- `docs/REPO_COMPLETION_MAP.md:40-48` claims the core runtime, test suite, architecture, evidence path, mouth quality, chat battery, workspace intelligence, and ingestion are working.
- `docs/REPO_COMPLETION_MAP.md:220-224` says `pnpm test (all pass)`.

Current command results disprove those claims.

Production consequence:

The docs undermine trust because one set admits alpha limitations while another claims green tests and no cycles.

Minimal remediation:

Make `REPO_COMPLETION_MAP.md` status-generated or delete stale pass claims. Keep buyer docs candid. Add date and command-output provenance to every readiness claim.

### P3-2: Root Package Says Private and Unlicensed

Evidence:

- `package.json:4` has `"private": true`.
- `package.json:6` has `"license": "UNLICENSED"`.

Production consequence:

If this is actually public and being sold, packaging metadata is not aligned with product reality. This is not a code bug, but it is a commercial hygiene issue.

Minimal remediation:

Align metadata with the intended distribution model. If private and unlicensed is intentional, do not call it public distributable software.

## Walsh Path Review

### Evidence Before Assertion

The codebase has meaningful evidence structures and proof paths, but it also has exceptions that weaken the contract:

- `kernel.ts:1706-1708` certifies arithmetic with empty evidence.
- `answer-emitter.ts:67` can fall back to source request text.
- Background persistence can lose proof records after answer return.

Verdict: present but not invariant.

### Typed Observations

Typed ingestion exists and builds graph nodes/edges, but relation seeds are English-like strings:

- `typed-ingest.ts:670-672`
- `typed-ingest.ts:693-775`

Verdict: useful implementation, contract wording overclaims language neutrality.

### Graph and Hyperedge Semantics

The Postgres schema supports graph nodes, edges, and hyperedges:

- `postgres.ts:310-312`

But much typed ingest projection emits ordinary edges with relation strings, and hyperedge role semantics are not obviously enforced at the ingestion boundary.

Verdict: graph-native substrate exists; role-bearing evidence discipline needs stronger tests.

### Alpha-Normalized Fabric

Alpha fields and traces exist through field activation and scoring, but much alpha use is fixed-weight scoring:

- `candidate.ts:315-328`
- `candidate.ts:354-366`

Verdict: alpha is implemented as an engineering signal, not yet demonstrably calibrated normalization.

### Route Scoring

Candidate route scoring exists, but final candidate mass and operator rows are hand-weighted:

- `candidate.ts:354-388`

Verdict: route scoring exists but remains provisional heuristic unless calibration is actually used at final decision time.

### Contradiction Mass

Contradiction fields and proof pressure exist:

- `runtime-coherence.ts:69-74`
- `candidate.ts:321`
- `candidate.ts:365`

But post-hoc coherence mostly demotes force rather than repairing or reselecting.

Verdict: contradiction mass is tracked, but not always decisive enough.

### Temporal Validity

Schema and graph records have temporal fields:

- `typed-ingest.ts:680`
- `postgres.ts:311-312`

This review did not find strong evidence that temporal validity is a hard admissibility gate across final answer selection.

Verdict: temporal data is present, temporal admissibility needs stronger proof.

### Proof-Carrying Answer

Proof records, PCA, validation, and emission graphs exist. But background persistence and multiple return lanes weaken the guarantee.

Verdict: proof-carrying answer exists as a structure, not as an always-durable invariant.

### Mouth Boundary

The main path correctly calls mouth after candidate/proof work:

- `kernel.ts:2490-2507`

But separate early lanes skip mouth, and runtime coherence happens after mouth output.

Verdict: mouth boundary is present in main path, not universal across all turn returns.

### Trace Math Path

Trace stages exist, but tracing is global, synchronous, and best-effort:

- `trace.ts:45-65`
- `server/index.ts:12-14`
- `routes.ts:78`

Verdict: good debug scaffold, not production trace architecture.

## Fix Order

1. Fix `discourse-state` sparse continuation and UTF-8 test text so `pnpm test:structural` passes.
2. Add authentication/authorization gate before `dispatch`; deny mutating routes without identity.
3. Disable wildcard web fetch by default; add SSRF guards, timeout, redirect control, and streaming byte caps.
4. Enforce `encryptSecretsAtRest` in config validation.
5. Fix `listSemanticFrames` embedding round-trip and add a test.
6. Make proof/construct/validation/emission persistence foreground or transactional for all non-trivial answer forces.
7. Make `repo:deps` ignore `dist`, add dependency-cruiser config, and break real source cycles.
8. Reconcile `postgres-contract.ts` with the adapter schema and add live-schema verification.
9. Collapse turn early returns into a single finalization pipeline.
10. Replace route casts with runtime schemas.
11. Update docs to remove stale green claims and separate alpha truth from production promises.

## Current Release Gate Status

Release should be blocked.

Reasons:

- `pnpm test:structural` fails.
- `pnpm repo:deps` fails.
- `pnpm repo:cruise` fails.
- `pnpm scce:audit` cannot pass.
- Public/mutating API has no auth boundary.
- Default web connector policy is wildcard.
- Durable proof persistence is not guaranteed for core turn paths.

## Remaining Review Risk

This review did not execute a live Postgres migration against a real database, did not run end-to-end browser/API traffic, did not fuzz route bodies, and did not benchmark long-running ingestion. Those are required before any production claim.

The review did include repository-wide static scans, build/test/audit commands, exact hot-path source inspection, config inspection, and documentation contradiction checks.
