export type WorkbenchPane = "explorer" | "search" | "proof" | "program" | "config" | "terminal" | "approvals";
export type WorkbenchEditorKind = "chat" | "proof" | "program" | "graph" | "event" | "config" | "benchmark" | "pca" | "self" | "action";

export interface WorkbenchTab {
  id: string;
  kind: WorkbenchEditorKind;
  title: string;
  dirty: boolean;
  pinned: boolean;
  payload: unknown;
}

export interface WorkbenchTreeItem {
  id: string;
  label: string;
  icon: string;
  kind: "file" | "folder" | "source" | "evidence" | "proof" | "construct" | "capability" | "event" | "config";
  children?: WorkbenchTreeItem[];
  meta?: Record<string, unknown>;
}

export interface WorkbenchTerminalLine {
  id: string;
  t: number;
  stream: "system" | "request" | "response" | "error";
  text: string;
}

export interface WorkbenchTraceEvent {
  id: string;
  t: number;
  typeId: string;
  summary: string;
  payload?: unknown;
}

export interface CommandPaletteEntry {
  id: string;
  label: string;
  detail: string;
  group: "runtime" | "database" | "graph" | "proof" | "program" | "tools" | "view";
  accelerator?: string;
}

export interface WorkbenchState {
  serverUrl: string;
  activePane: WorkbenchPane;
  activeTabId: string;
  tabs: WorkbenchTab[];
  tree: WorkbenchTreeItem[];
  evidence: WorkbenchTreeItem[];
  terminal: WorkbenchTerminalLine[];
  trace: WorkbenchTraceEvent[];
  inspector: unknown;
  commandPaletteOpen: boolean;
  commands: CommandPaletteEntry[];
  status: {
    ready: boolean;
    postgres: "unknown" | "ok" | "error";
    episodeId?: string;
    force?: string;
    requestInFlight: boolean;
  };
}

export type WorkbenchAction =
  | { type: "pane.select"; pane: WorkbenchPane }
  | { type: "tab.open"; tab: WorkbenchTab }
  | { type: "tab.close"; tabId: string }
  | { type: "tab.activate"; tabId: string }
  | { type: "terminal.append"; line: Omit<WorkbenchTerminalLine, "id" | "t"> }
  | { type: "trace.replace"; events: WorkbenchTraceEvent[] }
  | { type: "tree.replace"; tree: WorkbenchTreeItem[] }
  | { type: "evidence.replace"; evidence: WorkbenchTreeItem[] }
  | { type: "inspector.set"; value: unknown }
  | { type: "palette.toggle"; open?: boolean }
  | { type: "status.patch"; status: Partial<WorkbenchState["status"]> };

export const DEFAULT_COMMANDS: CommandPaletteEntry[] = [
  { id: "runtime.ready", label: "i18n:cmd.runtime.ready", detail: "GET /api/ready", group: "runtime", accelerator: "Ctrl+R" },
  { id: "db.verify", label: "i18n:cmd.db.verify", detail: "GET /api/db/verify", group: "database" },
  { id: "db.stats", label: "i18n:cmd.db.stats", detail: "GET /api/db/stats", group: "database" },
  { id: "tools.inspect", label: "i18n:cmd.tools.inspect", detail: "GET /api/tools", group: "tools" },
  { id: "session.approvals", label: "i18n:cmd.session.approvals", detail: "GET /api/session/approvals", group: "tools" },
  { id: "session.operator_grant", label: "i18n:cmd.session.operator_grant", detail: "POST /api/session/operator-grant", group: "tools" },
  { id: "connectors.quota", label: "i18n:cmd.connectors.quota", detail: "GET /api/connectors/quota", group: "tools" },
  { id: "kernel.ingest", label: "i18n:cmd.ingest.source", detail: "POST /api/ingest", group: "runtime" },
  { id: "kernel.codebase_ingest", label: "i18n:cmd.ingest.codebase", detail: "POST /api/codebase/ingest", group: "runtime" },
  { id: "workspace.init", label: "i18n:cmd.workspace.init", detail: "POST /api/workspace/init", group: "runtime" },
  { id: "workspace.ingest", label: "i18n:cmd.workspace.ingest", detail: "POST /api/workspace/ingest", group: "runtime" },
  { id: "workspace.ask", label: "i18n:cmd.workspace.ask", detail: "POST /api/workspace/ask", group: "runtime" },
  { id: "project.summary", label: "i18n:cmd.project.summary", detail: "GET /api/project/summary", group: "view" },
  { id: "project.map", label: "i18n:cmd.project.map", detail: "GET /api/project/map", group: "view" },
  { id: "project.symbols", label: "i18n:cmd.project.symbols", detail: "GET /api/project/symbols", group: "view" },
  { id: "project.gaps", label: "i18n:cmd.project.gaps", detail: "GET /api/project/gaps", group: "view" },
  { id: "project.contradictions", label: "i18n:cmd.project.contradictions", detail: "GET /api/project/contradictions", group: "proof" },
  { id: "project.tasks", label: "i18n:cmd.project.tasks", detail: "GET /api/project/tasks", group: "program" },
  { id: "report.brief", label: "i18n:cmd.report.brief", detail: "GET /api/reports/brief", group: "view" },
  { id: "report.patch_plan", label: "i18n:cmd.report.patch_plan", detail: "GET /api/reports/patch-plan", group: "program" },
  { id: "report.handoff", label: "i18n:cmd.report.handoff", detail: "GET /api/reports/handoff", group: "view" },
  { id: "report.review", label: "i18n:cmd.report.review", detail: "GET /api/reports/review", group: "proof" },
  { id: "kernel.train", label: "i18n:cmd.train.promote", detail: "POST /api/train", group: "runtime" },
  { id: "kernel.turn", label: "i18n:cmd.kernel.turn", detail: "POST /api/turn", group: "runtime", accelerator: "Ctrl+Enter" },
  { id: "inspect.snapshot", label: "i18n:cmd.inspect.snapshot", detail: "GET /api/inspect?target=snapshot", group: "view" },
  { id: "inspect.math_spine", label: "i18n:cmd.inspect.math_spine", detail: "GET /api/inspect?target=math-spine", group: "view" },
  { id: "inspect.graph", label: "i18n:cmd.inspect.graph", detail: "GET /api/inspect?target=graph", group: "graph" },
  { id: "inspect.ingestion", label: "i18n:cmd.inspect.ingestion", detail: "GET /api/inspect?target=ingestion", group: "view" },
  { id: "inspect.codebase", label: "i18n:cmd.inspect.codebase", detail: "GET /api/inspect?target=codebase", group: "view" },
  { id: "inspect.self", label: "i18n:cmd.inspect.self", detail: "GET /api/inspect?target=self", group: "view" },
  { id: "inspect.proofs", label: "i18n:cmd.inspect.proofs", detail: "GET /api/inspect?target=proofs", group: "proof" },
  { id: "benchmark.run", label: "Benchmark: Run Suite", detail: "POST /api/benchmark", group: "runtime" }
];

export function createInitialWorkbenchState(serverUrl: string): WorkbenchState {
  const chat: WorkbenchTab = { id: "tab.chat", kind: "chat", title: "chat.turn", dirty: false, pinned: true, payload: null };
  return {
    serverUrl,
    activePane: "explorer",
    activeTabId: chat.id,
    tabs: [
      chat,
      { id: "tab.proof", kind: "proof", title: "proof.graph", dirty: false, pinned: true, payload: null },
      { id: "tab.pca", kind: "pca", title: "pca.certificates", dirty: false, pinned: true, payload: null },
      { id: "tab.program", kind: "program", title: "program.graph", dirty: false, pinned: true, payload: null },
      { id: "tab.action", kind: "action", title: "action.graph", dirty: false, pinned: true, payload: null },
      { id: "tab.self", kind: "self", title: "self.state", dirty: false, pinned: true, payload: null }
    ],
    tree: defaultTree(),
    evidence: [{ id: "evidence.empty", label: "Run inspect to load graph/evidence.", icon: "E", kind: "evidence" }],
    terminal: [{ id: "term.init", t: 0, stream: "system", text: "$ SCCE workbench ready" }],
    trace: [],
    inspector: {},
    commandPaletteOpen: false,
    commands: DEFAULT_COMMANDS,
    status: { ready: false, postgres: "unknown", requestInFlight: false }
  };
}

export function reduceWorkbench(state: WorkbenchState, action: WorkbenchAction, now = Date.now()): WorkbenchState {
  switch (action.type) {
    case "pane.select":
      return { ...state, activePane: action.pane };
    case "tab.open": {
      const exists = state.tabs.some(tab => tab.id === action.tab.id);
      return { ...state, tabs: exists ? state.tabs.map(tab => tab.id === action.tab.id ? action.tab : tab) : [...state.tabs, action.tab], activeTabId: action.tab.id };
    }
    case "tab.close": {
      const tabs = state.tabs.filter(tab => tab.id !== action.tabId || tab.pinned);
      const activeTabId = tabs.some(tab => tab.id === state.activeTabId) ? state.activeTabId : tabs[0]?.id ?? "";
      return { ...state, tabs, activeTabId };
    }
    case "tab.activate":
      return state.tabs.some(tab => tab.id === action.tabId) ? { ...state, activeTabId: action.tabId } : state;
    case "terminal.append":
      return { ...state, terminal: [...state.terminal, { ...action.line, id: `term.${now}.${state.terminal.length}`, t: now }].slice(-400) };
    case "trace.replace":
      return { ...state, trace: action.events };
    case "tree.replace":
      return { ...state, tree: action.tree };
    case "evidence.replace":
      return { ...state, evidence: action.evidence };
    case "inspector.set":
      return { ...state, inspector: action.value };
    case "palette.toggle":
      return { ...state, commandPaletteOpen: action.open ?? !state.commandPaletteOpen };
    case "status.patch":
      return { ...state, status: { ...state.status, ...action.status } };
    default:
      return state;
  }
}

export function treeFromSnapshot(snapshot: unknown): WorkbenchTreeItem[] {
  const value = snapshot as { graph?: { nodes?: unknown[]; edges?: unknown[] }; memoryState?: Record<string, unknown> };
  const graph = value.graph ?? value;
  const nodes = Array.isArray((graph as { nodes?: unknown[] }).nodes) ? (graph as { nodes: unknown[] }).nodes : [];
  const edges = Array.isArray((graph as { edges?: unknown[] }).edges) ? (graph as { edges: unknown[] }).edges : [];
  return [
    { id: "snapshot.graph", label: `graph (${nodes.length} nodes, ${edges.length} edges)`, icon: "G", kind: "folder", children: nodes.slice(0, 80).map((node, index) => nodeItem(node, index)) },
    { id: "snapshot.meta", label: "runtime snapshot", icon: "S", kind: "config", meta: value.memoryState ?? {} }
  ];
}

export function traceFromEvents(events: unknown[]): WorkbenchTraceEvent[] {
  return events.map((event, index) => {
    const e = event as { id?: string; t?: number; typeId?: string; payload?: unknown };
    return {
      id: e.id ?? `event.${index}`,
      t: e.t ?? index,
      typeId: e.typeId ?? "Unknown",
      summary: summarizePayload(e.payload),
      payload: e.payload
    };
  });
}

export function evidenceTreeFromTurn(turn: unknown): WorkbenchTreeItem[] {
  const evidence = (turn as { evidence?: unknown[] }).evidence ?? [];
  const pca = (turn as { proofCarryingAnswer?: { supportedSentences?: number; totalSentences?: number; grounding?: string } }).proofCarryingAnswer;
  const functional = (turn as { functionalCognition?: { selectedGoal?: unknown; fcsPrime?: number; fc?: boolean } }).functionalCognition;
  const diagnostic: WorkbenchTreeItem[] = [
    ...(pca ? [{ id: "diag.pca", label: `PCA ${pca.supportedSentences ?? 0}/${pca.totalSentences ?? 0} ${pca.grounding ?? ""}`, icon: "P", kind: "proof" as const, meta: pca as Record<string, unknown> }] : []),
    ...(functional ? [{ id: "diag.functional", label: `FCS' ${(functional.fcsPrime ?? 0).toFixed(3)} FC=${Boolean(functional.fc)}`, icon: "F", kind: "event" as const, meta: functional as Record<string, unknown> }] : [])
  ];
  const evidenceItems: WorkbenchTreeItem[] = evidence.map((span, index) => {
    const s = span as { id?: string; textPreview?: string; alpha?: number; status?: string; sourceVersionId?: string };
    return {
      id: s.id ?? `evidence.${index}`,
      label: `${(s.alpha ?? 0).toFixed(3)} ${s.status ?? ""} ${s.textPreview ?? ""}`.trim(),
      icon: "E",
      kind: "evidence" as const,
      meta: { sourceVersionId: s.sourceVersionId, alpha: s.alpha, status: s.status }
    };
  });
  return [...diagnostic, ...evidenceItems];
}

function defaultTree(): WorkbenchTreeItem[] {
  return [
    { id: "root.config", label: "scce.config.json", icon: "C", kind: "file" },
    { id: "root.kernel", label: "packages/kernel", icon: "K", kind: "folder" },
    { id: "root.adapters", label: "packages/adapters-node", icon: "A", kind: "folder" },
    { id: "root.server", label: "packages/server", icon: "S", kind: "folder" },
    { id: "root.ui", label: "packages/ui", icon: "U", kind: "folder" }
  ];
}

function nodeItem(node: unknown, index: number): WorkbenchTreeItem {
  const n = node as { id?: string; metadata?: { type?: string }; alpha?: number };
  return { id: n.id ?? `node.${index}`, label: `${n.metadata?.type ?? "node"} ${(n.alpha ?? 0).toFixed(3)} ${n.id ?? index}`, icon: "N", kind: "event", meta: n as Record<string, unknown> };
}

function summarizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload.slice(0, 160);
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  try {
    return JSON.stringify(payload).slice(0, 220);
  } catch {
    return "[unserializable payload]";
  }
}
