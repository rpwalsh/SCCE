# SCCE for VS Code

This extension is a local client for the existing SCCE server API. It does not run a second cognitive path, invoke a model, or execute shell commands. It can modify workspace files only through the reviewed, content-addressed server patch transaction described below and only after explicit user and server authorization.

The package, command, and setting identifiers retain their `yopp` prefixes as
compatibility interfaces. The product surface is SCCE.

## Current surface

- Readiness status for a configured loopback SCCE server.
- Workspace initialize, ingest, and question commands. Every command that persists data requires a one-time modal approval.
- Project summaries, with a one-time approval because the current server implementation persists generated reports.
- Read-only workspace source/status inspection.
- Bounded coding-request planning through the server's strict, non-mutating coding route. The command binds the durable server workspace to the one open local VS Code folder, optionally refreshes durable bytes through the separately approved ingest command, and scopes the request to selected ingested source paths.
- Independent verification of returned plan hashes, request trace, source scope, validation policy, unauthorized state, and unexecuted state. Before either approval step, the extension verifies local base hashes and create absence, rejects workspace or symlink escapes, and opens a bounded virtual before/after diff containing every operation. Continuing requires an explicit post-preview confirmation.
- Reviewed patch-transaction application from a selected content-addressed JSON plan. The extension verifies the plan locally, shows paths and before/after hashes, requires an explicit modal review, completes the server's separate capability authorization, and displays the returned receipt.
- A native task timeline and Output channel. In-flight task metadata restored after an extension-host restart is marked `interrupted`; HTTP mutations are never replayed automatically.
- A bearer token stored through VS Code SecretStorage.

The client accepts only `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1` server origins, and calls only its fixed SCCE endpoint allowlist. Patch plans cannot supply a root, executable, argument vector, validation provider, or provider configuration: the server derives the persisted workspace root and commits through the compare-and-swap transaction boundary. The current VS Code client requests `trusted-host-pnpm-validate.v1`; it does not select the optional Docker provider. The patch command is disabled unless the server owner explicitly enables `config.policy.allowMutation`. Trusted-host validation is not an OS sandbox and must be used only with repository code trusted to run with the server process's authority. The server can produce unauthorized, unexecuted, content-addressed plans through the exact-byte proposal endpoint. Its separate coding-request route is strict and non-mutating, and the extension now calls it. Tested coding paths cover source-proven unused type-only import removal and one official TypeScript LanguageService fix rooted at an existing requested file. A structured positive integer `diagnosticCodes` value must resolve to one candidate; request prose never selects the action. Compiler input is limited to durable snapshot files plus the TypeScript standard library and must resolve an exact project config from the source-observed direct `tsc` invocation. Source-observed build/test commands are required. The returned plan is unauthorized and unexecuted and requires compiler/typecheck/test validation. The selected compiler action may close over up to 32 files and 128 exact text changes and may create bounded TypeScript/JavaScript sources under existing snapshot directories. Command-bearing actions, invalid targets, and arbitrary feature synthesis remain unsupported. The selected-JSON command remains available for independently produced plans and uses the same preview, workspace binding, authorization, and receipt checks. The legacy project/report GET handlers persist data and are declared mutating in the route manifest; this extension does not call report GETs and requires approval before project summary generation.

## Verification status

The extension package is part of the root build. Its client request/response contracts, content hashes, authorization receipts, and persisted task metadata have unit-test coverage. Run `pnpm vscode:package` to create `artifacts/scce-vscode.vsix`. Run `pnpm vscode:test:host` to package the extension, install that VSIX into an isolated VS Code 1.96.4 profile, activate the installed extension, verify its command registrations, and exercise readiness against a local test server.

The extension-host smoke test does not verify visual layout, restart recovery in the packaged host, or a patch transaction against a live SCCE server. Run `pnpm validate` for the complete source checkout rather than relying on a frozen test count.
