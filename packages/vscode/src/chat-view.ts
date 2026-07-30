import * as vscode from "vscode";
import { ScceClient, ScceHttpError, type TurnAnswer, type TurnStreamFrame } from "./client.js";
import { turnDetail } from "./turn-detail.js";

export interface ChatSessionRecord {
  id: string;
  role: "owner" | "assistant" | "error";
  text: string;
  detail?: unknown;
  createdAt: number;
}

const SESSION_STATE_KEY = "scce.chat.sessionId.v1";
const HISTORY_STATE_KEY = "scce.chat.history.v1";
const MAX_HISTORY = 200;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "scce.chat";

  private view: vscode.WebviewView | undefined;
  private activeRequest: AbortController | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    private readonly clientFactory: () => Promise<ScceClient>,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });
    const history = this.memento.get<ChatSessionRecord[]>(HISTORY_STATE_KEY, []);
    void webviewView.webview.postMessage({ type: "history", records: history });
  }

  private sessionId(): string {
    let id = this.memento.get<string>(SESSION_STATE_KEY);
    if (!id) {
      id = `session.${cryptoRandomId()}`;
      void this.memento.update(SESSION_STATE_KEY, id);
    }
    return id;
  }

  private appendHistory(record: ChatSessionRecord): void {
    const history = this.memento.get<ChatSessionRecord[]>(HISTORY_STATE_KEY, []);
    history.push(record);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    void this.memento.update(HISTORY_STATE_KEY, history);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type === "clear") {
      void this.memento.update(HISTORY_STATE_KEY, []);
      return;
    }
    if (record.type === "cancel") {
      this.activeRequest?.abort();
      return;
    }
    if (record.type === "codingRequest") {
      // Deliberately routes to the existing, narrow compiler-diagnostic-
      // bounded coding-request command rather than attempting the change
      // itself from chat -- that command's file-scope and diagnostic-code
      // selection (real VS Code QuickPicks, not chat bubbles) is the actual
      // safety boundary. This just removes the need to open the command
      // palette and retype the request separately.
      void vscode.commands.executeCommand("scce.workspace.codingRequest", typeof record.text === "string" ? record.text : undefined);
      return;
    }
    if (record.type !== "send" || typeof record.text !== "string") return;
    const text = record.text.trim();
    if (!text) return;
    const webview = this.view?.webview;
    if (!webview) return;
    this.appendHistory({ id: cryptoRandomId(), role: "owner", text, createdAt: Date.now() });
    this.activeRequest?.abort();
    const controller = new AbortController();
    this.activeRequest = controller;
    try {
      const client = await this.clientFactory();
      let answer: TurnAnswer;
      try {
        answer = await client.streamTurn(
          { text, sessionId: this.sessionId() },
          (frame: TurnStreamFrame) => {
            if (frame.type !== "progress") return;
            // Only worth showing early if there's real content -- an empty
            // or non-lettered preview would flash a blank bubble before the
            // final "result" frame's answerSurface() fallback text replaces
            // it, which is more confusing than just staying on "Thinking".
            if (typeof frame.answer === "string" && /[\p{L}\p{N}]/u.test(frame.answer)) {
              // The kernel fires this once the turn's answer text is settled --
              // safe to show now instead of waiting for the whole turn (persistence,
              // learning-loop planning, event writes) to finish; the later "result"
              // frame still carries the authoritative sources/detail payload.
              void webview.postMessage({ type: "answerPreview", text: frame.answer, assistantForce: frame.assistantForce ?? null });
              return;
            }
            void webview.postMessage({ type: "progress", phase: frame.phase ?? "" });
          },
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) {
          void webview.postMessage({ type: "cancelled" });
          return;
        }
        throw error;
      }
      const spoken = answerSurface(answer);
      this.appendHistory({ id: cryptoRandomId(), role: "assistant", text: spoken, detail: turnDetail(answer), createdAt: Date.now() });
      void webview.postMessage({ type: "answer", text: spoken, detail: turnDetail(answer) });
    } catch (error) {
      const messageText = error instanceof ScceHttpError
        ? `SCCE request failed (${error.status}): ${error.message}`
        : error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[chat] ${messageText}`);
      this.appendHistory({ id: cryptoRandomId(), role: "error", text: messageText, createdAt: Date.now() });
      void webview.postMessage({ type: "error", text: messageText });
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = cryptoRandomId();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SCCE</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .messages { flex: 1; overflow-y: auto; padding: 10px 10px 4px; display: flex; flex-direction: column; gap: 10px; }
  .empty { margin: auto; text-align: center; color: var(--vscode-descriptionForeground); padding: 24px; line-height: 1.5; }
  .empty .hint { font-size: 0.9em; margin-top: 6px; }
  .row { display: flex; }
  .row.owner { justify-content: flex-end; }
  .row.assistant, .row.error { justify-content: flex-start; }
  .bubble {
    max-width: 88%;
    padding: 8px 11px;
    border-radius: 8px;
    line-height: 1.48;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .row.owner .bubble {
    background: var(--vscode-button-background, #2f6f7a);
    color: var(--vscode-button-foreground, #fff);
    border-bottom-right-radius: 2px;
  }
  .row.assistant .bubble {
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-bottom-left-radius: 2px;
  }
  .row.error .bubble {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
  }
  .row.streaming .bubble { opacity: 0.82; }
  .bubble p { margin: 0 0 8px; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble pre {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
    padding: 8px 10px;
    border-radius: 5px;
    overflow-x: auto;
    margin: 6px 0;
  }
  .bubble code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.95em;
  }
  .bubble :not(pre) > code {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
    padding: 1px 4px;
    border-radius: 3px;
  }
  .bubble ul, .bubble ol { margin: 4px 0; padding-left: 20px; }
  .bubble strong { font-weight: 600; }
  .details { margin-top: 6px; }
  .details summary { cursor: pointer; font-size: 0.85em; color: var(--vscode-descriptionForeground); user-select: none; }
  .details pre {
    font-size: 0.85em;
    max-height: 220px;
    overflow: auto;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
    padding: 8px;
    border-radius: 5px;
    margin-top: 4px;
  }
  .sources { margin-top: 6px; font-size: 0.85em; }
  .sources .sources-label { color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .sources ol { margin: 0; padding-left: 18px; }
  .sources li { margin-bottom: 2px; }
  .sources .source-title { font-weight: 600; }
  .sources .source-preview { color: var(--vscode-descriptionForeground); }
  .typing { display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 0.9em; padding: 0 2px; }
  .typing .dots span { animation: blink 1.2s infinite; opacity: 0.2; }
  .typing .dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing .dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  textarea {
    flex: 1;
    resize: none;
    min-height: 32px;
    max-height: 160px;
    padding: 7px 9px;
    border-radius: 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: inherit;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button {
    border: 0;
    border-radius: 6px;
    height: 32px;
    padding: 0 12px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-family: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
  button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, transparent)); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground, transparent)); }
  .toolbar { display: flex; justify-content: flex-end; padding: 4px 8px 0; }
  .toolbar button { background: transparent; color: var(--vscode-descriptionForeground); height: 24px; padding: 0 8px; font-size: 0.85em; }
  .toolbar button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
</style>
</head>
<body>
  <div class="toolbar"><button id="clear">Clear conversation</button></div>
  <div class="messages" id="messages"><div class="empty" id="empty">Ask SCCE anything about this workspace.<div class="hint">It can explain code, plan and apply changes, and answer questions grounded in what it has actually read.</div></div></div>
  <div class="composer">
    <textarea id="input" rows="1" placeholder="Message SCCE&hellip;"></textarea>
    <button id="plan-code" class="secondary" title="Plan a bounded coding request from this text (file scope and diagnostic selection happen in VS Code dialogs, not here)">Plan code change</button>
    <button id="send">Send</button>
  </div>
<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const emptyEl = document.getElementById('empty');
  const inputEl = document.getElementById('input');
  const sendButton = document.getElementById('send');
  const planCodeButton = document.getElementById('plan-code');
  const clearButton = document.getElementById('clear');
  let sending = false;
  let typingRow = null;
  let streamingRow = null;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderMarkdownLite(text) {
    const source = String(text || '');
    const blocks = source.split(/\\n{2,}/);
    return blocks.map(block => {
      const fence = /^\`\`\`([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)\\n?\`\`\`$/.exec(block.trim());
      if (fence) return '<pre><code>' + escapeHtml(fence[2]) + '</code></pre>';
      let html = escapeHtml(block);
      html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/(^|\\s)\\*([^*\\n]+)\\*(?=\\s|$)/g, '$1<em>$2</em>');
      html = html.replace(/\\n/g, '<br>');
      if (/^\\s*[-*]\\s+/m.test(block) && !/<br>/.test(html.slice(0, 2))) {
        const items = block.split(/\\n/).filter(line => /^\\s*[-*]\\s+/.test(line));
        if (items.length === block.split(/\\n/).filter(Boolean).length) {
          return '<ul>' + items.map(line => '<li>' + escapeHtml(line.replace(/^\\s*[-*]\\s+/, '')) + '</li>').join('') + '</ul>';
        }
      }
      return '<p>' + html + '</p>';
    }).join('');
  }

  function addMessage(role, text, detail, existingRow) {
    emptyEl.style.display = 'none';
    const row = existingRow || document.createElement('div');
    row.className = 'row ' + role;
    row.innerHTML = '';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMarkdownLite(text);
    row.appendChild(bubble);
    if (role === 'assistant' && detail && Array.isArray(detail.sources) && detail.sources.length) {
      const sources = document.createElement('div');
      sources.className = 'sources';
      const label = document.createElement('div');
      label.className = 'sources-label';
      label.textContent = 'Sources';
      sources.appendChild(label);
      const list = document.createElement('ol');
      for (const source of detail.sources) {
        const item = document.createElement('li');
        const title = document.createElement('span');
        title.className = 'source-title';
        title.textContent = source.title || 'source';
        item.appendChild(title);
        if (source.preview) {
          const preview = document.createElement('div');
          preview.className = 'source-preview';
          preview.textContent = source.preview;
          item.appendChild(preview);
        }
        list.appendChild(item);
      }
      sources.appendChild(list);
      bubble.appendChild(sources);
    }
    if (detail) {
      const details = document.createElement('details');
      details.className = 'details';
      const summary = document.createElement('summary');
      summary.textContent = 'Details';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(detail, null, 2);
      details.appendChild(summary);
      details.appendChild(pre);
      bubble.appendChild(details);
    }
    if (!row.isConnected) messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return row;
  }

  function beginStreamingAnswer(text) {
    hideTyping();
    streamingRow = addMessage('assistant streaming', text, undefined);
    return streamingRow;
  }

  function showTyping(phase) {
    if (!typingRow) {
      typingRow = document.createElement('div');
      typingRow.className = 'row assistant';
      typingRow.innerHTML = '<div class="bubble"><div class="typing"><span id="typing-phase"></span><span class="dots"><span>&bull;</span><span>&bull;</span><span>&bull;</span></span></div></div>';
      messagesEl.appendChild(typingRow);
    }
    typingRow.querySelector('#typing-phase').textContent = phase ? phaseLabel(phase) : 'Thinking';
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function phaseLabel(phase) {
    const label = String(phase).split('.').pop() || phase;
    return label.charAt(0).toUpperCase() + label.slice(1).replace(/_/g, ' ');
  }

  function hideTyping() {
    if (typingRow) { typingRow.remove(); typingRow = null; }
  }

  function setSending(next) {
    sending = next;
    sendButton.textContent = sending ? 'Stop' : 'Send';
    sendButton.classList.toggle('stop', sending);
    inputEl.disabled = sending;
  }

  function send() {
    if (sending) { vscodeApi.postMessage({ type: 'cancel' }); return; }
    const text = inputEl.value.trim();
    if (!text) return;
    addMessage('owner', text);
    inputEl.value = '';
    autoGrow();
    setSending(true);
    showTyping('');
    vscodeApi.postMessage({ type: 'send', text });
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(160, inputEl.scrollHeight) + 'px';
  }

  sendButton.addEventListener('click', send);
  planCodeButton.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'codingRequest', text: inputEl.value.trim() });
  });
  clearButton.addEventListener('click', () => {
    messagesEl.querySelectorAll('.row').forEach(row => row.remove());
    emptyEl.style.display = '';
    vscodeApi.postMessage({ type: 'clear' });
  });
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'history') {
      for (const record of message.records || []) addMessage(record.role, record.text, record.detail);
      return;
    }
    if (message.type === 'progress') { showTyping(message.phase); return; }
    if (message.type === 'answerPreview') { beginStreamingAnswer(message.text); return; }
    if (message.type === 'answer') {
      hideTyping();
      setSending(false);
      addMessage('assistant', message.text, message.detail, streamingRow);
      streamingRow = null;
      return;
    }
    if (message.type === 'error') {
      hideTyping();
      setSending(false);
      if (streamingRow) { streamingRow.remove(); streamingRow = null; }
      addMessage('error', message.text);
      return;
    }
    if (message.type === 'cancelled') {
      hideTyping();
      setSending(false);
      if (streamingRow) { streamingRow.remove(); streamingRow = null; }
      return;
    }
  });

  inputEl.focus();
}());
</script>
</body>
</html>`;
  }
}

function answerSurface(answer: TurnAnswer): string {
  const text = answer?.answer;
  if (typeof text === "string" && /[\p{L}\p{N}]/u.test(text)) return text;
  const errorLike = (answer as { error?: unknown; runtimeError?: unknown; message?: unknown } | undefined);
  const error = errorLike?.error ?? errorLike?.runtimeError ?? errorLike?.message;
  return error ? `Runtime failure: ${String(error)}` : "SCCE returned no answer for this turn.";
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
