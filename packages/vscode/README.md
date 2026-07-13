# SCCE for VS Code

This extension is a local client for the existing SCCE server API. It does not run a second cognitive path, invoke a model, or execute shell commands. It can modify workspace files only through the reviewed, content-addressed server patch transaction described below and only after explicit user and server authorization.

## Current surface

- Readiness status for a configured loopback SCCE server.
- Workspace initialize, ingest, and question commands. Every command that persists data requires a one-time modal approval.
- Project summaries, with a one-time approval because the current server implementation persists generated reports.
- Read-only workspace source/status inspection.
- Reviewed patch-transaction application from a selected content-addressed JSON plan. The extension verifies the plan locally, shows paths and before/after hashes, requires an explicit modal review, completes the server's separate capability authorization, and displays the returned receipt.
- A native task timeline and Output channel. In-flight task metadata restored after an extension-host restart is marked `interrupted`; HTTP mutations are never replayed automatically.
- A bearer token stored through VS Code SecretStorage.

The client accepts only `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1` server origins, and calls only its fixed SCCE endpoint allowlist. Patch plans cannot supply a root, executable, argument vector, validation provider, or provider configuration: the server derives the persisted workspace root, selects its configured validation policy, and commits through the compare-and-swap transaction boundary. The command is disabled unless the server owner explicitly enables `config.policy.allowMutation`. Trusted-host validation remains the default and is not an OS sandbox. The optional Docker provider is server-selected and retains the documented Docker daemon, operator, image-supply-chain, and host-kernel trust boundary. The server can produce unauthorized, unexecuted, content-addressed plans through the exact-byte proposal endpoint. Its separate coding-request route is strict and non-mutating but has not demonstrated a successful production coding family; a generic existing-module request fails closed with `422` because generated ProgramGraph data lacks verified repair lineage. The extension currently reviews and applies a user-selected JSON plan rather than calling either planning route. The legacy project/report GET handlers persist data and are declared mutating in the route manifest; this extension does not call report GETs and requires approval before project summary generation.

## Verification status

The extension package is part of the root build, and its command, authorization, plan-review, and client behavior have unit-test coverage. Run `pnpm vscode:package` to create `artifacts/scce-vscode.vsix`. Run `pnpm vscode:test:host` to package the extension, install that VSIX into an isolated VS Code 1.96.4 profile, activate the installed extension, verify its command registrations, and exercise readiness against a local test server.

The extension-host smoke test does not verify visual layout, restart recovery in the packaged host, or a patch transaction against a live SCCE server. Run `pnpm validate` for the complete source checkout rather than relying on a frozen test count.
