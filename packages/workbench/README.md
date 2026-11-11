# SCCE workbench

The React/Relay workbench has two explicit runtimes. Native-companion mode connects to the full SCCE engine over local GraphQL. Browser mode runs the bounded portable kernel slice in a dedicated worker and keeps its local state in SQLite OPFS. They share the registered GraphQL schema and Relay client, but they are not capability-equivalent.

Both modes support request submission, live task progress, cancellation, durable task replay and paged activity. The native server redirects `/` to `/workbench/`; `/scce/workbench/` serves the same relative application assets.

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm scce:server --config scce.config.json
```

Open `http://127.0.0.1:3873/workbench/` and connect to the local endpoint. The `/scce/workbench/` mount serves the same relative assets. The bearer token stays in memory. An existing qualified, activated brain is required for the engine to answer; opening this interface does not train or activate one.

## Static browser deployment

`pnpm --filter @scce/workbench build` produces one relocatable static folder at `packages/workbench/dist`. It can be copied to a static HTTPS host when that host applies these headers to the application and worker assets:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The browser runtime and SQLite database then remain on the user's device; no hosted SCCE database or inference service receives the source bytes. This is a single-user local-first application slice, not the full SCCE engine or a multi-tenant SaaS. It does not include PostgreSQL corpus training, the native agent/tool adapters, the complete Mouth/runtime, or server-side account, tenancy, backup and billing services.

A deployment of the full native engine still requires the built Node server, PostgreSQL, configuration, secrets and a qualified brain. The repository's container path packages those as runtime and database services; it is not currently a single-folder static deployment.

`pnpm --filter @scce/workbench dev` starts Vite locally and proxies API calls to the configured development server on port 3873. Use the Vite origin's `/api/graphql` endpoint with that proxy. No cloud endpoint receives requests.

The build compiles Relay documents and TypeScript, produces the browser assets, then registers their operation texts in `packages/server/operations.json`. The server accepts registered operations through versioned envelopes rather than accepting arbitrary query text. Regenerate operations through `pnpm build`; verify the registry with `node tools/register-graphql-operations.mjs --check`.

The application first reserves a durable operation ID, then submits its request with that ID. Retry `startTurn` with the same ID and request after a transport failure. `clientMutationId` is correlation only. Conflicting input is rejected. A disconnected subscription does not cancel work. After a process restart, nonterminal tasks are interrupted; replaying a request does not resume or execute it again.

GraphQL and Relay are the application boundary; they do not replace PostgreSQL's internal relational operations or SCCE's cognitive structures. Native mode preserves the PostgreSQL adapter and existing learning, language-construction, proof, code and agent modules. There is no compatibility runtime for the retired language JOIN subsystem. Additional native tools continue through the original interface while their typed application services are migrated. No storage format or learned-state migration is performed by this package.
