import { repoDir } from '../agent/intake.ts';
import { buildReport, type Report } from '../agent/report.ts';
import type { Db } from '../state/db.ts';
import { Journal } from '../state/journal.ts';
import { openPullRequest, parseRepoUrl, pushBranch } from '../tools/github.ts';

export interface Approval {
  decision: 'approved' | 'rejected';
  decided_at: string;
  pr_url: string | null;
}

export class ApprovalError extends Error {}

export function getApproval(db: Db, investigationId: string): Approval | null {
  return (db.prepare('SELECT decision, decided_at, pr_url FROM approvals WHERE investigation_id = ?').get(investigationId) as Approval | undefined) ?? null;
}

function record(db: Db, investigationId: string, decision: Approval['decision'], prUrl: string | null): Approval {
  const decidedAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO approvals (investigation_id, decision, decided_at, pr_url) VALUES (?, ?, ?, ?) ON CONFLICT (investigation_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at, pr_url = excluded.pr_url',
  ).run(investigationId, decision, decidedAt, prUrl);
  new Journal(db).setStatus(investigationId, 'done');
  return { decision, decided_at: decidedAt, pr_url: prUrl };
}

/** The pull request description: what was proven and how, taken from the report. */
export function pullRequestBody(report: Report, pkg: string): string {
  const repair = report.repairs.find((r) => r.package === pkg);
  const findings = report.findings.filter((f) => f.package === pkg && f.kind !== 'unchecked');
  if (!repair) return '';
  const lines = [
    `Upgrades \`${pkg}\` from ${repair.from} to ${repair.to}${repair.attempts.length ? ' and adapts the code to it' : ''}.`,
    '',
    '## Why',
    ...findings.map((f) => `- **${f.kind}**: ${f.rationale}`),
    '',
    '## Proof',
    '| Test run | Result | Passed | Failed |',
    '|---|---|---|---|',
    ...repair.test_runs.map((t) => `| ${t.label.replace(/_/g, ' ')} | ${t.exit_code === 0 ? 'pass' : 'fail'} | ${t.passed ?? '-'} | ${t.failed ?? '-'} |`),
    '',
    ...(repair.verification ? ['Verification:', ...repair.verification.checks.map((c) => `- ${c.ok ? 'Passed' : 'FAILED'}: ${c.detail}`), ''] : []),
    ...(repair.attempts.filter((a) => a.outcome === 'tests_failed').length ? [`${repair.attempts.filter((a) => a.outcome === 'tests_failed').length} earlier attempt(s) failed their tests and were reverted before this one.`, ''] : []),
    '## Sources',
    ...[...new Set(findings.flatMap((f) => f.sources.filter((s) => s.read_from_source).map((s) => `- ${s.url}`)))].slice(0, 12),
    '',
    '## Remaining risk',
    ...report.remaining_risk.filter((r) => r.startsWith(`${pkg}:`)).map((r) => `- ${r.slice(pkg.length + 2)}`),
    '',
    'Opened by Veritas after human approval. Nothing was pushed before approval.',
  ];
  return lines.join('\n');
}

/**
 * Carries out a person's decision. Approval is the only point at which anything leaves the
 * workspace: each verified repair's branch is pushed and a pull request is opened for it.
 */
export async function decide(db: Db, investigationId: string, decision: Approval['decision'], githubToken: string | undefined = process.env.GITHUB_TOKEN): Promise<Approval> {
  const inv = new Journal(db).getInvestigation(investigationId);
  if (!inv) throw new ApprovalError('Unknown investigation');
  if (inv.status !== 'awaiting_approval') throw new ApprovalError(`Investigation is ${inv.status}, not awaiting approval`);
  if (decision === 'rejected') return record(db, investigationId, 'rejected', null);

  const report = buildReport(db, investigationId);
  const verified = report.repairs.filter((r) => r.status === 'verified');
  if (verified.length === 0) throw new ApprovalError('There is no verified fix to approve');

  const target = parseRepoUrl(inv.repo_url);
  if (!target) return record(db, investigationId, 'approved', null); // a local repository: the branches stay in the workspace
  const token = githubToken;
  if (!token) throw new ApprovalError('No GitHub access is available, so a pull request cannot be opened');

  const urls: string[] = [];
  for (const repair of verified) {
    await pushBranch(repoDir(investigationId), inv.repo_url, repair.branch, token);
    const pr = await openPullRequest(target.owner, target.repo, repair.branch, `Upgrade ${repair.package} to ${repair.to}${repair.attempts.length ? ' and adapt the code' : ''}`, pullRequestBody(report, repair.package), token);
    urls.push(pr.url);
  }
  return record(db, investigationId, 'approved', urls.join(' '));
}
