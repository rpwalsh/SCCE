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
    :root { color-scheme: dark; --bg:#1e1f22; --panel:#25262b; --panel2:#2b2d33; --line:#3a3d46; --text:#e7e9ef; --muted:#9ca3af; --accent:#56b6c2; --ok:#7ddc8b; --warn:#e7c664; --bad:#ff6b6b; }
    * { box-sizing:border-box; }
    body { margin:0; font:13px/1.45 "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--text); height:100vh; overflow:hidden; }
    .shell { display:grid; grid-template-columns:48px 292px minmax(0,1fr); grid-template-rows:34px minmax(0,1fr) 190px 24px; height:100vh; }
    .title { grid-column:1 / 4; display:flex; align-items:center; gap:16px; padding:0 12px; border-bottom:1px solid var(--line); background:#18191c; color:var(--muted); min-width:0; }
    .title strong { color:var(--text); font-weight:600; }
    .title span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rail { grid-row:2 / 4; background:#18191c; border-right:1px solid var(--line); display:flex; flex-direction:column; align-items:center; padding-top:10px; gap:12px; }
    .icon { width:30px; height:30px; display:grid; place-items:center; border-radius:6px; color:var(--muted); border:1px solid transparent; font:10px Consolas, monospace; }
    .icon.active { color:var(--accent); border-color:var(--line); background:#22242a; }
    .side { grid-row:2 / 4; border-right:1px solid var(--line); background:var(--panel); display:flex; flex-direction:column; min-width:0; }
    .side h2, .pane h2 { font-size:11px; letter-spacing:0; text-transform:uppercase; margin:0; padding:10px 12px; color:var(--muted); border-bottom:1px solid var(--line); }
    .tree { padding:8px 0; overflow:auto; }
    .tree div { padding:5px 12px 5px 22px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .tree div:hover { background:#30333b; }
    .approvals { border-top:1px solid var(--line); padding-bottom:8px; min-height:150px; overflow:auto; }
    .approval-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; }
    .toggle { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; white-space:nowrap; }
    .toggle input { accent-color:var(--bad); }
    .approval-item { margin:6px 8px; padding:8px; border:1px solid var(--line); border-radius:6px; background:#202126; }
    .approval-item strong { display:block; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .approval-item code { display:block; color:var(--muted); font:11px Consolas, monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .approval-item button { margin-top:7px; min-width:0; height:26px; padding:0 10px; border-radius:5px; background:#7a4f2f; }
    .main { grid-column:3; grid-row:2; display:grid; grid-template-columns:minmax(360px,1fr) minmax(300px,420px); min-width:0; min-height:0; }
    .editor { border-right:1px solid var(--line); display:flex; flex-direction:column; min-width:0; min-height:0; }
    .tabs { height:34px; display:flex; border-bottom:1px solid var(--line); background:#202126; overflow:hidden; }
    .tab { padding:8px 14px; border-right:1px solid var(--line); background:#282a31; color:var(--text); white-space:nowrap; }
    .chat { padding:14px; overflow:auto; flex:1; min-height:0; }
    .msg { margin:0 0 12px; padding:10px 12px; background:#24262d; border:1px solid var(--line); border-radius:6px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .msg.owner { border-left:3px solid var(--accent); }
    .msg.scce { border-left:3px solid var(--ok); }
    .feedback { display:flex; gap:6px; margin:-6px 0 12px 14px; }
    .feedback button { min-width:34px; width:34px; height:28px; padding:0; border-radius:5px; background:#3a3d46; }
    .feedback button.accept { background:#2f6f46; }
    .feedback button.reject { background:#7a2f35; }
    .composer { display:flex; gap:8px; padding:10px; border-top:1px solid var(--line); background:#202126; }
    textarea { flex:1; min-height:44px; resize:vertical; background:#18191c; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:8px; font:13px Consolas, monospace; min-width:0; }
    button { min-width:88px; background:#2f6f7a; color:white; border:0; border-radius:6px; padding:0 14px; font-weight:600; }
    button.secondary { background:#3a3d46; }
    button.danger { background:#7a2f35; }
    .pane { display:flex; flex-direction:column; min-width:0; min-height:0; background:#202126; }
    .json { flex:1; overflow:auto; padding:12px; font:12px Consolas, monospace; color:#d7dae0; white-space:pre-wrap; overflow-wrap:anywhere; }
    .bottom { grid-column:3; grid-row:3; display:grid; grid-template-columns:1fr 1fr; border-top:1px solid var(--line); background:#18191c; min-height:0; }
    .terminal, .trace { overflow:auto; padding:10px; font:12px Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .terminal { border-right:1px solid var(--line); color:#d6d6d6; }
    .trace { color:#c3e88d; }
    .status { grid-column:1 / 4; grid-row:4; background:#0e639c; display:flex; align-items:center; gap:18px; padding:0 10px; font-size:12px; overflow:hidden; }
    .pill { color:#fff; opacity:.95; white-space:nowrap; }
    .palette { position:fixed; inset:52px auto auto 50%; transform:translateX(-50%); width:min(680px, calc(100vw - 28px)); background:#25262b; border:1px solid var(--line); box-shadow:0 18px 48px rgba(0,0,0,.42); border-radius:6px; display:none; z-index:20; }
    .palette.open { display:block; }
    .palette input { width:100%; height:42px; background:#18191c; color:var(--text); border:0; border-bottom:1px solid var(--line); padding:0 12px; font:13px "Segoe UI", system-ui, sans-serif; outline:0; }
    .palette-list { max-height:320px; overflow:auto; padding:6px 0; }
    .cmd { display:grid; grid-template-columns:1fr auto; gap:10px; padding:8px 12px; cursor:pointer; }
    .cmd:hover, .cmd.active { background:#30333b; }
    .cmd strong { font-weight:600; }
    .cmd span { color:var(--muted); font-size:12px; }
    @media (max-width: 880px) {
      .shell { grid-template-columns:44px minmax(0,1fr); grid-template-rows:34px 146px minmax(0,1fr) 160px 24px; }
      .title, .status { grid-column:1 / 3; }
      .rail { grid-row:2 / 5; }
      .side { grid-column:2; grid-row:2; border-right:0; border-bottom:1px solid var(--line); }
      .main { grid-column:2; grid-row:3; grid-template-columns:1fr; }
      .pane { display:none; }
      .bottom { grid-column:2; grid-row:4; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="title"><strong>${escapeHtml(uiText("app.title"))}</strong><span>${escapeHtml(serverUrl)}</span><span>${escapeHtml(uiText("app.subtitle"))}</span></div>
    <div class="rail"><div class="icon active">EX</div><div class="icon">SR</div><div class="icon">PG</div><div class="icon">CF</div></div>
    <aside class="side">
      <h2>${escapeHtml(uiText("side.explorer"))}</h2>
      <div class="tree">
        <div>scce.config.json</div><div>packages/kernel</div><div>packages/adapters-node</div><div>packages/server</div><div>packages/ui</div>
      </div>
      <h2>${escapeHtml(uiText("side.evidence"))}</h2>
      <div class="tree" id="evidence-tree"><div>${escapeHtml(uiText("side.evidence.empty"))}</div></div>
      <div class="approvals">
        <h2>${escapeHtml(uiText("side.approvals"))}</h2>
        <div class="approval-head"><label class="toggle"><input type="checkbox" id="operator-grant-toggle" /> ${escapeHtml(uiText("side.approvals.operator_grant"))}</label><button class="secondary" id="refresh-approvals">${escapeHtml(uiText("side.approvals.refresh"))}</button></div>
        <div id="approval-list" class="tree"><div>${escapeHtml(uiText("side.approvals.none"))}</div></div>
      </div>
    </aside>
    <main class="main">
      <section class="editor">
        <div class="tabs"><div class="tab">${escapeHtml(uiText("tabs.chat"))}</div><div class="tab">${escapeHtml(uiText("tabs.proof"))}</div><div class="tab">${escapeHtml(uiText("tabs.pca"))}</div><div class="tab">${escapeHtml(uiText("tabs.program"))}</div><div class="tab">${escapeHtml(uiText("tabs.action"))}</div><div class="tab">${escapeHtml(uiText("tabs.self"))}</div></div>
        <div class="chat" id="chat"><div class="msg scce">${escapeHtml(uiText("chat.ready"))}</div></div>
        <div class="composer"><textarea id="prompt">${escapeHtml(uiText("prompt.default"))}</textarea><button id="send">${escapeHtml(uiText("button.turn"))}</button><button class="secondary" id="inspect">${escapeHtml(uiText("button.inspect"))}</button></div>
      </section>
      <section class="pane"><h2>${escapeHtml(uiText("pane.inspector"))}</h2><pre class="json" id="inspect-json">{}</pre></section>
    </main>
    <div class="bottom"><div class="terminal" id="terminal">${escapeHtml(uiText("terminal.ready"))}</div><div class="trace" id="trace"></div></div>
    <div class="status"><span class="pill">${escapeHtml(uiText("status.product"))}</span><span class="pill">${escapeHtml(uiText("status.postgres"))}</span><span class="pill">${escapeHtml(uiText("status.math"))}</span></div>
  </div>
  <div class="palette" id="palette"><input id="palette-input" aria-label="${escapeHtml(uiText("palette.aria"))}" /><div class="palette-list" id="palette-list"></div></div>
  <script>
    const I18N = ${uiMessageScript()};
    const t = key => I18N[key] || key;
    const chat = document.getElementById('chat');
    const terminal = document.getElementById('terminal');
    const trace = document.getElementById('trace');
    const inspector = document.getElementById('inspect-json');
    const prompt = document.getElementById('prompt');
    const palette = document.getElementById('palette');
    const paletteInput = document.getElementById('palette-input');
    const paletteList = document.getElementById('palette-list');
    const sessionId = localStorage.getItem('scce.sessionId') || ('session.' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem('scce.sessionId', sessionId);
    const commands = [
      ['runtime.ready',t('cmd.runtime.ready'),'GET /api/ready'],
      ['db.verify',t('cmd.db.verify'),'GET /api/db/verify'],
      ['db.stats',t('cmd.db.stats'),'GET /api/db/stats'],
      ['tools.inspect',t('cmd.tools.inspect'),'GET /api/tools'],
      ['session.approvals',t('cmd.session.approvals'),'GET /api/session/approvals'],
      ['session.operator_grant',t('cmd.session.operator_grant'),'POST /api/session/operator-grant'],
      ['connectors.quota',t('cmd.connectors.quota'),'GET /api/connectors/quota'],
      ['kernel.codebase_ingest',t('cmd.ingest.codebase'),'POST /api/codebase/ingest'],
      ['workspace.init',t('cmd.workspace.init'),'POST /api/workspace/init'],
      ['workspace.ingest',t('cmd.workspace.ingest'),'POST /api/workspace/ingest'],
      ['workspace.ask',t('cmd.workspace.ask'),'POST /api/workspace/ask'],
      ['project.summary',t('cmd.project.summary'),'GET /api/project/summary'],
      ['project.map',t('cmd.project.map'),'GET /api/project/map'],
      ['project.symbols',t('cmd.project.symbols'),'GET /api/project/symbols'],
      ['project.gaps',t('cmd.project.gaps'),'GET /api/project/gaps'],
      ['project.contradictions',t('cmd.project.contradictions'),'GET /api/project/contradictions'],
      ['project.tasks',t('cmd.project.tasks'),'GET /api/project/tasks'],
      ['report.brief',t('cmd.report.brief'),'GET /api/reports/brief'],
      ['report.patch_plan',t('cmd.report.patch_plan'),'GET /api/reports/patch-plan'],
      ['report.handoff',t('cmd.report.handoff'),'GET /api/reports/handoff'],
      ['report.review',t('cmd.report.review'),'GET /api/reports/review'],
      ['inspect.snapshot',t('cmd.inspect.snapshot'),'GET /api/inspect?target=snapshot'],
      ['inspect.math_spine',t('cmd.inspect.math_spine'),'GET /api/inspect?target=math-spine'],
      ['inspect.graph',t('cmd.inspect.graph'),'GET /api/inspect?target=graph'],
      ['inspect.ingestion',t('cmd.inspect.ingestion'),'GET /api/inspect?target=ingestion'],
      ['inspect.codebase',t('cmd.inspect.codebase'),'GET /api/inspect?target=codebase'],
      ['inspect.self',t('cmd.inspect.self'),'GET /api/inspect?target=self'],
      ['inspect.proofs',t('cmd.inspect.proofs'),'GET /api/inspect?target=proofs'],
      ['kernel.turn',t('cmd.kernel.turn'),'POST /api/turn']
    ];
    function add(role, text) { const d=document.createElement('div'); d.className='msg '+role; d.textContent=String(text||''); chat.appendChild(d); chat.scrollTop=chat.scrollHeight; return d; }
    function turnSurface(r) {
      if(r && typeof r.answer==='string' && answerHasSpeech(r.answer)) return r.answer;
      const err = r && (r.error?.message || r.error || r.runtimeError || r.message);
      return err ? 'Runtime failure: '+String(err) : 'Runtime failure: /api/turn returned no answer.';
    }
    function answerHasSpeech(text) { return /[\p{L}\p{N}]/u.test(String(text||'')); }
    function addFeedbackControls(dialogue, promptText) {
      if(!dialogue || !dialogue.conversationId) return;
      const row=document.createElement('div'); row.className='feedback';
      const sendOutcome=async(status, correctionText)=>{
        log('POST /api/turn/outcome '+status);
        const body={ status, conversationId:dialogue.conversationId, turnId:dialogue.turnId, promptText };
        if(correctionText) body.correctionText=correctionText;
        const r=await post('/api/turn/outcome',body);
        inspector.textContent=JSON.stringify({ dialogue, outcome:r },null,2);
        row.remove();
      };
      const accept=document.createElement('button'); accept.className='accept'; accept.title='Accept'; accept.textContent='A'; accept.onclick=()=>sendOutcome('accepted');
      const reject=document.createElement('button'); reject.className='reject'; reject.title='Reject'; reject.textContent='R'; reject.onclick=()=>sendOutcome('rejected');
      const correct=document.createElement('button'); correct.title='Correct'; correct.textContent='C'; correct.onclick=()=>{ const text=window.prompt('Correction'); if(text && text.trim()) sendOutcome('corrected',text.trim()); };
      row.appendChild(accept); row.appendChild(reject); row.appendChild(correct); chat.appendChild(row); chat.scrollTop=chat.scrollHeight;
    }
    function log(text) { terminal.textContent += "\\n$ " + text; terminal.scrollTop=terminal.scrollHeight; }
    async function post(url, body) { const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const t=await r.text(); const j=t?JSON.parse(t):null; if(!r.ok) throw new Error(JSON.stringify(j)); return j; }
    async function get(url) { const r=await fetch(url); const t=await r.text(); const j=t?JSON.parse(t):null; if(!r.ok) throw new Error(JSON.stringify(j)); return j; }
    async function refreshApprovals() { const r=await get('/api/session/approvals'); renderApprovals(r); return r; }
    function renderApprovals(state) {
      document.getElementById('operator-grant-toggle').checked=Boolean(state.operatorGrant);
      const list=document.getElementById('approval-list');
      list.innerHTML='';
      const pending=state.pending||[];
      if(!pending.length) { const d=document.createElement('div'); d.textContent=state.operatorGrant?t('side.approvals.operator_grant_enabled'):t('side.approvals.none'); list.appendChild(d); return; }
      pending.forEach(item=>{
        const box=document.createElement('div'); box.className='approval-item';
        const title=document.createElement('strong'); title.textContent=item.capabilityId; box.appendChild(title);
        const code=document.createElement('code'); code.textContent=item.planId; box.appendChild(code);
        const reason=document.createElement('code'); reason.textContent=item.reason||t('approval.required'); box.appendChild(reason);
        const button=document.createElement('button'); button.textContent=t('side.approvals.approve'); button.onclick=async()=>{ log('POST /api/session/approve '+item.planId); const r=await post('/api/session/approve',{planId:item.planId}); inspector.textContent=JSON.stringify(r,null,2); renderApprovals(r.session); };
        box.appendChild(button); list.appendChild(box);
      });
    }
    function openPalette() { palette.classList.add('open'); paletteInput.value=''; renderPalette(''); paletteInput.focus(); }
    function closePalette() { palette.classList.remove('open'); }
    function renderPalette(q) { const needle=q.toLowerCase(); paletteList.innerHTML=''; commands.filter(c => (c[1]+' '+c[2]).toLowerCase().includes(needle)).forEach((c,i)=>{ const d=document.createElement('div'); d.className='cmd'+(i===0?' active':''); d.innerHTML='<strong></strong><span></span>'; d.querySelector('strong').textContent=c[1]; d.querySelector('span').textContent=c[2]; d.onclick=()=>runCommand(c[0]); paletteList.appendChild(d); }); }
    async function runCommand(id) { closePalette(); try { if(id==='kernel.turn') return document.getElementById('send').click(); if(id==='kernel.codebase_ingest') { const p=window.prompt(t('prompt.codebase_path')); if(!p || !p.trim()) return; log('POST /api/codebase/ingest'); const r=await post('/api/codebase/ingest',{path:p.trim()}); inspector.textContent=JSON.stringify(r,null,2); return; } if(id==='workspace.init') { const p=window.prompt(t('prompt.workspace_path')); if(!p || !p.trim()) return; log('POST /api/workspace/init'); const r=await post('/api/workspace/init',{path:p.trim()}); inspector.textContent=JSON.stringify(r,null,2); return; } if(id==='workspace.ingest') { const p=window.prompt(t('prompt.workspace_path')); log('POST /api/workspace/ingest'); const r=await post('/api/workspace/ingest',p&&p.trim()?{path:p.trim()}:{}); inspector.textContent=JSON.stringify(r,null,2); return; } if(id==='workspace.ask') { const q=window.prompt(t('prompt.workspace_question')); if(!q || !q.trim()) return; log('POST /api/workspace/ask'); const r=await post('/api/workspace/ask',{question:q.trim()}); inspector.textContent=JSON.stringify(r,null,2); add('scce',r.answer||JSON.stringify(r)); return; } if(id==='session.approvals') { log('GET /api/session/approvals'); const r=await refreshApprovals(); inspector.textContent=JSON.stringify(r,null,2); return; } if(id==='session.operator_grant') { const next=!document.getElementById('operator-grant-toggle').checked; log('POST /api/session/operator-grant '+next); const r=await post('/api/session/operator-grant',{enabled:next}); renderApprovals(r); inspector.textContent=JSON.stringify(r,null,2); return; } const map={ 'runtime.ready':'/api/ready', 'db.verify':'/api/db/verify', 'db.stats':'/api/db/stats', 'tools.inspect':'/api/tools', 'connectors.quota':'/api/connectors/quota', 'project.summary':'/api/project/summary', 'project.map':'/api/project/map', 'project.symbols':'/api/project/symbols', 'project.gaps':'/api/project/gaps', 'project.contradictions':'/api/project/contradictions', 'project.tasks':'/api/project/tasks', 'report.brief':'/api/reports/brief', 'report.patch_plan':'/api/reports/patch-plan', 'report.handoff':'/api/reports/handoff', 'report.review':'/api/reports/review', 'inspect.snapshot':'/api/inspect?target=snapshot', 'inspect.math_spine':'/api/inspect?target=math-spine', 'inspect.graph':'/api/inspect?target=graph', 'inspect.ingestion':'/api/inspect?target=ingestion', 'inspect.codebase':'/api/inspect?target=codebase', 'inspect.self':'/api/inspect?target=self', 'inspect.proofs':'/api/inspect?target=proofs' }; log('GET '+map[id]); const r=await get(map[id]); inspector.textContent=JSON.stringify(r,null,2); } catch(e) { inspector.textContent=t('error.prefix')+' '+e.message; } }
    paletteInput.oninput = () => renderPalette(paletteInput.value);
    paletteInput.onkeydown = e => { if(e.key==='Escape') closePalette(); if(e.key==='Enter') paletteList.querySelector('.cmd')?.click(); };
    document.addEventListener('keydown', e => { if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='k') { e.preventDefault(); openPalette(); } if((e.ctrlKey || e.metaKey) && e.key==='Enter') { e.preventDefault(); document.getElementById('send').click(); } });
    document.getElementById('send').onclick = async () => { const text=prompt.value.trim(); if(!text) return; add('owner', text); log('POST /api/turn'); try { const r=await post('/api/turn',{text,sessionId,conversationId:sessionId}); add('scce', turnSurface(r)); addFeedbackControls(r.dialogue,text); inspector.textContent=JSON.stringify({ dialogue:r.dialogue, proof:r.entailment?.proof, pca:r.proofCarryingAnswer, pface:r.pface, language:r.languageAcquisition, actionGraph:r.actionGraph, functionalCognition:r.functionalCognition },null,2); trace.textContent=(r.events||[]).map(e=>e.typeId+' '+e.id).join('\\n'); await refreshApprovals(); } catch(e) { add('scce',t('error.prefix')+' '+e.message); } };
    document.getElementById('inspect').onclick = async () => { log('GET /api/inspect?target=snapshot'); try { const r=await get('/api/inspect?target=snapshot'); inspector.textContent=JSON.stringify(r,null,2); } catch(e) { inspector.textContent=t('error.prefix')+' '+e.message; } };
    document.getElementById('refresh-approvals').onclick = async () => { log('GET /api/session/approvals'); try { const r=await refreshApprovals(); inspector.textContent=JSON.stringify(r,null,2); } catch(e) { inspector.textContent=t('error.prefix')+' '+e.message; } };
    document.getElementById('operator-grant-toggle').onchange = async e => { log('POST /api/session/operator-grant '+e.target.checked); try { const r=await post('/api/session/operator-grant',{enabled:e.target.checked}); renderApprovals(r); inspector.textContent=JSON.stringify(r,null,2); } catch(err) { inspector.textContent=t('error.prefix')+' '+err.message; e.target.checked=!e.target.checked; } };
    refreshApprovals().catch(()=>{});
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
