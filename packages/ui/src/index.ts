export * from "./workbench-model.js";
export * from "./developer-surface.js";
export * from "./locales.js";

import { uiMessageScript, uiText } from "./locales.js";

export function renderWorkbench(serverUrl: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(uiText("app.lang"))}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(uiText("app.title"))}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#1a1b1e; --panel:#212226; --panel2:#26272c; --line:#34363c; --text:#e8eaef; --muted:#8b8f98;
      --accent:#5fb3c7; --accent-strong:#4a97aa; --ok:#7ddc8b; --warn:#e7c664; --bad:#ff6b6b; --bubble-owner:#2f6f7a;
    }
    * { box-sizing:border-box; }
    body { margin:0; font:14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--text); height:100vh; overflow:hidden; }
    .app { display:flex; flex-direction:column; height:100vh; }
    .topbar { height:44px; flex:none; display:flex; align-items:center; gap:12px; padding:0 14px; border-bottom:1px solid var(--line); background:var(--panel); }
    .topbar .brand { display:flex; align-items:center; gap:8px; font-weight:600; }
    .topbar .brand .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 3px rgba(125,220,139,0.15); }
    .topbar .origin { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .topbar .spacer { flex:1; }
    .badge {
      display:none; align-items:center; gap:6px; background:#3d2e17; color:var(--warn); border:1px solid #5a4520;
      border-radius:999px; padding:3px 10px; font-size:12px; cursor:pointer;
    }
    .badge.show { display:inline-flex; }
    .iconbtn {
      width:30px; height:30px; border-radius:6px; background:transparent; border:1px solid transparent; color:var(--muted);
      display:grid; place-items:center; cursor:pointer; font-size:15px;
    }
    .iconbtn:hover { background:var(--panel2); color:var(--text); border-color:var(--line); }
    .iconbtn.active { background:var(--panel2); color:var(--accent); border-color:var(--line); }
    .body { flex:1; display:flex; min-height:0; position:relative; }
    .chat-column { flex:1; display:flex; flex-direction:column; min-width:0; }
    .messages { flex:1; overflow-y:auto; padding:20px 0; }
    .messages-inner { max-width:760px; margin:0 auto; padding:0 20px; display:flex; flex-direction:column; gap:14px; }
    .empty-state { margin:auto; max-width:420px; text-align:center; color:var(--muted); padding:40px 20px; }
    .empty-state h2 { color:var(--text); font-size:17px; font-weight:600; margin:0 0 8px; }
    .empty-state p { margin:0; line-height:1.5; }
    .row { display:flex; }
    .row.owner { justify-content:flex-end; }
    .row.scce, .row.error { justify-content:flex-start; }
    .bubble { max-width:86%; padding:10px 14px; border-radius:12px; overflow-wrap:anywhere; }
    .row.owner .bubble { background:var(--bubble-owner); color:#fff; border-bottom-right-radius:3px; }
    .row.scce .bubble { background:var(--panel2); border:1px solid var(--line); border-bottom-left-radius:3px; }
    .row.error .bubble { background:#3a1e1e; border:1px solid #5a2b2b; color:#ffb4b4; }
    .bubble p { margin:0 0 8px; }
    .bubble p:last-child { margin-bottom:0; }
    .bubble pre { background:rgba(0,0,0,0.28); padding:9px 11px; border-radius:6px; overflow-x:auto; margin:6px 0; }
    .bubble code { font:12.5px/1.4 Consolas, "SF Mono", monospace; }
    .bubble :not(pre) > code { background:rgba(0,0,0,0.28); padding:1px 5px; border-radius:4px; }
    .bubble ul, .bubble ol { margin:4px 0; padding-left:20px; }
    .bubble strong { font-weight:600; }
    .feedback { display:flex; gap:6px; margin:-6px 0 0 2px; }
    .feedback button { min-width:30px; width:30px; height:26px; padding:0; border-radius:5px; background:var(--panel2); border:1px solid var(--line); color:var(--muted); }
    .feedback button:hover { color:var(--text); }
    .feedback button.accept:hover { background:#204a30; border-color:#2f6f46; color:#bdf2c6; }
    .feedback button.reject:hover { background:#4a2024; border-color:#7a2f35; color:#f2bdc0; }
    .details { margin-top:8px; }
    .details summary { cursor:pointer; font-size:12px; color:var(--muted); user-select:none; }
    .details summary:hover { color:var(--text); }
    .details pre { font-size:12px; max-height:220px; overflow:auto; background:rgba(0,0,0,0.28); padding:8px; border-radius:5px; margin-top:6px; }
    .typing { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:13px; }
    .typing .dots span { animation:blink 1.2s infinite; opacity:0.2; }
    .typing .dots span:nth-child(2) { animation-delay:0.2s; }
    .typing .dots span:nth-child(3) { animation-delay:0.4s; }
    @keyframes blink { 0%, 80%, 100% { opacity:0.2; } 40% { opacity:1; } }
    .composer-wrap { flex:none; padding:12px 20px 18px; }
    .composer { max-width:760px; margin:0 auto; display:flex; align-items:flex-end; gap:8px; background:var(--panel2); border:1px solid var(--line); border-radius:12px; padding:8px; }
    .composer:focus-within { border-color:var(--accent); }
    textarea { flex:1; resize:none; min-height:24px; max-height:200px; background:transparent; color:var(--text); border:0; padding:6px 8px; font:14px/1.4 inherit; outline:0; }
    .composer button { min-width:76px; height:34px; border:0; border-radius:8px; background:var(--accent-strong); color:#fff; font-weight:600; cursor:pointer; }
    .composer button:hover { background:var(--accent); }
    .composer button.stop { background:#7a2f35; }
    .devpanel {
      flex:none; width:0; overflow:hidden; border-left:1px solid var(--line); background:var(--panel);
      display:flex; flex-direction:column; transition:width 0.15s ease;
    }
    .devpanel.open { width:380px; }
    .devpanel-header { height:44px; flex:none; display:flex; align-items:center; justify-content:space-between; padding:0 12px; border-bottom:1px solid var(--line); }
    .devpanel-header strong { font-size:13px; }
    .devpanel-body { flex:1; overflow-y:auto; }
    .dev-section h3 {
      font-size:11px; letter-spacing:0.03em; text-transform:uppercase; margin:0; padding:10px 12px;
      color:var(--muted); border-bottom:1px solid var(--line); border-top:1px solid var(--line);
      display:flex; align-items:center; justify-content:space-between;
    }
    .dev-section h3 button { background:transparent; border:0; color:var(--muted); cursor:pointer; font-size:11px; }
    .dev-section h3 button:hover { color:var(--text); }
    .tree { padding:6px 0; }
    .tree div { padding:4px 12px 4px 20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:12.5px; color:var(--muted); }
    .tree div:hover { background:var(--panel2); color:var(--text); }
    .approval-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; }
    .toggle { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; white-space:nowrap; }
    .toggle input { accent-color:var(--bad); }
    .approval-item { margin:6px 10px; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--panel2); }
    .approval-item strong { display:block; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .approval-item code { display:block; color:var(--muted); font:11px Consolas, monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; }
    .approval-item button { margin-top:7px; min-width:0; height:26px; padding:0 10px; border-radius:5px; background:#7a4f2f; border:0; color:#fff; cursor:pointer; }
    .small-btn { background:var(--panel2); border:1px solid var(--line); color:var(--muted); border-radius:5px; height:24px; padding:0 9px; font-size:11px; cursor:pointer; }
    .small-btn:hover { color:var(--text); }
    .json, .flow { padding:10px 12px; font:11.5px/1.5 Consolas, monospace; color:#d7dae0; white-space:pre-wrap; overflow-wrap:anywhere; max-height:260px; overflow:auto; }
    .flow { color:#c3e88d; }
    .statusbar { flex:none; height:22px; background:#0e639c; display:flex; align-items:center; gap:16px; padding:0 12px; font-size:11px; color:#fff; overflow:hidden; }
    .statusbar .pill { opacity:0.95; white-space:nowrap; }
    .palette { position:fixed; inset:60px auto auto 50%; transform:translateX(-50%); width:min(680px, calc(100vw - 28px)); background:var(--panel2); border:1px solid var(--line); box-shadow:0 18px 48px rgba(0,0,0,.42); border-radius:8px; display:none; z-index:20; }
    .palette.open { display:block; }
    .palette input { width:100%; height:42px; background:var(--panel); color:var(--text); border:0; border-bottom:1px solid var(--line); border-radius:8px 8px 0 0; padding:0 12px; font:13px inherit; outline:0; }
    .palette-list { max-height:340px; overflow:auto; padding:6px 0; }
    .cmd { display:grid; grid-template-columns:1fr auto; gap:10px; padding:8px 12px; cursor:pointer; }
    .cmd:hover, .cmd.active { background:var(--panel); }
    .cmd strong { font-weight:600; font-size:13px; }
    .cmd span { color:var(--muted); font-size:11.5px; }
    @media (max-width: 760px) {
      .devpanel.open { position:fixed; inset:44px 0 0 0; width:auto; z-index:15; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <div class="brand"><span class="dot"></span><span>${escapeHtml(uiText("app.title"))}</span></div>
      <div class="origin">${escapeHtml(serverUrl)}</div>
      <div class="spacer"></div>
      <div class="badge" id="approvals-badge"></div>
      <button class="iconbtn" id="dev-toggle" title="${escapeHtml(uiText("app.developer_panel"))}" aria-label="${escapeHtml(uiText("app.developer_panel"))}">&#9881;</button>
    </div>
    <div class="body">
      <div class="chat-column">
        <div class="messages" id="messages">
          <div class="messages-inner" id="messages-inner">
            <div class="empty-state" id="empty-state">
              <h2>${escapeHtml(uiText("chat.empty.title"))}</h2>
              <p>${escapeHtml(uiText("chat.empty.hint"))}</p>
            </div>
          </div>
        </div>
        <div class="composer-wrap">
          <div class="composer">
            <textarea id="prompt" rows="1" placeholder="${escapeHtml(uiText("composer.placeholder"))}">${escapeHtml(uiText("prompt.default"))}</textarea>
            <button id="send">${escapeHtml(uiText("button.send"))}</button>
          </div>
        </div>
      </div>
      <aside class="devpanel" id="devpanel">
        <div class="devpanel-header">
          <strong>${escapeHtml(uiText("app.developer_panel"))}</strong>
          <button class="iconbtn" id="dev-close" aria-label="${escapeHtml(uiText("app.developer_panel.close"))}">&times;</button>
        </div>
        <div class="devpanel-body">
          <div class="dev-section">
            <h3>${escapeHtml(uiText("side.explorer"))}</h3>
            <div class="tree">
              <div>scce.config.json</div><div>packages/kernel</div><div>packages/adapters-node</div><div>packages/server</div><div>packages/ui</div>
            </div>
          </div>
          <div class="dev-section">
            <h3>${escapeHtml(uiText("side.evidence"))}</h3>
            <div class="tree" id="evidence-tree"><div>${escapeHtml(uiText("side.evidence.empty"))}</div></div>
          </div>
          <div class="dev-section">
            <h3>${escapeHtml(uiText("side.approvals"))}<button id="refresh-approvals">${escapeHtml(uiText("side.approvals.refresh"))}</button></h3>
            <div class="approval-head"><label class="toggle"><input type="checkbox" id="operator-grant-toggle" /> ${escapeHtml(uiText("side.approvals.operator_grant"))}</label></div>
            <div id="approval-list" class="tree"><div>${escapeHtml(uiText("side.approvals.none"))}</div></div>
          </div>
          <div class="dev-section">
            <h3>${escapeHtml(uiText("pane.inspector"))}<button class="small-btn" id="inspect">${escapeHtml(uiText("button.inspect"))}</button></h3>
            <pre class="json" id="inspect-json">{}</pre>
          </div>
          <div class="dev-section">
            <h3>${escapeHtml(uiText("app.developer_panel.terminal"))}</h3>
            <pre class="json" id="terminal">${escapeHtml(uiText("terminal.ready"))}</pre>
          </div>
          <div class="dev-section">
            <h3>${escapeHtml(uiText("app.developer_panel.trace"))}</h3>
            <pre class="flow" id="trace"></pre>
          </div>
        </div>
      </aside>
    </div>
    <div class="statusbar">
      <span class="pill">${escapeHtml(uiText("status.product"))}</span>
      <span class="pill">${escapeHtml(uiText("status.postgres"))}</span>
      <span class="pill">${escapeHtml(uiText("status.math"))}</span>
    </div>
  </div>
  <div class="palette" id="palette"><input id="palette-input" aria-label="${escapeHtml(uiText("palette.aria"))}" /><div class="palette-list" id="palette-list"></div></div>
  <script>
    const I18N = ${uiMessageScript()};
    const t = key => I18N[key] || key;
    const messages = document.getElementById('messages');
    const messagesInner = document.getElementById('messages-inner');
    const emptyState = document.getElementById('empty-state');
    const terminal = document.getElementById('terminal');
    const trace = document.getElementById('trace');
    const inspector = document.getElementById('inspect-json');
    const prompt = document.getElementById('prompt');
    const sendButton = document.getElementById('send');
    const devpanel = document.getElementById('devpanel');
    const devToggle = document.getElementById('dev-toggle');
    const approvalsBadge = document.getElementById('approvals-badge');
    const palette = document.getElementById('palette');
    const paletteInput = document.getElementById('palette-input');
    const paletteList = document.getElementById('palette-list');
    const sessionId = localStorage.getItem('scce.sessionId') || ('session.' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem('scce.sessionId', sessionId);
    let typingRow = null;
    let sending = false;

    function toggleDevPanel(open) {
      devpanel.classList.toggle('open', open);
      devToggle.classList.toggle('active', open);
    }
    devToggle.addEventListener('click', () => toggleDevPanel(!devpanel.classList.contains('open')));
    document.getElementById('dev-close').addEventListener('click', () => toggleDevPanel(false));
    approvalsBadge.addEventListener('click', () => toggleDevPanel(true));

    function escapeHtml(value) {
      return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderMarkdownLite(text) {
      const source = String(text || '');
      const blocks = source.split(/\\n{2,}/);
      return blocks.map(block => {
        const fence = /^\`\`\`([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)\\n?\`\`\`$/.exec(block.trim());
        if (fence) return '<pre><code>' + escapeHtml(fence[2]) + '</code></pre>';
        const lines = block.split(/\\n/).filter(Boolean);
        if (lines.length && lines.every(line => /^\\s*[-*]\\s+/.test(line))) {
          return '<ul>' + lines.map(line => '<li>' + inline(line.replace(/^\\s*[-*]\\s+/, '')) + '</li>').join('') + '</ul>';
        }
        return '<p>' + inline(block).replace(/\\n/g, '<br>') + '</p>';
      }).join('');
    }
    function inline(text) {
      let html = escapeHtml(text);
      html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/(^|\\s)\\*([^*\\n]+)\\*(?=\\s|$)/g, '$1<em>$2</em>');
      return html;
    }

    function add(role, text, detail) {
      emptyState.style.display = 'none';
      const row = document.createElement('div');
      row.className = 'row ' + role;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (role === 'owner') bubble.textContent = String(text || '');
      else bubble.innerHTML = renderMarkdownLite(text);
      row.appendChild(bubble);
      if (detail) {
        const details = document.createElement('details');
        details.className = 'details';
        const summary = document.createElement('summary');
        summary.textContent = t('chat.details');
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(detail, null, 2);
        details.appendChild(summary);
        details.appendChild(pre);
        bubble.appendChild(details);
      }
      messagesInner.appendChild(row);
      messages.scrollTop = messages.scrollHeight;
      return row;
    }
    function showTyping(phase) {
      if (!typingRow) {
        typingRow = document.createElement('div');
        typingRow.className = 'row scce';
        typingRow.innerHTML = '<div class="bubble"><div class="typing"><span id="typing-phase"></span><span class="dots"><span>&bull;</span><span>&bull;</span><span>&bull;</span></span></div></div>';
        messagesInner.appendChild(typingRow);
      }
      typingRow.querySelector('#typing-phase').textContent = phase ? phaseLabel(phase) : t('chat.working');
      messages.scrollTop = messages.scrollHeight;
    }
    function phaseLabel(phase) {
      const label = String(phase).split('.').pop() || phase;
      return label.charAt(0).toUpperCase() + label.slice(1).replace(/_/g, ' ');
    }
    function hideTyping() { if (typingRow) { typingRow.remove(); typingRow = null; } }
    function setSending(next) {
      sending = next;
      sendButton.textContent = sending ? t('button.stop') : t('button.send');
      sendButton.classList.toggle('stop', sending);
    }

    function turnSurface(r) {
      if (r && typeof r.answer === 'string' && answerHasSpeech(r.answer)) return r.answer;
      const err = r && (r.error?.message || r.error || r.runtimeError || r.message);
      return err ? 'Runtime failure: ' + String(err) : 'Runtime failure: /api/turn returned no answer.';
    }
    function answerHasSpeech(text) { return /[\\p{L}\\p{N}]/u.test(String(text || '')); }
    function turnDetail(r) {
      return { dialogue: r.dialogue || null, proof: r.entailment?.proof || null, actionGraph: r.actionGraph || null };
    }
    function addFeedbackControls(dialogue, promptText) {
      if (!dialogue || !dialogue.conversationId) return;
      const row = document.createElement('div');
      row.className = 'feedback';
      const sendOutcome = async (status, correctionText) => {
        log('POST /api/turn/outcome ' + status);
        const body = { status, conversationId: dialogue.conversationId, turnId: dialogue.turnId, promptText };
        if (correctionText) body.correctionText = correctionText;
        const r = await post('/api/turn/outcome', body);
        inspector.textContent = JSON.stringify({ dialogue, outcome: r }, null, 2);
        row.remove();
      };
      const accept = document.createElement('button'); accept.className = 'accept'; accept.title = 'Accept'; accept.textContent = '\\u2713'; accept.onclick = () => sendOutcome('accepted');
      const reject = document.createElement('button'); reject.className = 'reject'; reject.title = 'Reject'; reject.textContent = '\\u2717'; reject.onclick = () => sendOutcome('rejected');
      const correct = document.createElement('button'); correct.title = 'Correct'; correct.textContent = '\\u270e'; correct.onclick = () => { const text = window.prompt('Correction'); if (text && text.trim()) sendOutcome('corrected', text.trim()); };
      row.appendChild(accept); row.appendChild(reject); row.appendChild(correct);
      messagesInner.appendChild(row);
      messages.scrollTop = messages.scrollHeight;
    }
    function log(text) { terminal.textContent += "\\n$ " + text; terminal.scrollTop = terminal.scrollHeight; }
    async function postTurnStream(url, body, onFrame) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
      return continueTurnStream(response, { reconnectUrl: '', latestSequence: 0, promptText: String(body.text || '') }, onFrame);
    }
    async function continueTurnStream(response, state, onFrame) {
      let result;
      while (!result) {
        let terminalFailure = false;
        if (!response.ok) { const text = await response.text(); throw new Error(text || ('HTTP ' + response.status)); }
        if (!response.body) throw new Error('streaming response body unavailable');
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
        try {
          while (true) {
            const next = await reader.read(); pending += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
            const lines = pending.split('\\n'); pending = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const frame = JSON.parse(line); onFrame(frame);
              if (frame.streamUrl) state.reconnectUrl = String(frame.streamUrl);
              if (Number.isFinite(Number(frame.sequence))) state.latestSequence = Math.max(state.latestSequence, Number(frame.sequence));
              if (frame.taskId) state.taskId = String(frame.taskId);
              if (state.reconnectUrl) localStorage.setItem('scce.activeTurnTask', JSON.stringify(state));
              if (frame.type === 'result') result = frame.value;
              if (frame.type === 'error' || frame.type === 'cancelled') { terminalFailure = true; throw new Error(frame.error || JSON.stringify(frame.value) || 'streaming turn failed'); }
            }
            if (next.done) break;
          }
          if (pending.trim()) {
            const frame = JSON.parse(pending); onFrame(frame);
            if (frame.streamUrl) state.reconnectUrl = String(frame.streamUrl);
            if (Number.isFinite(Number(frame.sequence))) state.latestSequence = Math.max(state.latestSequence, Number(frame.sequence));
            if (frame.taskId) state.taskId = String(frame.taskId);
            if (frame.type === 'result') result = frame.value;
            if (frame.type === 'error' || frame.type === 'cancelled') { terminalFailure = true; throw new Error(frame.error || JSON.stringify(frame.value) || 'streaming turn failed'); }
          }
        } catch (error) {
          if (terminalFailure || !state.reconnectUrl) throw error;
        }
        if (result) break;
        if (!state.reconnectUrl) throw new Error('streaming turn ended without a reconnectable task receipt');
        await new Promise(resolve => setTimeout(resolve, 500));
        response = await fetch(state.reconnectUrl + '?after=' + state.latestSequence, { headers: { accept: 'application/x-ndjson' } });
      }
      localStorage.removeItem('scce.activeTurnTask');
      return result;
    }
    async function resumeStoredTurn() {
      const raw = localStorage.getItem('scce.activeTurnTask'); if (!raw) return;
      let state; try { state = JSON.parse(raw); } catch { localStorage.removeItem('scce.activeTurnTask'); return; }
      if (!state || !state.reconnectUrl) { localStorage.removeItem('scce.activeTurnTask'); return; }
      setSending(true);
      showTyping('');
      try {
        const stream = await fetch(state.reconnectUrl + '?after=' + Number(state.latestSequence || 0), { headers: { accept: 'application/x-ndjson' } });
        const result = await continueTurnStream(stream, state, frame => { if (frame.type === 'progress') showTyping(frame.phase); });
        hideTyping(); setSending(false);
        add('scce', turnSurface(result), turnDetail(result));
        addFeedbackControls(result.dialogue, String(state.promptText || ''));
        inspector.textContent = JSON.stringify({ dialogue: result.dialogue, proof: result.entailment?.proof, actionGraph: result.actionGraph }, null, 2);
      } catch (error) {
        hideTyping(); setSending(false);
        add('error', t('error.prefix') + ' ' + error.message);
      }
    }
    async function post(url, body) { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); const j = t ? JSON.parse(t) : null; if (!r.ok) throw new Error(JSON.stringify(j)); return j; }
    async function get(url) { const r = await fetch(url); const t = await r.text(); const j = t ? JSON.parse(t) : null; if (!r.ok) throw new Error(JSON.stringify(j)); return j; }
    async function refreshApprovals() { const r = await get('/api/session/approvals'); renderApprovals(r); return r; }
    function renderApprovals(state) {
      document.getElementById('operator-grant-toggle').checked = Boolean(state.operatorGrant);
      const list = document.getElementById('approval-list');
      list.innerHTML = '';
      const pending = state.pending || [];
      approvalsBadge.classList.toggle('show', pending.length > 0);
      approvalsBadge.textContent = pending.length > 0 ? t('status.pending_approvals').replace('{count}', pending.length) : '';
      if (!pending.length) { const d = document.createElement('div'); d.textContent = state.operatorGrant ? t('side.approvals.operator_grant_enabled') : t('side.approvals.none'); list.appendChild(d); return; }
      pending.forEach(item => {
        const box = document.createElement('div'); box.className = 'approval-item';
        const title = document.createElement('strong'); title.textContent = item.capabilityId; box.appendChild(title);
        const code = document.createElement('code'); code.textContent = item.planId; box.appendChild(code);
        const reason = document.createElement('code'); reason.textContent = item.reason || t('approval.required'); box.appendChild(reason);
        const button = document.createElement('button'); button.textContent = t('side.approvals.approve'); button.onclick = async () => { log('POST /api/session/approve ' + item.planId); const r = await post('/api/session/approve', { planId: item.planId }); inspector.textContent = JSON.stringify(r, null, 2); renderApprovals(r.session); };
        box.appendChild(button); list.appendChild(box);
      });
    }
    function openPalette() { palette.classList.add('open'); paletteInput.value = ''; renderPalette(''); paletteInput.focus(); }
    function closePalette() { palette.classList.remove('open'); }
    const commands = [
      ['runtime.ready', t('cmd.runtime.ready'), 'GET /api/ready'],
      ['db.verify', t('cmd.db.verify'), 'GET /api/db/verify'],
      ['db.stats', t('cmd.db.stats'), 'GET /api/db/stats'],
      ['tools.inspect', t('cmd.tools.inspect'), 'GET /api/tools'],
      ['session.approvals', t('cmd.session.approvals'), 'GET /api/session/approvals'],
      ['session.operator_grant', t('cmd.session.operator_grant'), 'POST /api/session/operator-grant'],
      ['connectors.quota', t('cmd.connectors.quota'), 'GET /api/connectors/quota'],
      ['kernel.codebase_ingest', t('cmd.ingest.codebase'), 'POST /api/codebase/ingest'],
      ['workspace.init', t('cmd.workspace.init'), 'POST /api/workspace/init'],
      ['workspace.ingest', t('cmd.workspace.ingest'), 'POST /api/workspace/ingest'],
      ['workspace.ask', t('cmd.workspace.ask'), 'POST /api/workspace/ask'],
      ['project.summary', t('cmd.project.summary'), 'GET /api/project/summary'],
      ['project.map', t('cmd.project.map'), 'GET /api/project/map'],
      ['project.symbols', t('cmd.project.symbols'), 'GET /api/project/symbols'],
      ['project.gaps', t('cmd.project.gaps'), 'GET /api/project/gaps'],
      ['project.contradictions', t('cmd.project.contradictions'), 'GET /api/project/contradictions'],
      ['project.tasks', t('cmd.project.tasks'), 'GET /api/project/tasks'],
      ['report.brief', t('cmd.report.brief'), 'GET /api/reports/brief'],
      ['report.patch_plan', t('cmd.report.patch_plan'), 'GET /api/reports/patch-plan'],
      ['report.handoff', t('cmd.report.handoff'), 'GET /api/reports/handoff'],
      ['report.review', t('cmd.report.review'), 'GET /api/reports/review'],
      ['inspect.snapshot', t('cmd.inspect.snapshot'), 'GET /api/inspect?target=snapshot'],
      ['inspect.math_spine', t('cmd.inspect.math_spine'), 'GET /api/inspect?target=math-spine'],
      ['inspect.graph', t('cmd.inspect.graph'), 'GET /api/inspect?target=graph'],
      ['inspect.ingestion', t('cmd.inspect.ingestion'), 'GET /api/inspect?target=ingestion'],
      ['inspect.codebase', t('cmd.inspect.codebase'), 'GET /api/inspect?target=codebase'],
      ['inspect.self', t('cmd.inspect.self'), 'GET /api/inspect?target=self'],
      ['inspect.proofs', t('cmd.inspect.proofs'), 'GET /api/inspect?target=proofs'],
      ['kernel.turn', t('cmd.kernel.turn'), 'POST /api/turn']
    ];
    function renderPalette(q) { const needle = q.toLowerCase(); paletteList.innerHTML = ''; commands.filter(c => (c[1] + ' ' + c[2]).toLowerCase().includes(needle)).forEach((c, i) => { const d = document.createElement('div'); d.className = 'cmd' + (i === 0 ? ' active' : ''); d.innerHTML = '<strong></strong><span></span>'; d.querySelector('strong').textContent = c[1]; d.querySelector('span').textContent = c[2]; d.onclick = () => runCommand(c[0]); paletteList.appendChild(d); }); }
    async function runCommand(id) {
      closePalette();
      try {
        if (id === 'kernel.turn') return sendButton.click();
        if (id === 'kernel.codebase_ingest') { const p = window.prompt(t('prompt.codebase_path')); if (!p || !p.trim()) return; log('POST /api/codebase/ingest'); const r = await post('/api/codebase/ingest', { path: p.trim() }); inspector.textContent = JSON.stringify(r, null, 2); toggleDevPanel(true); return; }
        if (id === 'workspace.init') { const p = window.prompt(t('prompt.workspace_path')); if (!p || !p.trim()) return; log('POST /api/workspace/init'); const r = await post('/api/workspace/init', { path: p.trim() }); inspector.textContent = JSON.stringify(r, null, 2); toggleDevPanel(true); return; }
        if (id === 'workspace.ingest') { const p = window.prompt(t('prompt.workspace_path')); log('POST /api/workspace/ingest'); const r = await post('/api/workspace/ingest', p && p.trim() ? { path: p.trim() } : {}); inspector.textContent = JSON.stringify(r, null, 2); toggleDevPanel(true); return; }
        if (id === 'workspace.ask') { const q = window.prompt(t('prompt.workspace_question')); if (!q || !q.trim()) return; log('POST /api/workspace/ask'); const r = await post('/api/workspace/ask', { question: q.trim() }); inspector.textContent = JSON.stringify(r, null, 2); add('scce', r.answer || JSON.stringify(r)); return; }
        if (id === 'session.approvals') { log('GET /api/session/approvals'); const r = await refreshApprovals(); inspector.textContent = JSON.stringify(r, null, 2); toggleDevPanel(true); return; }
        if (id === 'session.operator_grant') { const next = !document.getElementById('operator-grant-toggle').checked; log('POST /api/session/operator-grant ' + next); const r = await post('/api/session/operator-grant', { enabled: next }); renderApprovals(r); inspector.textContent = JSON.stringify(r, null, 2); toggleDevPanel(true); return; }
        const map = { 'runtime.ready': '/api/ready', 'db.verify': '/api/db/verify', 'db.stats': '/api/db/stats', 'tools.inspect': '/api/tools', 'connectors.quota': '/api/connectors/quota', 'project.summary': '/api/project/summary', 'project.map': '/api/project/map', 'project.symbols': '/api/project/symbols', 'project.gaps': '/api/project/gaps', 'project.contradictions': '/api/project/contradictions', 'project.tasks': '/api/project/tasks', 'report.brief': '/api/reports/brief', 'report.patch_plan': '/api/reports/patch-plan', 'report.handoff': '/api/reports/handoff', 'report.review': '/api/reports/review', 'inspect.snapshot': '/api/inspect?target=snapshot', 'inspect.math_spine': '/api/inspect?target=math-spine', 'inspect.graph': '/api/inspect?target=graph', 'inspect.ingestion': '/api/inspect?target=ingestion', 'inspect.codebase': '/api/inspect?target=codebase', 'inspect.self': '/api/inspect?target=self', 'inspect.proofs': '/api/inspect?target=proofs' };
        log('GET ' + map[id]); const r = await get(map[id]); inspector.textContent = JSON.stringify(r, null, 2); toggleDevPanel(true);
      } catch (e) { inspector.textContent = t('error.prefix') + ' ' + e.message; toggleDevPanel(true); }
    }
    paletteInput.oninput = () => renderPalette(paletteInput.value);
    paletteInput.onkeydown = e => { if (e.key === 'Escape') closePalette(); if (e.key === 'Enter') paletteList.querySelector('.cmd')?.click(); };
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
      if (e.key === 'Escape' && palette.classList.contains('open')) closePalette();
    });
    function autoGrow() { prompt.style.height = 'auto'; prompt.style.height = Math.min(200, prompt.scrollHeight) + 'px'; }
    prompt.addEventListener('input', autoGrow);
    prompt.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendButton.click(); }
    });
    sendButton.onclick = async () => {
      const text = prompt.value.trim(); if (!text) return;
      add('owner', text);
      prompt.value = ''; autoGrow();
      setSending(true); showTyping('');
      log('POST /api/turn?stream=1');
      try {
        const r = await postTurnStream('/api/turn?stream=1', { text, sessionId, conversationId: sessionId }, frame => { if (frame.type === 'progress') showTyping(frame.phase); });
        hideTyping(); setSending(false);
        add('scce', turnSurface(r), turnDetail(r));
        addFeedbackControls(r.dialogue, text);
        inspector.textContent = JSON.stringify({ dialogue: r.dialogue, proof: r.entailment?.proof, pca: r.proofCarryingAnswer, pface: r.pface, language: r.languageAcquisition, actionGraph: r.actionGraph, functionalCognition: r.functionalCognition }, null, 2);
        trace.textContent = (r.events || []).map(e => e.typeId + ' ' + e.id).join('\\n');
        await refreshApprovals();
      } catch (e) {
        hideTyping(); setSending(false);
        add('error', t('error.prefix') + ' ' + e.message);
      }
    };
    document.getElementById('inspect').onclick = async () => { log('GET /api/inspect?target=snapshot'); try { const r = await get('/api/inspect?target=snapshot'); inspector.textContent = JSON.stringify(r, null, 2); } catch (e) { inspector.textContent = t('error.prefix') + ' ' + e.message; } };
    document.getElementById('refresh-approvals').onclick = async () => { log('GET /api/session/approvals'); try { const r = await refreshApprovals(); inspector.textContent = JSON.stringify(r, null, 2); } catch (e) { inspector.textContent = t('error.prefix') + ' ' + e.message; } };
    document.getElementById('operator-grant-toggle').onchange = async e => { log('POST /api/session/operator-grant ' + e.target.checked); try { const r = await post('/api/session/operator-grant', { enabled: e.target.checked }); renderApprovals(r); inspector.textContent = JSON.stringify(r, null, 2); } catch (err) { inspector.textContent = t('error.prefix') + ' ' + err.message; e.target.checked = !e.target.checked; } };
    refreshApprovals().catch(() => {});
    resumeStoredTurn().catch(() => {});
    prompt.focus();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (char === "'") out += "&#39;";
    else out += char;
  }
  return out;
}
