const app = document.getElementById('app');
const PHASES = [
  ['Understand', ['INTAKE', 'INVENTORY', 'INTEL']],
  ['Assess', ['IMPACT', 'PRIORITIZE']],
  ['Repair', ['PLAN_REPAIR', 'BASELINE', 'PATCH', 'TEST', 'DIAGNOSE', 'VERIFY']],
  ['Deliver', ['REPORT', 'AWAITING_APPROVAL']],
];
const STATE_WORDS = {
  INTAKE: 'Copy the repository', INVENTORY: 'List dependencies', INTEL: 'Read release notes and advisories', IMPACT: 'Find affected code', PRIORITIZE: 'Rank findings',
  PLAN_REPAIR: 'Plan repairs', BASELINE: 'Prove the break', PATCH: 'Write the fix', TEST: 'Run the tests', DIAGNOSE: 'Diagnose a failure', VERIFY: 'Verify the fix', REPORT: 'Write the report', AWAITING_APPROVAL: 'Wait for approval',
};
const STATUS_WORDS = { confirmed: 'Confirmed', potential: 'Potential', unresolved: 'Unresolved', not_affected: 'Not affected' };
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#10141b" stroke="#222a36"/><path d="M8 9l8 15 8-15" fill="none" stroke="#34d399" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GITHUB = '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z"/></svg>';
let me = null;
let timer = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (repo) => repo.replace(/^https:\/\/github\.com\//, '').replace(/^.*\/bench\/cases\//, 'benchmark/').replace(/\/repo$/, '');
const ago = (iso) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};

async function api(path, options = {}) {
  const token = localStorage.getItem('veritas-token');
  const res = await fetch(`/api${path}`, { ...options, headers: { 'content-type': 'application/json', ...(token ? { 'x-veritas-token': token } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { const err = new Error(body.error || 'Sign in to continue'); err.auth = true; throw err; }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function nav(inApp) {
  const right = me?.signed_in
    ? `${me.user ? `<span class="who">${me.user.avatar ? `<img src="${esc(me.user.avatar)}" alt="">` : ''}${esc(me.user.login)}</span><button class="btn ghost" id="signout">Sign out</button>` : '<button class="btn ghost" id="signout">Lock</button>'}`
    : '';
  return `<nav class="nav"><a class="logo" href="#/">${LOGO}Veritas</a>
    <div class="links">${inApp ? '<a href="#/app">Investigations</a>' : '<a href="#how">How it works</a><a href="#proof">Results</a><a href="#tools">Built with</a>'}<a href="https://github.com/Milliebanned/Veritas" target="_blank" rel="noreferrer">GitHub</a></div>
    <div class="right">${inApp && me ? `<span>${esc(me.model)} · ${esc(me.sandbox)} sandbox</span>` : ''}${me?.signed_in && !inApp ? '<a class="btn" href="#/app">Open app</a>' : ''}${right}</div></nav>`;
}

function bindNav() {
  const out = document.getElementById('signout');
  if (out) out.onclick = async () => { localStorage.removeItem('veritas-token'); await fetch('/auth/logout', { method: 'POST' }).catch(() => {}); me = null; location.hash = '#/'; render(); };
}

async function landing() {
  const pub = await fetch('/api/public').then((r) => r.json()).catch(() => ({ benchmark: null }));
  const b = pub.benchmark;
  const cta = me?.signed_in
    ? '<a class="btn big" href="#/app">Open your investigations</a>'
    : me?.mode === 'github'
      ? `<a class="btn big dark" href="/auth/github">${GITHUB} Sign in with GitHub</a>`
      : '<a class="btn big" href="#/app">Open the app</a>';
  const fine = me?.signed_in ? '' : me?.mode === 'github' ? 'Veritas asks for access to your public repositories so it can open a pull request when you approve a fix. It never pushes before you approve.' : me?.mode === 'token' ? 'This preview is protected by an access code.' : '';
  app.innerHTML = `${nav(false)}
    <section class="hero">
      <span class="eyebrow"><i></i>Built for neatHack with neatlogs, Entire and cfo.ai</span>
      <h1>Dependency tools send alerts.<br><em>Veritas sends proof.</em></h1>
      <p class="lede">Point Veritas at a JavaScript or TypeScript repository. It finds the upgrades and advisories that matter, proves whether they break your code, writes the fix, and tests it. You approve; it opens the pull request.</p>
      <div class="cta">${cta}<a class="btn big ghost" href="#how">See how it works</a></div>
      <p class="fine">${esc(fine)}</p>
      <div class="demo"><div class="bar"><i></i><i></i><i></i></div><div class="body">
        <div><span class="dim">repo</span>&nbsp; acme/items-api &nbsp;<span class="dim">express 4.22.3 → 5.3.0</span></div>
        <div><span class="ok">✓</span> read the release notes and the migration guide</div>
        <div><span class="ok">✓</span> found 4 call sites using removed APIs &nbsp;<span class="dim">src/app.js:16, src/routes/items.js:7, :8, :14</span></div>
        <div><span class="ok">✓</span> tests pass on 4.22.3 &nbsp;<span class="no">✗ fail on 5.3.0</span> &nbsp;<span class="dim">TypeError: app.del is not a function</span></div>
        <div><span class="ok">✓</span> wrote the fix on branch veritas/express</div>
        <div><span class="ok">✓</span> tests pass again, nothing regressed &nbsp;<span class="dim">3 passed, 0 failed</span></div>
        <div><span class="dim">→ waiting for your approval to open a pull request</span></div>
      </div></div>
    </section>
    <div class="wrap">
      <section class="band" id="how"><h2>Four questions, answered with evidence</h2><p class="sub">Every claim Veritas makes links to where it came from: a release note, an advisory, a line of your code, or a test run.</p>
        <div class="grid4">
          <div class="card"><div class="num">01</div><h3>What changed?</h3><p>Release notes, changelogs, migration guides and published advisories, each stored with its source.</p></div>
          <div class="card"><div class="num">02</div><h3>Does it affect you?</h3><p>The code graph finds where the package is used; the agent reads those files and gives a verdict per call site.</p></div>
          <div class="card"><div class="num">03</div><h3>What is the fix?</h3><p>The smallest change that works, written on a branch in a private copy of your repository.</p></div>
          <div class="card"><div class="num">04</div><h3>Does the fix work?</h3><p>Your own tests decide. They must fail after the upgrade and pass after the fix, with nothing else broken.</p></div>
        </div></section>
      <section class="band" id="proof"><h2>Measured, not claimed</h2><p class="sub">${b ? `Nine repositories with known answers, each fix judged by a held-out test the agent never sees. Run on ${esc(new Date(b.ran_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }))} with ${esc(b.model)}, tests inside Docker.` : 'Benchmark results will appear here.'}</p>
        ${b ? `<div class="grid4">
          <div class="card stat"><b>${b.verdicts_correct}/${b.cases}</b><span>verdicts correct</span></div>
          <div class="card stat"><b>${b.repair_success[0]}/${b.repair_success[1]}</b><span>fixes passing the held-out test</span></div>
          <div class="card stat"><b>${b.false_positives[0]}</b><span>false alarms on ${b.false_positives[1]} control repositories</span></div>
          <div class="card stat"><b>$${(b.cost_usd / b.cases).toFixed(2)}</b><span>average model cost per repository</span></div>
        </div>` : ''}</section>
      <section class="band"><h2>It says when it does not know</h2>
        <div class="grid3">
          <div class="card"><h3>Not affected is an answer</h3><p>If a breaking change does not touch your code, Veritas says so and leaves it alone.</p></div>
          <div class="card"><h3>Unresolved is an answer</h3><p>Three attempts, each diagnosed from the real test output. If none works, the report says what was tried.</p></div>
          <div class="card"><h3>Nothing leaves without you</h3><p>Fixes live in a private workspace. Only your approval pushes a branch and opens a pull request.</p></div>
        </div></section>
      <section class="band" id="tools"><h2>Built with</h2>
        <div class="grid3">
          <div class="card"><h3>neatlogs</h3><p>Every model call, tool call, retry and failure is traced. Two of the agent's own faults were found from flagged traces and fixed through pull requests neat AI opened.</p></div>
          <div class="card"><h3>Entire</h3><p>Checkpoints record the context behind each change to Veritas. Its code graph is how the agent finds where a package is used.</p></div>
          <div class="card"><h3>cfo.ai</h3><p>Where the business plan is made: pricing, costs and runway, starting from the measured cost of one investigation.</p></div>
        </div></section>
      <footer class="foot"><span>Veritas — Verified changes. Reliable software.</span><a href="https://github.com/Milliebanned/Veritas" target="_blank" rel="noreferrer">github.com/Milliebanned/Veritas</a></footer>
    </div>`;
  bindNav();
}

function gate(message) {
  app.innerHTML = `${nav(false)}<section class="hero"><h1 style="font-size:40px">Sign in to continue</h1>
    ${me?.mode === 'github' ? `<p class="lede">Connect your GitHub account to investigate your repositories.</p><div class="cta"><a class="btn big dark" href="/auth/github">${GITHUB} Sign in with GitHub</a></div>`
      : `<p class="lede">This preview is protected by an access code.</p><form class="gate" id="gate"><input class="field" id="code" type="password" placeholder="Access code" autocomplete="off"><button class="btn" type="submit">Continue</button></form>`}
    <p class="error">${esc(message ?? '')}</p></section>`;
  bindNav();
  const form = document.getElementById('gate');
  if (form) form.onsubmit = async (event) => { event.preventDefault(); localStorage.setItem('veritas-token', document.getElementById('code').value.trim()); me = await fetch('/api/me', { headers: { 'x-veritas-token': localStorage.getItem('veritas-token') } }).then((r) => r.json()); me.signed_in ? render() : gate('That code was not accepted.'); };
}

function statusChip(inv, running) {
  if (running || inv.status === 'running') return `<span class="chip warn"><span class="dot pulse"></span>${esc((STATE_WORDS[inv.current_state] ?? inv.current_state).toLowerCase())}</span>`;
  if (inv.status === 'failed') return '<span class="chip bad">stopped</span>';
  if (inv.status === 'awaiting_approval') return '<span class="chip warn">awaiting approval</span>';
  return '<span class="chip ok">done</span>';
}
const verdictChip = (v) => ({ fixes_ready: '<span class="chip ok">fix ready</span>', nothing_to_do: '<span class="chip">nothing to do</span>', needs_attention: '<span class="chip warn">needs attention</span>' })[v] ?? '';
const findingChip = (s) => `<span class="chip ${s === 'confirmed' ? 'bad' : s === 'not_affected' ? 'ok' : 'warn'}">${esc(STATUS_WORDS[s] ?? s)}</span>`;

async function dashboard() {
  const [list, repos, examples] = await Promise.all([api('/investigations'), api('/repos').catch(() => []), api('/examples').catch(() => [])]);
  const options = [
    ...repos.map((r) => `<option value="${esc(r.url)}">${esc(r.full_name)}</option>`),
    ...(examples.length ? [`<optgroup label="Benchmark repositories">${examples.map((e) => `<option value="${esc(e.path)}">${esc(e.name)}</option>`).join('')}</optgroup>`] : []),
  ].join('');
  const quota = me.daily_limit != null && !me.admin ? `<p class="muted" style="margin-top:8px;font-size:13px">${Math.max(0, me.daily_limit - (me.used_today ?? 0))} of ${me.daily_limit} investigations left today.</p>` : '';
  app.innerHTML = `${nav(true)}<main class="page">
    <div class="page-head"><div><h1>Investigations</h1><p>Each one takes a repository from "what changed" to a tested fix waiting for your approval.</p></div></div>
    <form class="composer" id="new">
      ${options ? `<select class="field" id="pick"><option value="">${repos.length ? 'Choose one of your repositories…' : 'Choose a repository…'}</option>${options}</select>` : ''}
      <input class="field" id="repo" type="text" placeholder="or paste https://github.com/owner/repo" autocomplete="off">
      <button class="btn" type="submit">Investigate</button>
    </form>${quota}<div id="formError" class="error"></div>
    ${list.length ? `<div class="cards">${list.map((i) => `<a class="inv" href="#/i/${i.id}">
        <div class="top"><span class="name">${esc(short(i.repo_url))}</span>${statusChip(i, i.running)}</div>
        <div class="line">${i.summary ? `${verdictChip(i.summary.verdict)} ${esc(i.summary.headline)}` : i.status === 'failed' ? 'Stopped before finishing. Open it to resume.' : 'Working…'}</div>
        <div class="meta"><span>${esc(ago(i.started_at))}</span>${i.summary?.packages?.length ? `<span class="mono">${i.summary.packages.map(esc).join(', ')}</span>` : ''}${i.approval ? `<span>${esc(i.approval.decision)}</span>` : ''}</div></a>`).join('')}</div>`
      : '<div class="empty">No investigations yet. Choose a repository above to start the first one.</div>'}</main>`;
  bindNav();
  const pick = document.getElementById('pick');
  if (pick) pick.onchange = () => { document.getElementById('repo').value = pick.value; };
  document.getElementById('new').onsubmit = async (event) => {
    event.preventDefault();
    try { const { id } = await api('/investigations', { method: 'POST', body: JSON.stringify({ repo: document.getElementById('repo').value }) }); location.hash = `#/i/${id}`; }
    catch (err) { document.getElementById('formError').textContent = err.message; }
  };
  if (list.some((i) => i.running)) timer = setTimeout(render, 3000);
}

function phases(data) {
  const reached = new Set(data.steps.map((s) => s.state));
  const current = data.investigation.current_state;
  return `<div class="phases">${PHASES.map(([name, states]) => `<div class="phase"><h4>${name}</h4>${states.map((s) => {
    const isNow = s === current;
    const cls = isNow ? (data.investigation.status === 'failed' ? 'failed' : data.running ? 'now' : 'done') : reached.has(s) ? 'done' : '';
    return `<div class="step ${cls}"><i>${cls === 'done' ? '✓' : cls === 'failed' ? '!' : ''}</i>${STATE_WORDS[s]}</div>`;
  }).join('')}</div>`).join('')}</div>`;
}

function diffHtml(diff) {
  return `<pre class="diff">${diff.trim().split('\n').map((line) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---') ? 'file' : '';
    return `<span class="${cls}">${esc(line) || ' '}</span>`;
  }).join('\n')}</pre>`;
}

function overview(data) {
  const r = data.report;
  if (!r) return '<div class="panel muted">Working. Findings appear here as the investigation progresses.</div>';
  if (!r.findings.length) return '<div class="panel">No dependency change that matters was found in this repository.</div>';
  return r.findings.map((f) => `<div class="panel"><h3><span class="mono">${esc(f.package)}</span><span class="chip">${esc(f.kind)}</span>${findingChip(f.status)}${f.priority != null ? `<span class="chip">priority ${f.priority}</span>` : ''}</h3>
    <p>${esc(f.rationale)}</p>
    ${f.affected.length ? `<h4>Where</h4><div class="files">${f.affected.map((a) => `${esc(a.file)}${a.line ? `:${a.line}` : ''}${a.symbol ? ` <span class="muted">in ${esc(a.symbol)}</span>` : ''}`).join('<br>')}</div>` : ''}
    ${f.sources.length ? `<h4>Sources read</h4><ul class="sources">${f.sources.filter((s) => s.read_from_source).map((s) => `<li>${esc(s.kind.replace(/_/g, ' '))}: <a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url)}</a></li>`).join('')}</ul>` : ''}</div>`).join('');
}

function patch(data) {
  const r = data.report;
  if (!r || !r.repairs.length) return '<div class="panel muted">No repair was needed or attempted.</div>';
  const canDecide = data.investigation.status === 'awaiting_approval' && !data.approval;
  const anyVerified = r.repairs.some((x) => x.status === 'verified');
  const decision = data.approval
    ? `<div class="panel"><h3>${data.approval.decision === 'approved' ? '<span class="chip ok">Approved</span>' : '<span class="chip">Rejected</span>'} <span class="muted" style="font-weight:400;font-size:13px">${esc(ago(data.approval.decided_at))}</span></h3>
        ${data.approval.pr_url ? `<p>Pull request opened:</p><ul class="sources">${data.approval.pr_url.split(' ').map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u)}</a></li>`).join('')}</ul>` : data.approval.decision === 'approved' ? '<p>This repository is not on GitHub, so the fix stays on its branch in the workspace.</p>' : ''}</div>`
    : canDecide ? `<div class="panel decide"><div><h3>${anyVerified ? 'Ready for your decision' : 'Nothing to approve'}</h3><p>${anyVerified ? 'Nothing has left the workspace. Approving opens a pull request for each verified fix.' : 'No fix passed verification.'}</p><div id="decisionError" class="error"></div></div>
        <div class="actions"><button id="reject" class="btn danger">Reject</button><button id="approve" class="btn" ${anyVerified ? '' : 'disabled'}>Approve and open pull request</button></div></div>` : '';
  return decision + r.repairs.map((x) => `<div class="panel">
    <h3><span class="mono">${esc(x.package)} ${esc(x.from)} → ${esc(x.to)}</span><span class="chip ${x.status === 'verified' ? 'ok' : x.status === 'unresolved' ? 'bad' : 'warn'}">${esc(x.status.replace(/_/g, ' '))}</span></h3>
    <p>${esc(x.note ?? '')}</p>
    <h4>Test runs</h4><table><thead><tr><th>When</th><th>Result</th><th>Passed</th><th>Failed</th></tr></thead><tbody>
      ${x.test_runs.map((t) => `<tr><td>${esc(t.label.replace(/_/g, ' '))}</td><td>${t.exit_code === 0 ? '<span class="chip ok">pass</span>' : '<span class="chip bad">fail</span>'}</td><td>${t.passed ?? '–'}</td><td>${t.failed ?? '–'}</td></tr>`).join('')}</tbody></table>
    ${x.verification ? `<h4>Verification</h4><div class="checks">${x.verification.checks.map((c) => `<div class="check ${c.ok ? '' : 'no'}"><i>${c.ok ? '✓' : '✗'}</i><span>${esc(c.detail)}</span></div>`).join('')}</div>${x.verification.caveats.map((c) => `<p class="muted" style="font-size:13px">Note: ${esc(c)}</p>`).join('')}` : ''}
    ${x.attempts.map((a) => `<h4>Attempt ${a.n} · ${a.outcome === 'tests_passed' ? 'tests passed' : 'tests failed'}</h4><p>${esc(a.plan ?? '')}</p>${a.diagnosis ? `<p><span class="muted">Diagnosis after the failure:</span> ${esc(a.diagnosis)}</p>` : ''}${a.diff ? diffHtml(a.diff) : ''}`).join('')}
    ${x.functions_changed.length ? `<p class="muted" style="font-size:13px">Functions changed: <span class="mono">${x.functions_changed.map(esc).join(', ')}</span></p>` : ''}</div>`).join('');
}

function reportView(data) {
  const r = data.report;
  if (!r) return '<div class="panel muted">The report is written when the investigation finishes.</div>';
  const list = (title, items) => (items.length ? `<div class="panel"><h3>${title}</h3><ul>${items.map((i) => `<li>${esc(i.split('\n')[0])}</li>`).join('')}</ul></div>` : '');
  return `<div class="panel"><h3>Summary <a class="btn ghost" style="margin-left:auto;padding:6px 12px;font-size:13px" href="/api/investigations/${data.investigation.id}/report.md" target="_blank">Open as Markdown</a></h3>
      <table style="margin-top:10px"><tbody><tr><td>Findings</td><td>${r.counts.findings}</td></tr><tr><td>Verified fixes</td><td>${r.counts.verified}</td></tr><tr><td>Unresolved</td><td>${r.counts.unresolved}</td></tr>
      <tr><td>Not affected</td><td>${r.counts.not_affected}</td></tr><tr><td>Potential, not proven</td><td>${r.counts.potential}</td></tr><tr><td>Could not be checked</td><td>${r.counts.unchecked}</td></tr></tbody></table></div>
    ${list('Remaining risk', r.remaining_risk)}${list('Could not check', r.could_not_check)}`;
}

function history(data) {
  return `<div class="panel"><table><thead><tr><th>Stage</th><th>Step</th><th>Result</th><th>Runs</th><th>Time</th><th></th></tr></thead><tbody>
    ${data.steps.map((s) => `<tr><td>${esc(STATE_WORDS[s.state] ?? s.state)}</td><td class="mono">${esc(s.name)}</td><td><span class="chip ${s.status === 'done' ? 'ok' : s.status === 'failed' ? 'bad' : 'warn'}">${esc(s.status)}</span></td>
      <td>${s.attempt > 1 ? `<span class="chip warn">${s.attempt}</span>` : '1'}</td><td class="muted">${s.duration_ms == null ? '' : `${(s.duration_ms / 1000).toFixed(1)}s`}</td><td class="error" style="margin:0">${esc(s.error ?? '')}</td></tr>`).join('')}
    </tbody></table></div>`;
}

async function investigation(id, tab) {
  const data = await api(`/investigations/${id}`);
  const inv = data.investigation;
  const r = data.report;
  const u = data.usage;
  const tabs = [['overview', 'Findings'], ['patch', 'Patch review'], ['report', 'Report'], ['history', 'History']];
  const body = { overview, patch, report: reportView, history }[tab](data);
  const finished = inv.status === 'awaiting_approval' || inv.status === 'done';
  app.innerHTML = `${nav(true)}<main class="page">
    <a class="crumb" href="#/app">← All investigations</a>
    <div class="title"><h1>${esc(short(inv.repo_url))}</h1>${statusChip(inv, data.running)}${inv.status === 'failed' && !data.running ? '<button id="resume" class="btn ghost" style="margin-left:auto">Resume</button>' : ''}</div>
    <div class="subtitle">${esc(inv.repo_url)}${inv.commit_sha ? ` at ${esc(inv.commit_sha.slice(0, 10))}` : ''} · started ${esc(ago(inv.started_at))}</div>
    ${r && finished ? `<div class="verdict ${r.verdict === 'fixes_ready' ? 'ok' : r.verdict === 'needs_attention' ? 'warn' : ''}">${esc(r.headline)}</div>` : ''}
    <div class="stats">
      <div class="card"><b>${r ? r.counts.findings : '–'}</b><span>findings</span></div>
      <div class="card"><b>${r ? r.counts.verified : '–'}</b><span>verified fixes</span></div>
      <div class="card"><b>${r ? r.counts.unresolved + r.counts.unchecked : '–'}</b><span>unresolved or unchecked</span></div>
      <div class="card"><b>${u.calls}</b><span>model calls</span></div>
      <div class="card"><b>$${Number(u.costUsd).toFixed(2)}</b><span>model cost</span></div>
    </div>
    ${phases(data)}
    <nav class="tabs">${tabs.map(([key, label]) => `<a class="${key === tab ? 'on' : ''}" href="#/i/${id}/${key}">${label}</a>`).join('')}</nav>${body}</main>`;
  bindNav();
  const act = (elementId, path, busy) => {
    const element = document.getElementById(elementId);
    if (!element) return;
    element.onclick = async () => {
      element.disabled = true; const label = element.textContent; element.textContent = busy;
      try { await api(`/investigations/${id}/${path}`, { method: 'POST', body: '{}' }); render(); }
      catch (err) { (document.getElementById('decisionError') ?? element).textContent = err.message; element.disabled = false; element.textContent = label; }
    };
  };
  act('approve', 'approve', 'Opening pull request…'); act('reject', 'reject', 'Rejecting…'); act('resume', 'resume', 'Resuming…');
  if (data.running || inv.status === 'running') timer = setTimeout(render, 2000);
}

async function render() {
  clearTimeout(timer);
  const [, view, id, tab] = location.hash.replace(/^#/, '').split('/');
  try {
    const token = localStorage.getItem('veritas-token');
    me = await fetch('/api/me', { headers: token ? { 'x-veritas-token': token } : {} }).then((r) => r.json());
    if (view !== 'app' && view !== 'i') return await landing();
    if (!me.signed_in) return gate();
    if (view === 'i' && id) await investigation(id, ['overview', 'patch', 'report', 'history'].includes(tab) ? tab : 'overview');
    else await dashboard();
  } catch (err) {
    if (err.auth) return gate(err.message);
    app.innerHTML = `${nav(true)}<main class="page"><div class="panel error">${esc(err.message)}</div></main>`;
  }
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
render();
