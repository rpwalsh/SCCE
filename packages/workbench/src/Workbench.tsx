// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Fragment, Suspense, useMemo, useState, type ReactNode } from "react";
import { graphql, useLazyLoadQuery, usePaginationFragment, useRelayEnvironment, useSubscription } from "react-relay";
import { commitMutation, type Environment, type MutationParameters } from "relay-runtime";
import type { WorkbenchRuntimeQuery } from "./__generated__/WorkbenchRuntimeQuery.graphql";
import type { WorkbenchReserveMutation } from "./__generated__/WorkbenchReserveMutation.graphql";
import type { WorkbenchStartMutation } from "./__generated__/WorkbenchStartMutation.graphql";
import type { WorkbenchCancelMutation } from "./__generated__/WorkbenchCancelMutation.graphql";
import type { WorkbenchTaskQuery } from "./__generated__/WorkbenchTaskQuery.graphql";
import type { WorkbenchTaskSubscription } from "./__generated__/WorkbenchTaskSubscription.graphql";
import type { WorkbenchTask_task$key } from "./__generated__/WorkbenchTask_task.graphql";
import type { WorkbenchTaskPaginationQuery } from "./__generated__/WorkbenchTaskPaginationQuery.graphql";
import type { WorkbenchSourcesQuery } from "./__generated__/WorkbenchSourcesQuery.graphql";
import type { WorkbenchSourcesPaginationQuery } from "./__generated__/WorkbenchSourcesPaginationQuery.graphql";
import type { WorkbenchSources_sources$key } from "./__generated__/WorkbenchSources_sources.graphql";
import type { WorkbenchLearningQuery } from "./__generated__/WorkbenchLearningQuery.graphql";
import type { WorkbenchReviewHeldSourceMutation } from "./__generated__/WorkbenchReviewHeldSourceMutation.graphql";
import type { WorkbenchDataQuery } from "./__generated__/WorkbenchDataQuery.graphql";
import type { WorkbenchCapabilitiesQuery } from "./__generated__/WorkbenchCapabilitiesQuery.graphql";
import type { WorkbenchLearnSourceMutation } from "./__generated__/WorkbenchLearnSourceMutation.graphql";

export const runtimeQuery = graphql`query WorkbenchRuntimeQuery { runtime { protocolVersion generation phase ready } }`;
const sourcesQuery = graphql`query WorkbenchSourcesQuery { ...WorkbenchSources_sources }`;
const learningQuery = graphql`query WorkbenchLearningQuery {
  vscodeLearningCurriculum { schema items { planId query rationale } }
  vscodeHeldSources(first: 20) { schema held { id uri title preview evidenceCount } }
}`;
const dataQuery = graphql`query WorkbenchDataQuery {
  vscodeWorkspaceStatus { workspace { id rootPath updatedAt } sources { path } }
}`;
const capabilitiesQuery = graphql`query WorkbenchCapabilitiesQuery {
  vscodeSettings { schema configPath fields { key label kind choices value } }
  vscodeModels { schema modelDir models { id path bytes files active size } totalBytes }
  vscodeCodeValidationPolicies { policies { id checks } provider }
}`;
const reserveMutation = graphql`mutation WorkbenchReserveMutation($input: ReserveTurnInput!) { reserveTurn(input: $input) { task { id status } } }`;
const startMutation = graphql`mutation WorkbenchStartMutation($input: StartTurnInput!) { startTurn(input: $input) { task { id status latestSequence } } }`;
const cancelMutation = graphql`mutation WorkbenchCancelMutation($input: CancelTurnInput!) { cancelTurn(input: $input) { task { id status latestSequence } } }`;
const reviewHeldMutation = graphql`mutation WorkbenchReviewHeldSourceMutation($input: VscodeReviewCommandInput!) {
  vscodeReviewHeldSource(input: $input) { clientMutationId schema review { id decision promotedEvidence } }
}`;
const learnSourceMutation = graphql`mutation WorkbenchLearnSourceMutation($input: LearnSourceInput!) {
  learnSource(input: $input) { clientMutationId evidenceId languageProfileId source { id sourceId canonicalUri byteLength } }
}`;
const taskQuery = graphql`query WorkbenchTaskQuery($id: ID!) { turnTask(id: $id) { ...WorkbenchTask_task } }`;
const taskSubscription = graphql`subscription WorkbenchTaskSubscription($id: ID!, $afterSequence: Int!) {
  turnTaskUpdated(id: $id, afterSequence: $afterSequence) {
    id status latestSequence persistence
    latestFrame { id phase kind answer error sequence status detail assistantForce }
    result {
      id answer error httpStatus episodeId value detail entailment
      guardFlags { sourceBacked }
      evidence { id sourceId textPreview provenance }
    }
  }
}`;

type View = "work" | "learning" | "data" | "settings";
const viewText: Record<View, { eyebrow: string; title: string; privacy: string }> = {
  work: { eyebrow: "YOUR LOCAL WORKSPACE", title: "Work / Tasks", privacy: "Local execution" },
  learning: { eyebrow: "EVIDENCE AND LEARNING", title: "Sources / Learning", privacy: "Exact source identities" },
  data: { eyebrow: "DURABLE LOCAL STATE", title: "Data / Backups", privacy: "No cloud copy" },
  settings: { eyebrow: "LOCAL RUNTIME", title: "Settings / Capabilities", privacy: "Server-owned policy" }
};

export function Workbench({ disconnect }: { disconnect(): void }) {
  const runtime = useLazyLoadQuery<WorkbenchRuntimeQuery>(runtimeQuery, {}, { fetchPolicy: "store-or-network" });
  const environment = useRelayEnvironment();
  const [draft, setDraft] = useState("");
  const [taskId, setTaskId] = useState(() => /^[A-Za-z0-9_-]{20,2048}$/u.test(location.hash.slice(1)) ? location.hash.slice(1) : null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("work");
  async function submit() {
    if (busy || !draft.trim()) return;
    if (!runtime.runtime.ready) { setError("The local engine is not ready yet. Wait for readiness before starting work."); return; }
    setBusy(true); setError("");
    try {
      let id = operationId;
      if (!id) {
        const reserved = await command<WorkbenchReserveMutation>(environment, reserveMutation, { input: {} });
        id = reserved.reserveTurn.task.id;
        setOperationId(id);
      }
      setTaskId(id); setSubmitted(draft); location.hash = id;
      await command<WorkbenchStartMutation>(environment, startMutation, { input: { operationId: id, text: draft, sessionId: "workbench.default" } });
      setDraft(""); setOperationId(null);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  const heading = viewText[view];
  return <div className="shell">
    <aside>
      <div className="brand" aria-label="SCCE local cognitive engine">SCCE<span>Local cognitive engine</span></div>
      <nav aria-label="Workbench views">
        <NavButton active={view === "work"} onClick={() => setView("work")}>Work / Tasks</NavButton>
        <NavButton active={view === "learning"} onClick={() => setView("learning")}>Sources / Learning</NavButton>
        <NavButton active={view === "data"} onClick={() => setView("data")}>Data / Backups</NavButton>
        <NavButton active={view === "settings"} onClick={() => setView("settings")}>Settings / Capabilities</NavButton>
      </nav>
      <div className="connection"><span className={runtime.runtime.ready ? "dot ready" : "dot"} aria-hidden="true" />
        <span>{runtime.runtime.ready ? "Connected" : "Not ready"}: {runtime.runtime.phase}</span>
        <button onClick={disconnect}>Disconnect</button>
      </div>
    </aside>
    <main id={view}>
      <header><div><span className="eyebrow">{heading.eyebrow}</span><h1>{heading.title}</h1></div><span className="private">{heading.privacy}</span></header>
      {!runtime.runtime.ready && <StatusNotice tone="warning" title="Local engine not ready">Phase: {runtime.runtime.phase}. Read-only data may remain available, but new work is disabled.</StatusNotice>}
      {view === "work" && <WorkView taskId={taskId} submitted={submitted} draft={draft} busy={busy} error={error}
        ready={runtime.runtime.ready} disconnect={disconnect} setDraft={setDraft} submit={submit} />}
      {view === "learning" && <Suspense fallback={<Loading label="Loading sources and learning state" />}><LearningView /></Suspense>}
      {view === "data" && <Suspense fallback={<Loading label="Loading durable data status" />}><DataView /></Suspense>}
      {view === "settings" && <Suspense fallback={<Loading label="Loading settings and capabilities" />}><CapabilitiesView /></Suspense>}
    </main>
  </div>;
}

function NavButton({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) {
  return <button className="nav-link" aria-current={active ? "page" : undefined} onClick={onClick}>{children}</button>;
}

function WorkView(props: { taskId: string | null; submitted: string; draft: string; busy: boolean; error: string; ready: boolean;
  disconnect(): void; setDraft(value: string): void; submit(): Promise<void> }) {
  return <>
    <section className="conversation" aria-label="Current work and task">
      {!props.taskId && <div className="welcome"><div className="mark">S</div><h2>What would you like to work on?</h2><p>Ask about learned sources, explore an idea, or run a programming task on the local engine.</p>
        <p className="availability">Task history listing is not registered in this build. This view shows the current durable task only.</p></div>}
      {props.submitted && <article className="request"><span>You</span><p dir="auto">{props.submitted}</p></article>}
      {props.taskId && <Suspense fallback={<Loading label="Loading task" />}><Task id={props.taskId} disconnect={props.disconnect} key={props.taskId} /></Suspense>}
    </section>
    <form className="composer" onSubmit={event => { event.preventDefault(); void props.submit(); }}>
      {props.error && <p role="alert">{props.error}</p>}
      <label htmlFor="request">Your request</label><textarea id="request" dir="auto" value={props.draft} onChange={event => props.setDraft(event.target.value)}
        maxLength={20_000} rows={3} disabled={props.busy || !props.ready} placeholder="Ask SCCE..." />
      <div className="composer-actions"><span>Runs on your local engine</span><button className="primary" disabled={props.busy || !props.ready || !props.draft.trim()} type="submit">{props.busy ? "Starting..." : "Send request"}</button></div>
    </form>
  </>;
}

function LearningView() {
  const environment = useRelayEnvironment();
  const [fetchKey, setFetchKey] = useState(0);
  const [reviewing, setReviewing] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const data = useLazyLoadQuery<WorkbenchLearningQuery>(learningQuery, {}, { fetchPolicy: "store-and-network", fetchKey });
  const curriculum = curriculumItems(data.vscodeLearningCurriculum);
  const held = heldSources(data.vscodeHeldSources);
  async function review(id: string, decision: "promoted" | "rejected") {
    setReviewing(id); setError(""); setNotice("");
    try {
      await command<WorkbenchReviewHeldSourceMutation>(environment, reviewHeldMutation, { input: {
        operationId: crypto.randomUUID(), clientMutationId: crypto.randomUUID(), id, decision
      } });
      setNotice(`${id} was ${decision}.`); setFetchKey(value => value + 1);
    } catch (failure) { setError(message(failure)); }
    finally { setReviewing(""); }
  }
  return <div className="view-stack">
    {notice && <StatusNotice tone="success" title="Review recorded">{notice}</StatusNotice>}
    {error && <p role="alert">{error}</p>}
    <SourceImport onLearned={() => setFetchKey(value => value + 1)} />
    <SourcesView fetchKey={fetchKey} />
    <section className="panel" aria-labelledby="curriculum-heading"><div className="panel-heading"><div><span className="eyebrow">OWNER CONSENT</span><h2 id="curriculum-heading">Learning proposals</h2></div><span className="count">{curriculum.length}</span></div>
      {!curriculum.length ? <EmptyState title="No pending learning proposals">The engine has not proposed a consent-bound learning query.</EmptyState>
        : <ul className="card-list">{curriculum.map(item => <li key={item.planId}><strong>{item.query}</strong><p>{item.rationale || "No rationale was recorded."}</p><code>{item.planId}</code><span className="state pending">Pending owner consent</span></li>)}</ul>}
    </section>
    <section className="panel" aria-labelledby="held-heading"><div className="panel-heading"><div><span className="eyebrow">QUARANTINED MATERIAL</span><h2 id="held-heading">Held sources</h2></div><span className="count">{held.length}</span></div>
      {!held.length ? <EmptyState title="Nothing awaiting review">No held source requires an owner decision.</EmptyState>
        : <ul className="card-list">{held.map(item => <li key={item.id}><strong>{item.title || item.uri || item.id}</strong><p>{item.preview || "No preview is available."}</p><span>{item.evidenceCount} candidate evidence spans</span><div className="row-actions"><button disabled={reviewing === item.id} onClick={() => void review(item.id, "promoted")}>Promote</button><button disabled={reviewing === item.id} onClick={() => void review(item.id, "rejected")}>Reject</button></div></li>)}</ul>}
    </section>
  </div>;
}

function SourceImport({ onLearned }: { onLearned(): void }) {
  const environment = useRelayEnvironment();
  const [canonicalUri, setCanonicalUri] = useState("");
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  async function learn() {
    if (busy || !canonicalUri.trim() || !sourceText) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await command<WorkbenchLearnSourceMutation>(environment, learnSourceMutation, { input: {
        operationId: crypto.randomUUID(), namespace: "workbench-owner", canonicalUri: canonicalUri.trim(),
        mediaType: "text/plain", bytesBase64: base64Utf8(sourceText), observedAt: Date.now(),
        ...(title.trim() ? { title: title.trim() } : {}), clientMutationId: crypto.randomUUID()
      } });
      setNotice(`Learned ${result.learnSource.source.canonicalUri} as ${result.learnSource.languageProfileId}.`);
      setSourceText(""); onLearned();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby="source-import-heading"><div className="panel-heading"><div><span className="eyebrow">OWNER SOURCE</span><h2 id="source-import-heading">Learn an exact text source</h2></div></div>
    <form onSubmit={event => { event.preventDefault(); void learn(); }}><label htmlFor="source-uri">Canonical URI</label><input id="source-uri" value={canonicalUri} onChange={event => setCanonicalUri(event.target.value)} maxLength={4096} required />
      <label htmlFor="source-title">Title</label><input id="source-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={512} />
      <label htmlFor="source-text">Exact UTF-8 source text</label><textarea id="source-text" value={sourceText} onChange={event => setSourceText(event.target.value)} maxLength={32_000} rows={6} required />
      {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}<button disabled={busy || !canonicalUri.trim() || !sourceText}>{busy ? "Learning..." : "Learn source"}</button></form>
  </section>;
}

function SourcesView({ fetchKey = 0 }: { fetchKey?: number }) {
  const data = useLazyLoadQuery<WorkbenchSourcesQuery>(sourcesQuery, {}, { fetchPolicy: "store-and-network", fetchKey });
  return <SourcesConnection sources={data} />;
}

function SourcesConnection({ sources }: { sources: WorkbenchSources_sources$key }) {
  const { data, hasNext, loadNext, isLoadingNext } = usePaginationFragment<WorkbenchSourcesPaginationQuery, WorkbenchSources_sources$key>(graphql`
    fragment WorkbenchSources_sources on Query
    @argumentDefinitions(count: {type: "Int", defaultValue: 20}, cursor: {type: "String"})
    @refetchable(queryName: "WorkbenchSourcesPaginationQuery") {
      sources(first: $count, after: $cursor) @connection(key: "WorkbenchSources_sources") {
        edges { cursor node { id sourceId namespace canonicalUri mediaType byteLength observedAt promotedSpanCount } }
      }
    }`, sources);
  return <section className="panel source-inventory" aria-labelledby="sources-heading"><div className="panel-heading"><div><span className="eyebrow">ADMITTED EVIDENCE</span><h2 id="sources-heading">Learned source versions</h2></div><span className="count">{data.sources.edges.length}{hasNext ? "+" : ""}</span></div>
    {!data.sources.edges.length ? <EmptyState title="No evidence-backed sources yet">Add and learn from a source through a qualified local import operation.</EmptyState> : <>
      <ol>{data.sources.edges.map(edge => <li key={edge.node.id}><div><strong>{edge.node.canonicalUri}</strong><span>{edge.node.namespace} / {edge.node.mediaType}</span><code>{edge.node.sourceId}</code></div><dl><dt>Bytes</dt><dd>{edge.node.byteLength.toLocaleString()}</dd><dt>Evidence</dt><dd>{edge.node.promotedSpanCount ?? "-"}</dd><dt>Observed</dt><dd>{formatDate(edge.node.observedAt)}</dd></dl></li>)}</ol>
      {hasNext && <button disabled={isLoadingNext} onClick={() => loadNext(20)}>{isLoadingNext ? "Loading..." : "Load 20 more sources"}</button>}
    </>}
  </section>;
}

function DataView() {
  const data = useLazyLoadQuery<WorkbenchDataQuery>(dataQuery, {}, { fetchPolicy: "store-and-network" });
  const status = workspaceStatus(data.vscodeWorkspaceStatus);
  return <div className="view-stack">
    <section className="panel" aria-labelledby="workspace-data-heading"><div className="panel-heading"><div><span className="eyebrow">WORKSPACE LEDGER</span><h2 id="workspace-data-heading">Durable workspace data</h2></div><span className={`state ${status ? "available" : "unavailable"}`}>{status ? "Available" : "Unavailable"}</span></div>
      {status ? <dl className="facts"><dt>Workspace</dt><dd>{status.rootPath}</dd><dt>Workspace ID</dt><dd><code>{status.id}</code></dd><dt>Recorded source files</dt><dd>{status.sourceCount.toLocaleString()}</dd><dt>Last update</dt><dd>{formatDate(status.updatedAt)}</dd></dl>
        : <EmptyState title="No initialized workspace">Initialize and ingest a local workspace before workspace data can be inspected.</EmptyState>}
    </section>
    <section className="panel" aria-labelledby="backup-heading"><div className="panel-heading"><div><span className="eyebrow">RECOVERY</span><h2 id="backup-heading">Backups</h2></div><span className="state unavailable">Unavailable</span></div>
      <StatusNotice tone="neutral" title="No registered backup capability">This build exposes no backup, restore, export, or snapshot command through the local GraphQL schema. No control is shown because the operation is not available.</StatusNotice>
    </section>
  </div>;
}

function CapabilitiesView() {
  const data = useLazyLoadQuery<WorkbenchCapabilitiesQuery>(capabilitiesQuery, {}, { fetchPolicy: "store-and-network" });
  const settings = settingFields(data.vscodeSettings);
  const models = modelStatus(data.vscodeModels);
  const validation = validationStatus(data.vscodeCodeValidationPolicies);
  return <div className="view-stack">
    <section className="panel" aria-labelledby="capabilities-heading"><div className="panel-heading"><div><span className="eyebrow">REGISTERED OPERATIONS</span><h2 id="capabilities-heading">Capabilities</h2></div></div>
      <ul className="capability-grid">
        <Capability title="Code validation" state={validation.policies.length ? "available" : "unavailable"}>{validation.policies.length ? `${validation.provider}; ${validation.policies.length} policy descriptors.` : "No validation policy is registered."}</Capability>
        <Capability title="Local visual models" state={models.models.length ? "available" : "unavailable"}>{models.models.length ? `${models.models.length} installed; ${models.active} active.` : "No local visual model is installed."}</Capability>
        <Capability title="Backups and restore" state="unavailable">No registered GraphQL operation is present.</Capability>
        <Capability title="Companion connection" state="disconnected">No companion is connected to this browser workbench. Reconnect from the companion surface when one is configured.</Capability>
      </ul>
    </section>
    <section className="panel" aria-labelledby="settings-heading"><div className="panel-heading"><div><span className="eyebrow">SERVER-OWNED CONFIGURATION</span><h2 id="settings-heading">Settings</h2></div><span className="count">{settings.length}</span></div>
      {!settings.length ? <EmptyState title="Settings unavailable">The connected server returned no public setting descriptors.</EmptyState>
        : <div className="table-wrap"><table><thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Kind</th></tr></thead><tbody>{settings.map(field => <tr key={field.key}><th scope="row">{field.label || field.key}<code>{field.key}</code></th><td>{displayValue(field.value)}</td><td>{field.kind}</td></tr>)}</tbody></table></div>}
      <p className="availability">Settings are read-only here. This view does not infer write controls from untyped values.</p>
    </section>
  </div>;
}

function Capability({ title, state, children }: { title: string; state: "available" | "unavailable" | "disconnected"; children: string }) {
  return <li><div><strong>{title}</strong><span className={`state ${state}`}>{state}</span></div><p>{children}</p></li>;
}

function Task({ id, disconnect }: { id: string; disconnect(): void }) {
  const data = useLazyLoadQuery<WorkbenchTaskQuery>(taskQuery, { id }, { fetchPolicy: "network-only" });
  return data.turnTask ? <TaskDetails task={data.turnTask} disconnect={disconnect} />
    : <StatusNotice tone="warning" title="Task unavailable">This task ID does not exist in the connected local state. Return to the current engine or start new work.</StatusNotice>;
}

function TaskDetails({ task, disconnect }: { task: WorkbenchTask_task$key; disconnect(): void }) {
  const environment = useRelayEnvironment();
  const { data, hasNext, loadNext, isLoadingNext } = usePaginationFragment<WorkbenchTaskPaginationQuery, WorkbenchTask_task$key>(graphql`
    fragment WorkbenchTask_task on TurnTask
    @argumentDefinitions(count: {type: "Int", defaultValue: 20}, cursor: {type: "String"})
    @refetchable(queryName: "WorkbenchTaskPaginationQuery") {
      id status latestSequence persistence
      latestFrame { id phase kind answer error sequence status detail assistantForce }
      result {
        id answer error httpStatus episodeId value detail entailment
        guardFlags { sourceBacked }
        evidence { id sourceId textPreview provenance }
      }
      frames(first: $count, after: $cursor) @connection(key: "WorkbenchTask_frames") {
        edges { node { id sequence kind phase } }
      }
    }`, task);
  const [streamError, setStreamError] = useState("");
  const [retry, setRetry] = useState(0);
  const [initialSequence] = useState(data.latestSequence);
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(data.status);
  const config = useMemo(() => ({ subscription: taskSubscription,
    variables: { id: data.id, afterSequence: retry ? data.latestSequence : initialSequence },
    onError(error: Error) { setStreamError(error.message); }
  }), [data.id, data.latestSequence, initialSequence, retry]);
  useSubscription<WorkbenchTaskSubscription>(config);
  async function cancel() {
    try { await command<WorkbenchCancelMutation>(environment, cancelMutation, { input: { taskId: data.id } }); }
    catch (failure) { setStreamError(message(failure)); }
  }
  const stale = /stale|generation|runtime changed/iu.test(streamError);
  const evidence = (data.result?.evidence ?? []).slice(0, 12);
  const outcome = taskOutcome(data.result?.value);
  return <article className="response"><div className="response-heading"><strong>SCCE</strong><span className={`state ${taskStateClass(data.status)}`} role="status">{data.status}</span>{!terminal && <button onClick={() => void cancel()}>Stop task</button>}</div>
    <div className="answer" dir="auto">{data.result?.answer || data.latestFrame?.answer || (!terminal ? "Working..." : "")}</div>
    {(data.result?.error || data.latestFrame?.error) && <p role="alert">{data.result?.error || data.latestFrame?.error}</p>}
    {data.persistence !== "durable" && <StatusNotice tone="warning" title="Persistence pending">The latest task activity is not yet confirmed durable.</StatusNotice>}
    {data.status === "interrupted" && <StatusNotice tone="warning" title="Task interrupted">The host restarted before completion. Recorded work is preserved and will not execute again automatically. Start a new task to continue.</StatusNotice>}
    {data.status === "cancelled" && <StatusNotice tone="neutral" title="Task cancelled">Execution stopped by request. Activity already committed remains available below.</StatusNotice>}
    {data.status === "failed" && <StatusNotice tone="warning" title="Task failed">Review the recorded error and activity. Retrying creates a new operation; it does not replay this task.</StatusNotice>}
    {streamError && <p role="alert">{streamError} {stale ? <button onClick={disconnect}>Reconnect local engine</button> : <button onClick={() => { setStreamError(""); setRetry(value => value + 1); }}>Reconnect task stream</button>}</p>}
    {(data.result?.guardFlags || data.result?.entailment) && <section className="result-section" aria-labelledby="uncertainty-heading"><h3 id="uncertainty-heading">Support and uncertainty</h3><dl className="facts"><dt>Source backed</dt><dd>{data.result.guardFlags?.sourceBacked === true ? "Yes" : data.result.guardFlags?.sourceBacked === false ? "No" : "Not recorded"}</dd><dt>Entailment</dt><dd>{uncertainty(data.result.entailment)}</dd></dl></section>}
    {!!evidence.length && <section className="result-section" aria-labelledby="evidence-heading"><h3 id="evidence-heading">Evidence used</h3><ol className="evidence-list">{evidence.map((item, index) => <li key={item.id ?? `${item.sourceId ?? "evidence"}-${index}`}><strong>{item.sourceId || item.id || "Evidence span"}</strong>{item.textPreview && <p>{item.textPreview}</p>}</li>)}</ol>{(data.result?.evidence?.length ?? 0) > evidence.length && <p className="availability">Showing the first {evidence.length} evidence spans.</p>}</section>}
    {outcome && <section className="result-section" aria-labelledby="outcome-heading"><h3 id="outcome-heading">Approval or receipt</h3><dl className="facts">{outcome.map(row => <Fragment key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></Fragment>)}</dl></section>}
    <details><summary>Task activity · {data.latestSequence} events · {data.persistence}</summary><ol className="events">{data.frames.edges.map(edge => <li key={edge.node.id}><span>{edge.node.sequence}</span>{edge.node.phase || edge.node.kind}</li>)}</ol>{hasNext && <button disabled={isLoadingNext} onClick={() => loadNext(20)}>{isLoadingNext ? "Loading..." : "Load 20 more events"}</button>}</details>
  </article>;
}

function StatusNotice({ tone, title, children }: { tone: "neutral" | "warning" | "success"; title: string; children: ReactNode }) {
  return <div className={`notice ${tone}`} role={tone === "warning" ? "alert" : "status"}><strong>{title}</strong><p>{children}</p></div>;
}
function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><strong>{title}</strong><p>{children}</p></div>;
}
function Loading({ label }: { label: string }) { return <p className="loading" role="status">{label}...</p>; }

type Row = Record<string, unknown>;
function row(value: unknown): Row | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function rows(value: unknown, limit: number): Row[] { return Array.isArray(value) ? value.slice(0, limit).map(row).filter((item): item is Row => Boolean(item)) : []; }
function text(value: unknown, limit = 500): string { return typeof value === "string" ? value.slice(0, limit) : ""; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function curriculumItems(value: unknown) {
  return rows(row(value)?.items, 100).map(item => ({ planId: text(item.planId, 256), query: text(item.query, 2_000), rationale: text(item.rationale, 1_000) })).filter(item => item.planId && item.query);
}
function heldSources(value: unknown) {
  return rows(row(value)?.held, 20).map(item => ({ id: text(item.id, 256), uri: text(item.uri, 2_000), title: text(item.title, 500), preview: text(item.preview, 2_000), evidenceCount: number(item.evidenceCount) })).filter(item => item.id);
}
function workspaceStatus(value: unknown): { id: string; rootPath: string; updatedAt: number; sourceCount: number } | undefined {
  const input = row(value), workspace = row(input?.workspace);
  if (!workspace) return undefined;
  const id = text(workspace.id, 256), rootPath = text(workspace.rootPath, 4_096);
  return id && rootPath ? { id, rootPath, updatedAt: number(workspace.updatedAt), sourceCount: rows(input?.sources, 10_000).length } : undefined;
}
function settingFields(value: unknown) {
  return rows(row(value)?.fields, 100).map(field => ({ key: text(field.key, 256), label: text(field.label, 500), kind: text(field.kind, 64), value: field.value })).filter(field => field.key);
}
function modelStatus(value: unknown) {
  const models = rows(row(value)?.models, 100);
  return { models, active: models.filter(model => model.active === true).length };
}
function validationStatus(value: unknown) {
  const input = row(value);
  return { provider: text(input?.provider, 256) || "unknown provider", policies: rows(input?.policies, 100) };
}
function uncertainty(value: unknown): string {
  const input = row(value);
  if (!input) return "Not recorded";
  for (const key of ["verdict", "epistemicForce", "confidence", "status"]) {
    const candidate = input[key];
    if (typeof candidate === "string" || typeof candidate === "number") return `${key}: ${String(candidate).slice(0, 200)}`;
  }
  return "Structured entailment record available";
}
function taskOutcome(value: unknown): Array<{ label: string; value: string }> | undefined {
  const input = row(value), pending = row(input?.pendingApproval), receipt = row(input?.receipt);
  if (pending) return [{ label: "State", value: "Pending approval" }, { label: "Capability", value: text(pending.capabilityId, 256) || "Unknown" }, { label: "Plan", value: text(pending.planId, 256) || "Unknown" }];
  if (receipt) return [{ label: "Receipt", value: text(receipt.receiptHash, 256) || "Recorded" }, { label: "Plan", value: text(receipt.planHash, 256) || "Not recorded" }, { label: "Mutations", value: String(rows(receipt.mutations, 256).length) }];
  return undefined;
}
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "Structured value";
}
function taskStateClass(status: string) { return status === "succeeded" ? "available" : status === "cancelled" || status === "interrupted" || status === "failed" ? "unavailable" : "pending"; }
function formatDate(value: number) { return value > 0 ? new Date(value).toLocaleString() : "Not recorded"; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function command<T extends MutationParameters>(environment: Environment, mutation: Parameters<typeof commitMutation<T>>[1]["mutation"], variables: T["variables"]): Promise<T["response"]> {
  return new Promise((resolve, reject) => commitMutation<T>(environment, { mutation, variables,
    onCompleted(data, errors) { if (errors?.length) reject(new Error(errors.map(error => error.message).join("; "))); else resolve(data); }, onError: reject }));
}
