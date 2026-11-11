// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Component, Suspense, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RelayEnvironmentProvider } from "react-relay";
import { fetchQuery } from "relay-runtime";
import { Workbench, runtimeQuery } from "./Workbench";
import type { WorkbenchRuntimeQuery } from "./__generated__/WorkbenchRuntimeQuery.graphql";
import { createBrowserEnvironment, createLocalEnvironment } from "./network";
import "./style.css";

function App() {
  const [connection, setConnection] = useState<ReturnType<typeof createLocalEnvironment> | null>(null);
  const [mode, setMode] = useState<"browser" | "companion">("browser");
  const [endpoint, setEndpoint] = useState(() => ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)
    ? `${location.origin}/api/graphql` : "http://127.0.0.1:3873/api/graphql");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => () => connection?.close(), [connection]);
  async function connect() {
    setBusy(true); setError("");
    let candidate: ReturnType<typeof createLocalEnvironment> | undefined;
    try {
      candidate = mode === "browser" ? createBrowserEnvironment() : createLocalEnvironment({ endpoint, token });
      await fetchQuery<WorkbenchRuntimeQuery>(candidate.environment, runtimeQuery, {}).toPromise();
      setConnection(candidate); setToken("");
    } catch (error) { candidate?.close(); setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  if (!connection) return <main className="connect"><span className="eyebrow">SCCE WORKBENCH</span><h1>Start your local engine</h1><p>Your engine and learned state stay on your computer.</p>
    <form onSubmit={event => { event.preventDefault(); void connect(); }}><label htmlFor="runtime">Runtime</label><select id="runtime" value={mode} onChange={event => setMode(event.target.value as "browser" | "companion")}><option value="browser">Browser worker (SQLite OPFS)</option><option value="companion">Native companion (local GraphQL)</option></select>
      {mode === "companion" && <><label htmlFor="host">Local GraphQL endpoint</label><input id="host" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} required />
      <label htmlFor="token">Bearer token, if required</label><input id="token" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" /></>}
      {mode === "browser" && <p>Runs the portable evidence-and-learning slice in a dedicated Worker and reopens its state from OPFS. No host API request is made.</p>}
      {error && <p role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button></form></main>;
  return <ErrorBoundary reset={() => setConnection(null)}><RelayEnvironmentProvider environment={connection.environment}><Suspense fallback={<main className="connect" role="status">Loading your workspace…</main>}><Workbench disconnect={() => setConnection(null)} /></Suspense></RelayEnvironmentProvider></ErrorBoundary>;
}
class ErrorBoundary extends Component<{ children: ReactNode; reset(): void }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main className="connect"><h1>Local connection interrupted</h1><p role="alert">{this.state.error}</p><button onClick={this.props.reset}>Reconnect</button></main> : this.props.children; }
}
createRoot(document.getElementById("root")!).render(<App />);
