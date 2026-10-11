const app = document.getElementById('app');
const STATES = ['INTAKE', 'INVENTORY', 'INTEL', 'IMPACT', 'PRIORITIZE', 'PLAN_REPAIR', 'BASELINE', 'PATCH', 'TEST', 'DIAGNOSE', 'VERIFY', 'REPORT', 'AWAITING_APPROVAL'];
const STATUS_WORDS = { confirmed: 'Confirmed', potential: 'Potential', unresolved: 'Unresolved', not_affected: 'Not affected' };
let timer = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (repo) => repo.replace(/^https:\/\/github\.com\//, '').replace(/^.*\/bench\/cases\//, 'bench/').replace(/\/repo$/, '');
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

async function api(path, options = {}) {
  const token = localStorage.getItem('veritas-token');
  const res = await fetch(`/api${path}`, { ...options, headers: { 'content-type': 'application/json', ...(token ? { 'x-veritas-token': token } : {}) } });
  if (res.status === 401) {
    const given = prompt('Access token');
    if (given) { localStorage.setItem('veritas-token', given); return api(path, options); }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function statusBadge(inv, running) {
  if (running || inv.status === 'running') return `<span class="badge warn"><span class="spinner"></span>${esc(inv.current_state.replace(/_/g, ' ').toLowerCase())}</span>`;
  if (inv.status === 'failed') return '<span class="badge bad">failed</span>';
  if (inv.status === 'awaiting_approval') return '<span class="badge warn">awaiting approval</span>';
  return '<span class="badge ok">done</span>';
}
const verdictBadge = (v) => ({ fixes_ready: '<span class="badge ok">fixes ready</span>', nothing_to_do: '<span class="badge">nothing to do</span>', needs_attention: '<span class="badge warn">needs attention</span>' })[v] ?? '';
const findingBadge = (s) => `<span class="badge ${s === 'confirmed' ? 'bad' : s === 'not_affected' ? 'ok' : 'warn'}">${esc(STATUS_WORDS[s] ?? s)}</span>`;

async function dashboard() {
  const [config, list] = await Promise.all([api('/config'), api('/investigations')]);
  document.getElementById('env').textContent = `model ${config.model} · sandbox ${config.sandbox}`;
  const examples = config.examples.length ? `<select id="example"><option value="">or pick a benchmark repository…</option>${config.examples.map((e) => `<option value="${esc(e.path)}">${esc(e.name)}</option>`).join('')}</select>` : '';
  app.innerHTML = `
    <h1>Investigations</h1>
    <p class="muted">Give Veritas a repository. It finds the dependency changes that matter, proves whether they break this code, and prepares a tested fix for you to approve.</p>
    <div class="panel"><form id="new" class="row">
      <input type="text" id="repo" placeholder="https://github.com/owner/repo" autocomplete="off">${examples}
      <button type="submit">New investigation</button></form><div id="formError" class="error"></div></div>
    <div class="panel">${list.length ? `<table><thead><tr><th>Repository</th><th>Status</th><th>Result</th><th>Started</th></tr></thead><tbody>
      ${list.map((i) => `<tr><td><a href="#/i/${i.id}">${esc(short(i.repo_url))}</a></td><td>${statusBadge(i, i.running)}</td>
        <td>${i.summary ? `${verdictBadge(i.summary.verdict)} ${esc(i.summary.headline)}` : ''}${i.approval ? ` <span class="badge">${esc(i.approval.decision)}</span>` : ''}</td><td class="muted">${esc(when(i.started_at))}</td></tr>`).join('')}
      </tbody></table>` : '<span class="muted">No investigations yet.</span>'}</div>`;
  const example = document.getElementById('example');
  if (example) example.onchange = () => { document.getElementById('repo').value = example.value; };
  document.getElementById('new').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const { id } = await api('/investigations', { method: 'POST', body: JSON.stringify({ repo: document.getElementById('repo').value }) });
      location.hash = `#/i/${id}`;
    } catch (err) { document.getElementById('formError').textContent = err.message; }
  };
  if (list.some((i) => i.running)) timer = setTimeout(render, 3000);
}

function timeline(data) {
  const reached = new Set(data.steps.map((s) => s.state));
  const current = data.investigation.current_state;
  return `<div class="timeline">${STATES.map((s) => {
    const cls = s === current ? (data.investigation.status === 'failed' ? 'failed' : data.running ? 'now' : 'done') : reached.has(s) ? 'done' : '';
    return `<span class="state ${cls}">${s.replace(/_/g, ' ')}</span>`;
  }).join('')}</div>`;
}

function diffHtml(diff) {
  return `<pre class="diff">${diff.trim().split('\n').map((line) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') || line.startsWith('diff ') ? 'hunk' : '';
    return `<span class="${cls}">${esc(line)}</span>`;
  }).join('\n')}</pre>`;
}

function overview(data) {
  const r = data.report;
  if (!r) return '<div class="panel muted">Working…</div>';
  return `
    ${r.findings.length ? `<div class="panel"><table><thead><tr><th>Package</th><th>Kind</th><th>Status</th><th>Priority</th><th>Affected files</th></tr></thead><tbody>
      ${r.findings.map((f) => `<tr><td class="mono">${esc(f.package)}</td><td>${esc(f.kind)}</td><td>${findingBadge(f.status)}</td><td>${f.priority ?? '-'}</td><td class="mono">${[...new Set(f.affected.map((a) => a.file))].map(esc).join('<br>') || '-'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="panel muted">No findings.</div>'}
    ${r.findings.map((f) => `<div class="panel"><h3>${esc(f.package)}: ${esc(f.kind)} ${findingBadge(f.status)}</h3><p>${esc(f.rationale)}</p>
      ${f.affected.length ? `<div class="mono">${f.affected.map((a) => `${esc(a.file)}${a.line ? `:${a.line}` : ''}${a.symbol ? ` in ${esc(a.symbol)}` : ''}`).join('<br>')}</div>` : ''}
      ${f.sources.length ? `<h3>Sources read</h3><ul>${f.sources.filter((s) => s.read_from_source).map((s) => `<li>${esc(s.kind.replace(/_/g, ' '))}: <a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url)}</a></li>`).join('')}</ul>` : ''}</div>`).join('')}`;
}

function patch(data) {
  const r = data.report;
  if (!r || !r.repairs.length) return '<div class="panel muted">No repair was needed or attempted.</div>';
  const canDecide = data.investigation.status === 'awaiting_approval' && !data.approval;
  const anyVerified = r.repairs.some((x) => x.status === 'verified');
  const decision = data.approval
    ? `<div class="panel"><strong>${esc(data.approval.decision === 'approved' ? 'Approved' : 'Rejected')}</strong> <span class="muted">${esc(when(data.approval.decided_at))}</span>
        ${data.approval.pr_url ? data.approval.pr_url.split(' ').map((u) => `<div><a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u)}</a></div>`).join('') : data.approval.decision === 'approved' ? '<div class="muted">Local repository: the fix is on its branch in the workspace. No pull request was opened.</div>' : ''}</div>`
    : canDecide ? `<div class="panel row"><span>${anyVerified ? 'Nothing has left the workspace. Approving opens a pull request for each verified fix.' : 'There is no verified fix to approve.'}</span>
        <span class="right row"><button id="reject" class="danger">Reject</button><button id="approve" ${anyVerified ? '' : 'disabled'}>Approve</button></span></div><div id="decisionError" class="error"></div>` : '';
  return decision + r.repairs.map((x) => `<div class="panel">
    <h3 class="mono">${esc(x.package)} ${esc(x.from)} → ${esc(x.to)} <span class="badge ${x.status === 'verified' ? 'ok' : x.status === 'unresolved' ? 'bad' : 'warn'}">${esc(x.status.replace(/_/g, ' '))}</span></h3>
    <p class="muted">${esc(x.note ?? '')}</p>
    <table><thead><tr><th>Test run</th><th>Result</th><th>Passed</th><th>Failed</th></tr></thead><tbody>
      ${x.test_runs.map((t) => `<tr><td>${esc(t.label.replace(/_/g, ' '))}</td><td>${t.exit_code === 0 ? '<span class="badge ok">pass</span>' : '<span class="badge bad">fail</span>'}</td><td>${t.passed ?? '-'}</td><td>${t.failed ?? '-'}</td></tr>`).join('')}</tbody></table>
    ${x.verification ? `<h3>Verification</h3>${x.verification.checks.map((c) => `<div class="check ${c.ok ? 'ok' : 'no'}">${esc(c.detail)}</div>`).join('')}${x.verification.caveats.map((c) => `<div class="muted">Note: ${esc(c)}</div>`).join('')}` : ''}
    ${x.attempts.map((a) => `<h3>Attempt ${a.n} <span class="badge ${a.outcome === 'tests_passed' ? 'ok' : 'bad'}">${a.outcome === 'tests_passed' ? 'tests passed' : 'tests failed'}</span></h3>
      <p>${esc(a.plan ?? '')}</p>${a.diagnosis ? `<p><span class="muted">Diagnosis after the failure:</span> ${esc(a.diagnosis)}</p>` : ''}${a.diff ? diffHtml(a.diff) : ''}`).join('')}
    ${x.functions_changed.length ? `<p class="muted">Functions changed: <span class="mono">${x.functions_changed.map(esc).join(', ')}</span></p>` : ''}</div>`).join('');
}

function reportView(data) {
  const r = data.report;
  if (!r) return '<div class="panel muted">The report is written when the investigation finishes.</div>';
  const list = (title, items) => (items.length ? `<div class="panel"><h3>${title}</h3><ul>${items.map((i) => `<li>${esc(i.split('\n')[0])}</li>`).join('')}</ul></div>` : '');
  return `<div class="panel"><div class="row"><span>${verdictBadge(r.verdict)}</span><a class="right" href="/api/investigations/${data.investigation.id}/report.md" target="_blank">Open as Markdown</a></div>
      <p class="headline">${esc(r.headline)}</p>
      <table><tbody><tr><td>Findings</td><td>${r.counts.findings}</td></tr><tr><td>Verified fixes</td><td>${r.counts.verified}</td></tr><tr><td>Unresolved</td><td>${r.counts.unresolved}</td></tr>
      <tr><td>Not affected</td><td>${r.counts.not_affected}</td></tr><tr><td>Potential, not proven</td><td>${r.counts.potential}</td></tr><tr><td>Could not be checked</td><td>${r.counts.unchecked}</td></tr></tbody></table></div>
    ${list('Remaining risk', r.remaining_risk)}${list('Could not check', r.could_not_check)}`;
}

function history(data) {
  const u = data.usage;
  return `<div class="panel">${u.calls} model calls · ${u.promptTokens + u.completionTokens} tokens · $${Number(u.costUsd).toFixed(4)} · ${data.steps.length} steps</div>
    <div class="panel"><table><thead><tr><th>State</th><th>Step</th><th>Result</th><th>Runs</th><th>Time</th><th>Error</th></tr></thead><tbody>
    ${data.steps.map((s) => `<tr><td class="mono">${esc(s.state)}</td><td class="mono">${esc(s.name)}</td><td><span class="badge ${s.status === 'done' ? 'ok' : s.status === 'failed' ? 'bad' : 'warn'}">${esc(s.status)}</span></td>
      <td>${s.attempt > 1 ? `<span class="badge warn">${s.attempt}</span>` : '1'}</td><td class="muted">${s.duration_ms == null ? '' : `${(s.duration_ms / 1000).toFixed(1)}s`}</td><td class="error">${esc(s.error ?? '')}</td></tr>`).join('')}
    </tbody></table></div>`;
}

async function investigation(id, tab) {
  const data = await api(`/investigations/${id}`);
  const inv = data.investigation;
  const tabs = [['overview', 'Investigation'], ['patch', 'Patch review'], ['report', 'Report'], ['history', 'History']];
  const body = { overview, patch, report: reportView, history }[tab](data);
  app.innerHTML = `
    <div class="row"><h1 class="mono">${esc(short(inv.repo_url))}</h1>${statusBadge(inv, data.running)}
      ${inv.status === 'failed' && !data.running ? '<button id="resume" class="secondary right">Resume</button>' : ''}</div>
    <div class="muted">${esc(inv.repo_url)}${inv.commit_sha ? ` at <span class="mono">${esc(inv.commit_sha.slice(0, 10))}</span>` : ''}</div>
    ${data.report ? `<p class="headline">${esc(data.report.headline)}</p>` : ''}${timeline(data)}
    <nav class="tabs">${tabs.map(([key, label]) => `<a class="${key === tab ? 'on' : ''}" href="#/i/${id}/${key}">${label}</a>`).join('')}</nav>${body}`;
  const act = (elementId, path) => {
    const element = document.getElementById(elementId);
    if (!element) return;
    element.onclick = async () => {
      element.disabled = true;
      try { await api(`/investigations/${id}/${path}`, { method: 'POST', body: '{}' }); render(); }
      catch (err) { (document.getElementById('decisionError') ?? element).textContent = err.message; element.disabled = false; }
    };
  };
  act('approve', 'approve'); act('reject', 'reject'); act('resume', 'resume');
  if (data.running || inv.status === 'running') timer = setTimeout(render, 2000);
}

async function render() {
  clearTimeout(timer);
  const [, view, id, tab] = location.hash.replace(/^#/, '').split('/');
  try {
    if (view === 'i' && id) await investigation(id, ['overview', 'patch', 'report', 'history'].includes(tab) ? tab : 'overview');
    else await dashboard();
  } catch (err) {
    app.innerHTML = `<div class="panel error">${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', render);
render();
