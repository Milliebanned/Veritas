import { usageFor } from '../llm/client.ts';
import { note, traceOutput, traced } from '../observability/neatlogs.ts';
import type { Db } from '../state/db.ts';
import { Journal } from '../state/journal.ts';
import { Records, type FindingRecord, type RepairRecord } from '../state/records.ts';
import type { IntelSummary } from './intel.ts';
import type { PatchResult, Verification } from './repair.ts';
import type { StateHandler } from './states.ts';

export type Verdict = 'fixes_ready' | 'nothing_to_do' | 'needs_attention';

export interface Report {
  investigation: { id: string; repo: string; commit: string | null; started_at: string };
  verdict: Verdict;
  headline: string;
  counts: { findings: number; verified: number; unresolved: number; unchecked: number; not_affected: number; potential: number };
  findings: {
    package: string;
    kind: string;
    status: string;
    priority: number | null;
    rationale: string;
    affected: { file: string; line: number | null; symbol: string | null }[];
    sources: { url: string; kind: string; read_from_source: boolean }[];
  }[];
  repairs: {
    package: string;
    from: string;
    to: string;
    status: string;
    branch: string;
    note: string | null;
    test_runs: { label: string; exit_code: number | null; passed: number | null; failed: number | null }[];
    attempts: { n: number; outcome: string | null; plan: string | null; diagnosis: string | null; diff: string | null }[];
    files_changed: string[];
    functions_changed: string[];
    verification: Verification | null;
  }[];
  could_not_check: string[];
  remaining_risk: string[];
  usage: { model_calls: number; tokens: number; cost_usd: number; steps: number };
}

const STATUS_WORDS: Record<string, string> = {
  confirmed: 'Confirmed',
  potential: 'Potential (not proven)',
  unresolved: 'Unresolved',
  not_affected: 'Not affected',
};

/** Everything an investigation established, assembled from the journal and records. No model is involved. */
export function buildReport(db: Db, investigationId: string): Report {
  const journal = new Journal(db);
  const records = new Records(db);
  const inv = journal.getInvestigation(investigationId);
  if (!inv) throw new Error(`Unknown investigation ${investigationId}`);

  const findings = records.findings(investigationId);
  const sites = records.affectedSites(investigationId);
  const repairs = records.repairs(investigationId);
  const attempts = records.attempts(investigationId);
  const runs = records.testRuns(investigationId);
  const steps = journal.steps(investigationId);
  const usage = usageFor(db, investigationId);
  const intel = journal.output<IntelSummary>(investigationId, 'INTEL', 'candidates');

  const outputs = <T>(state: string, name: string) =>
    steps.filter((s) => s.state === state && s.name === name && s.status === 'done').map((s) => ({ input: JSON.parse(s.input_json ?? 'null') as { repair?: number }, output: JSON.parse(s.output_json ?? 'null') as T }));
  const patches = outputs<PatchResult>('PATCH', 'patch');
  const verifications = outputs<Verification>('VERIFY', 'verify');

  const reportRepairs = repairs.map((r: RepairRecord) => {
    const ids = JSON.parse(r.finding_ids) as string[];
    const lastPatch = patches.filter((p) => p.input.repair === r.id).at(-1)?.output;
    return {
      package: r.package,
      from: r.from_version,
      to: r.target_version,
      status: r.status,
      branch: r.branch,
      note: r.note,
      test_runs: runs.filter((t) => t.label.startsWith(`${r.package}:`)).map((t) => ({ label: t.label.slice(r.package.length + 1), exit_code: t.exit_code, passed: t.passed, failed: t.failed })),
      attempts: attempts.filter((a) => ids.includes(a.finding_id)).map((a) => ({ n: a.n, outcome: a.outcome, plan: a.plan_text, diagnosis: a.diagnosis_text, diff: a.diff })),
      files_changed: r.status === 'verified' ? (lastPatch?.files ?? []) : [],
      functions_changed: r.status === 'verified' ? (lastPatch?.entities ?? []).filter((e) => e.name).map((e) => `${e.name} (${e.file})`) : [],
      verification: verifications.filter((v) => v.input.repair === r.id).at(-1)?.output ?? null,
    };
  });

  const count = (pred: (f: FindingRecord) => boolean) => findings.filter(pred).length;
  const verifiedPackages = new Set(repairs.filter((r) => r.status === 'verified').map((r) => r.package));
  const counts = {
    findings: findings.length,
    verified: count((f) => verifiedPackages.has(f.package) && f.status === 'confirmed'),
    unresolved: count((f) => f.status === 'unresolved' && f.kind !== 'unchecked'),
    unchecked: count((f) => f.kind === 'unchecked'),
    not_affected: count((f) => f.status === 'not_affected'),
    potential: count((f) => f.status === 'potential'),
  };

  const verdict: Verdict = counts.unresolved || counts.unchecked ? 'needs_attention' : verifiedPackages.size ? 'fixes_ready' : counts.potential ? 'needs_attention' : 'nothing_to_do';
  const headline =
    verdict === 'nothing_to_do'
      ? findings.length
        ? 'Dependency changes were found, and none of them affects this repository.'
        : 'No dependency change that matters was found.'
      : [
          verifiedPackages.size ? `${verifiedPackages.size} verified fix${verifiedPackages.size === 1 ? '' : 'es'} ready for review (${[...verifiedPackages].join(', ')})` : null,
          counts.unresolved ? `${counts.unresolved} finding${counts.unresolved === 1 ? '' : 's'} unresolved` : null,
          counts.unchecked ? `${counts.unchecked} package${counts.unchecked === 1 ? '' : 's'} could not be checked` : null,
          counts.potential ? `${counts.potential} potential finding${counts.potential === 1 ? '' : 's'} not proven` : null,
        ]
          .filter(Boolean)
          .join('; ') + '.';

  const risk: string[] = [];
  for (const r of reportRepairs) {
    if (r.status === 'verified') {
      risk.push(`${r.package}: verified by the project's own tests only. Behaviour the tests do not cover was not checked.`);
      for (const c of r.verification?.caveats ?? []) risk.push(`${r.package}: ${c}`);
    }
    if (r.status === 'unresolved') risk.push(`${r.package}: no working fix was found. ${r.note ?? ''}`.trim());
    if (r.status === 'not_reproduced') risk.push(`${r.package}: impact analysis expected a break, but the tests still pass after the upgrade. The affected code may be untested.`);
  }
  for (const f of findings.filter((x) => x.kind === 'deprecation')) risk.push(`${f.package}: the installed version is deprecated in the npm registry.`);
  if (intel?.unavailable.length) risk.push('Some sources could not be reached, so findings may be incomplete (see "Could not check").');

  return {
    investigation: { id: inv.id, repo: inv.repo_url, commit: inv.commit_sha, started_at: inv.started_at },
    verdict,
    headline,
    counts,
    findings: findings.map((f) => ({
      package: f.package,
      kind: f.kind,
      status: f.status,
      priority: f.priority,
      rationale: f.rationale,
      affected: sites.filter((s) => s.finding_id === f.id).map((s) => ({ file: s.file, line: s.line, symbol: s.symbol })),
      sources: records.sourcesFor(f.id).map((s) => ({ url: s.url, kind: s.kind, read_from_source: s.verified === 1 })),
    })),
    repairs: reportRepairs,
    could_not_check: intel?.unavailable ?? [],
    remaining_risk: risk,
    usage: { model_calls: usage.calls, tokens: usage.promptTokens + usage.completionTokens, cost_usd: Number(usage.costUsd.toFixed(4)), steps: steps.length },
  };
}

const runWord = (exit: number | null) => (exit === 0 ? 'pass' : exit === null ? 'did not finish' : 'fail');

export function renderMarkdown(report: Report): string {
  const out: string[] = [];
  out.push(`# Veritas report`, '', `**${report.headline}**`, '', `Repository: \`${report.investigation.repo}\`${report.investigation.commit ? ` at \`${report.investigation.commit.slice(0, 10)}\`` : ''}`, '');

  if (report.findings.length) {
    out.push('## Findings', '', '| Package | Kind | Status | Priority | Affected files |', '|---|---|---|---|---|');
    for (const f of report.findings) {
      const files = [...new Set(f.affected.map((a) => a.file))];
      out.push(`| ${f.package} | ${f.kind} | ${STATUS_WORDS[f.status] ?? f.status} | ${f.priority ?? '-'} | ${files.join(', ') || '-'} |`);
    }
    out.push('');
    for (const f of report.findings) {
      out.push(`### ${f.package}: ${f.kind}`, '', f.rationale, '');
      if (f.affected.length) out.push('Where:', ...f.affected.map((a) => `- \`${a.file}${a.line ? `:${a.line}` : ''}\`${a.symbol ? ` in \`${a.symbol}\`` : ''}`), '');
      const read = f.sources.filter((s) => s.read_from_source);
      const inferred = f.sources.filter((s) => !s.read_from_source);
      if (read.length) out.push('Sources read:', ...read.map((s) => `- ${s.kind}: ${s.url}`), '');
      if (inferred.length) out.push('Inferred, not read from a source:', ...inferred.map((s) => `- ${s.kind}: ${s.url}`), '');
    }
  }

  for (const r of report.repairs) {
    out.push(`## Repair: ${r.package} ${r.from} → ${r.to}`, '', `Outcome: **${r.status.replace('_', ' ')}**. ${r.note ?? ''}`.trim(), '', `Branch: \`${r.branch}\``, '');
    if (r.test_runs.length) {
      out.push('| Test run | Result | Passed | Failed |', '|---|---|---|---|', ...r.test_runs.map((t) => `| ${t.label.replace(/_/g, ' ')} | ${runWord(t.exit_code)} | ${t.passed ?? '-'} | ${t.failed ?? '-'} |`), '');
    }
    if (r.verification) {
      out.push('Verification:', ...r.verification.checks.map((c) => `- ${c.ok ? 'Passed' : 'FAILED'}: ${c.detail}`), '');
    }
    for (const a of r.attempts) {
      out.push(`### Attempt ${a.n}: ${a.outcome === 'tests_passed' ? 'tests passed' : a.outcome === 'tests_failed' ? 'tests failed' : (a.outcome ?? 'no outcome recorded')}`, '');
      if (a.plan) out.push(a.plan, '');
      if (a.diagnosis) out.push(`Diagnosis after the failure: ${a.diagnosis}`, '');
      if (a.diff) out.push('```diff', a.diff.trim(), '```', '');
    }
    if (r.functions_changed.length) out.push(`Functions changed: ${r.functions_changed.join(', ')}`, '');
  }

  if (report.could_not_check.length) out.push('## Could not check', '', ...report.could_not_check.map((c) => `- ${c.split('\n')[0]}`), '');
  if (report.remaining_risk.length) out.push('## Remaining risk', '', ...report.remaining_risk.map((r) => `- ${r}`), '');
  out.push('## Run', '', `${report.usage.steps} steps, ${report.usage.model_calls} model calls, ${report.usage.tokens} tokens, $${report.usage.cost_usd}.`, '');
  return out.join('\n');
}

/** Writes the report and stops for a person: nothing leaves the workspace until someone approves. */
export const report: StateHandler = async (ctx) => {
  await ctx.step('report', { findings: new Records(ctx.db).findings(ctx.investigationId).map((f) => [f.id, f.status]), repairs: new Records(ctx.db).repairs(ctx.investigationId).map((r) => [r.id, r.status]) }, () =>
    traced('tool.write_report', 'TOOL', {}, (set) => {
      const built = buildReport(ctx.db, ctx.investigationId);
      const markdown = renderMarkdown(built);
      ctx.db
        .prepare('INSERT INTO reports (investigation_id, markdown, json, verdict) VALUES (?, ?, ?, ?) ON CONFLICT (investigation_id) DO UPDATE SET markdown = excluded.markdown, json = excluded.json, verdict = excluded.verdict')
        .run(ctx.investigationId, markdown, JSON.stringify(built), built.verdict);
      set({ verdict: built.verdict, verified: built.counts.verified, unresolved: built.counts.unresolved, unchecked: built.counts.unchecked });
      note('report: {headline}', { headline: built.headline });
      traceOutput({ verdict: built.verdict, headline: built.headline, counts: built.counts });
      return { verdict: built.verdict, headline: built.headline, counts: built.counts };
    }),
  );
  return 'AWAITING_APPROVAL';
};
