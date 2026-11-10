# SCCE local workbench

The React/Relay workbench connects to the existing native SCCE engine over local GraphQL. It supports request submission, live task progress, cancellation, durable task replay and paged activity. The original workbench and its engine tools remain available at `/`.

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm scce:server --config scce.config.json
```

Open `http://127.0.0.1:3873/workbench/` and connect to the local endpoint. The `/scce/workbench/` mount serves the same relative assets. The bearer token stays in memory. An existing qualified, activated brain is required for the engine to answer; opening this interface does not train or activate one.

`pnpm --filter @scce/workbench dev` starts Vite locally and proxies API calls to the configured development server on port 3873. Use the Vite origin's `/api/graphql` endpoint with that proxy. No cloud endpoint receives requests.

The build compiles Relay documents and TypeScript, produces the browser assets, then registers their operation texts in `packages/server/operations.json`. The server accepts registered operations through versioned envelopes rather than accepting arbitrary query text. Regenerate operations through `pnpm build`; verify the registry with `node tools/register-graphql-operations.mjs --check`.

The application first reserves a durable operation ID, then submits its request with that ID. Retry `startTurn` with the same ID and request after a transport failure. `clientMutationId` is correlation only. Conflicting input is rejected. A disconnected subscription does not cancel work. After a process restart, nonterminal tasks are interrupted; replaying a request does not resume or execute it again.

This additive interface preserves the PostgreSQL adapter and existing learning, language, JOIN, proof, code and agent modules. Additional native tools continue through the original interface while their typed application services are migrated. No storage format or learned-state migration is performed by this package.
