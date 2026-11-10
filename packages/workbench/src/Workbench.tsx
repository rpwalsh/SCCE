// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Suspense, useMemo, useState } from "react";
import { graphql, useLazyLoadQuery, usePaginationFragment, useRelayEnvironment, useSubscription } from "react-relay";
import { commitMutation, type MutationParameters, type Environment } from "relay-runtime";
import type { WorkbenchRuntimeQuery } from "./__generated__/WorkbenchRuntimeQuery.graphql";
import type { WorkbenchReserveMutation } from "./__generated__/WorkbenchReserveMutation.graphql";
import type { WorkbenchStartMutation } from "./__generated__/WorkbenchStartMutation.graphql";
import type { WorkbenchCancelMutation } from "./__generated__/WorkbenchCancelMutation.graphql";
import type { WorkbenchTaskQuery } from "./__generated__/WorkbenchTaskQuery.graphql";
import type { WorkbenchTaskSubscription } from "./__generated__/WorkbenchTaskSubscription.graphql";
import type { WorkbenchTask_task$key } from "./__generated__/WorkbenchTask_task.graphql";
import type { WorkbenchTaskPaginationQuery } from "./__generated__/WorkbenchTaskPaginationQuery.graphql";

export const runtimeQuery = graphql`query WorkbenchRuntimeQuery { runtime { protocolVersion generation phase ready } }`;
const reserveMutation = graphql`mutation WorkbenchReserveMutation($input: ReserveTurnInput!) { reserveTurn(input: $input) { task { id status } } }`;
const startMutation = graphql`mutation WorkbenchStartMutation($input: StartTurnInput!) { startTurn(input: $input) { task { id status latestSequence } } }`;
const cancelMutation = graphql`mutation WorkbenchCancelMutation($input: CancelTurnInput!) { cancelTurn(input: $input) { task { id status latestSequence } } }`;
const taskQuery = graphql`query WorkbenchTaskQuery($id: ID!) { turnTask(id: $id) { ...WorkbenchTask_task } }`;
const taskSubscription = graphql`subscription WorkbenchTaskSubscription($id: ID!, $afterSequence: Int!) {
  turnTaskUpdated(id: $id, afterSequence: $afterSequence) {
    id status latestSequence persistence
    latestFrame { id phase kind answer error sequence }
    result { id answer error httpStatus episodeId }
  }
}`;

export function Workbench({ disconnect }: { disconnect(): void }) {
  const runtime = useLazyLoadQuery<WorkbenchRuntimeQuery>(runtimeQuery, {}, { fetchPolicy: "store-or-network" });
  const environment = useRelayEnvironment();
  const [draft, setDraft] = useState("");
  const [taskId, setTaskId] = useState(() => /^[A-Za-z0-9_-]{20,2048}$/u.test(location.hash.slice(1)) ? location.hash.slice(1) : null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || !draft.trim()) return;
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
      setSubmitted(draft); setTaskId(id); location.hash = id; setDraft(""); setOperationId(null);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <div className="shell">
    <aside><a className="brand" href="#">SCCE<span>Local cognitive engine</span></a>
      <nav aria-label="Workspace"><a href="#conversation" aria-current="page">Conversation</a><a href="/">Engine tools</a></nav>
      <div className="connection"><span className={runtime.runtime.ready ? "dot ready" : "dot"} /> {runtime.runtime.phase}<button onClick={disconnect}>Disconnect</button></div>
    </aside>
    <main id="conversation"><header><div><span className="eyebrow">YOUR LOCAL WORKSPACE</span><h1>Conversation</h1></div><span className="private">Local host connected</span></header>
      <section className="conversation" aria-label="Conversation">
        {!taskId && <div className="welcome"><div className="mark">S</div><h2>What would you like to work on?</h2><p>Ask about your sources, explore an idea, or work through a programming task.</p></div>}
        {submitted && <article className="request"><span>You</span><p dir="auto">{submitted}</p></article>}
        {taskId && <Suspense fallback={<p role="status">Loading task…</p>}><Task id={taskId} key={taskId} /></Suspense>}
      </section>
      <form className="composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        {error && <p role="alert">{error}</p>}
        <label htmlFor="request">Your request</label><textarea id="request" dir="auto" value={draft} onChange={event => setDraft(event.target.value)} maxLength={20_000} rows={3} disabled={busy} placeholder="Ask SCCE…" />
        <div className="composer-actions"><span>Runs on your local engine</span><button className="primary" disabled={busy || !draft.trim()} type="submit">{busy ? "Starting…" : operationId ? "Retry request" : "Send request"}</button></div>
      </form>
    </main>
  </div>;
}

function Task({ id }: { id: string }) {
  const data = useLazyLoadQuery<WorkbenchTaskQuery>(taskQuery, { id }, { fetchPolicy: "network-only" });
  return data.turnTask ? <TaskDetails task={data.turnTask} /> : <p role="alert">This task is unavailable in the connected local state.</p>;
}
function TaskDetails({ task }: { task: WorkbenchTask_task$key }) {
  const environment = useRelayEnvironment();
  const { data, hasNext, loadNext, isLoadingNext } = usePaginationFragment<WorkbenchTaskPaginationQuery, WorkbenchTask_task$key>(graphql`
    fragment WorkbenchTask_task on TurnTask
    @argumentDefinitions(count: {type: "Int", defaultValue: 20}, cursor: {type: "String"})
    @refetchable(queryName: "WorkbenchTaskPaginationQuery") {
      id status latestSequence persistence
      latestFrame { id phase kind answer error sequence }
      result { id answer error httpStatus episodeId }
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
    // The subscription is disposed automatically on unmount. Its lifetime does not own the task.
  }), [data.id, initialSequence, retry]);
  useSubscription<WorkbenchTaskSubscription>(config);
  async function cancel() {
    try { await command<WorkbenchCancelMutation>(environment, cancelMutation, { input: { taskId: data.id } }); }
    catch (error) { setStreamError(message(error)); }
  }
  return <article className="response"><div className="response-heading"><strong>SCCE</strong><span role="status">{data.status}</span>{!terminal && <button onClick={() => void cancel()}>Stop</button>}</div>
    <div className="answer" dir="auto">{data.result?.answer || data.latestFrame?.answer || (!terminal ? "Working…" : "")}</div>
    {(data.result?.error || data.latestFrame?.error) && <p role="alert">{data.result?.error || data.latestFrame?.error}</p>}
    {data.status === "interrupted" && <p>The host restarted before this task completed. Its recorded work is preserved; it will not execute again automatically.</p>}
    {streamError && <p role="alert">{streamError} <button onClick={() => { setStreamError(""); setRetry(value => value + 1); }}>Reconnect task</button></p>}
    <details><summary>Task activity · {data.latestSequence} events · {data.persistence}</summary><ol className="events">{data.frames.edges.map(edge => <li key={edge.node.id}><span>{edge.node.sequence}</span>{edge.node.phase || edge.node.kind}</li>)}</ol>{hasNext && <button disabled={isLoadingNext} onClick={() => loadNext(20)}>Load more activity</button>}</details>
  </article>;
}
function command<T extends MutationParameters>(environment: Environment, mutation: Parameters<typeof commitMutation<T>>[1]["mutation"], variables: T["variables"]): Promise<T["response"]> {
  return new Promise((resolve, reject) => commitMutation<T>(environment, { mutation, variables,
    onCompleted(data, errors) { if (errors?.length) reject(new Error(errors.map(error => error.message).join("; "))); else resolve(data); }, onError: reject }));
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
