// Runs Veritas on every benchmark case and scores it against the case's ground truth.
// The held-out acceptance test is applied only after the agent has finished.
//
// Usage: npx tsx bench/run.mts <tag> [case-id ...]
//   <tag> names the result file: evidence/bench/<tag>.json
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { handlers } from '../src/agent/handlers.ts';
import { repoDir } from '../src/agent/intake.ts';
import { Orchestrator } from '../src/agent/orchestrator.ts';
import { activeModel, usageFor } from '../src/llm/client.ts';
import { initTracing, shutdownTracing } from '../src/observability/neatlogs.ts';
import { openDb } from '../src/state/db.ts';
import { Journal } from '../src/state/journal.ts';
import { Records } from '../src/state/records.ts';
import { git } from '../src/tools/git.ts';
import { selectSandbox } from '../src/tools/sandbox.ts';

interface CaseSpec {
  id: string;
  type: 'breaking' | 'advisory' | 'control';
  package: string;
  expected: { verdict: 'affected' | 'not_affected' | 'no_finding'; finding_kind: string; fixable: boolean; affected_files: string[] };
}

const benchDir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(benchDir, 'cases');
const [tag, ...only] = process.argv.slice(2);
if (!tag) throw new Error('Usage: npx tsx bench/run.mts <tag> [case-id ...]');
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.VERITAS_RELEASE ??= tag;

const ids = (only.length ? only : readdirSync(casesDir).filter((d) => existsSync(join(casesDir, d, 'case.yaml')))).sort();
await initTracing();
const db = openDb();
const journal = new Journal(db);
const records = new Records(db);
const sandbox = selectSandbox();
async function runCase(id: string) {
  const spec = parse(readFileSync(join(casesDir, id, 'case.yaml'), 'utf8')) as CaseSpec;
  const orchestrator = new Orchestrator({ db, handlers });
  const started = Date.now();
  const inv = orchestrator.start(join(casesDir, id, 'repo'));
  let crashed: string | null = null;
  try {
    await orchestrator.run(inv.id);
  } catch (err) {
    crashed = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Date.now() - started;

  const findings = records.findings(inv.id).filter((f) => f.package === spec.package);
  const main = findings.find((f) => f.kind === (spec.expected.finding_kind === 'none' ? 'breaking' : spec.expected.finding_kind));
  // A package the agent could not examine is its own outcome: wrong for scoring, but not a claim that nothing is there.
  const verdict = findings.some((f) => f.kind === 'unchecked') ? 'unchecked' : !main ? 'no_finding' : main.status === 'not_affected' ? 'not_affected' : 'affected';
  const reported = [...new Set(records.affectedSites(inv.id).filter((s) => s.finding_id === main?.id).map((s) => s.file))].sort();
  const expected = [...spec.expected.affected_files].sort();
  const repair = records.repairs(inv.id).find((r) => r.package === spec.package);

  // Held-out acceptance: on the repair branch when the agent produced one, otherwise on the untouched project.
  const dir = repoDir(inv.id);
  let acceptance: 'pass' | 'fail' | 'not_run' = 'not_run';
  if (!crashed && existsSync(dir)) {
    if (repair?.status === 'verified') git(dir, 'checkout', '--quiet', '--force', repair.branch);
    await sandbox({ cwd: dir, command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], timeoutMs: 300_000, network: true });
    cpSync(join(casesDir, id, 'acceptance'), join(dir, 'acceptance'), { recursive: true });
    const run = await sandbox({ cwd: dir, command: 'node', args: ['--test', 'acceptance/**/*.test.js'], timeoutMs: 300_000, network: false });
    acceptance = run.exitCode === 0 ? 'pass' : 'fail';
  }

  const steps = journal.steps(inv.id);
  const attempts = records.attempts(inv.id);
  const usage = usageFor(db, inv.id);
  const result = {
    case: id,
    type: spec.type,
    investigation: inv.id,
    crashed,
    expected_verdict: spec.expected.verdict,
    verdict,
    verdict_correct: verdict === spec.expected.verdict,
    findings: records.findings(inv.id).map((f) => ({ package: f.package, kind: f.kind, status: f.status, priority: f.priority, sources: records.sourcesFor(f.id).filter((s) => s.verified).length })),
    expected_files: expected,
    reported_files: reported,
    files_true_positive: reported.filter((f) => expected.includes(f)).length,
    fixable: spec.expected.fixable,
    repair: repair ? { status: repair.status, attempts: repair.attempts, target: repair.target_version, note: repair.note } : null,
    failed_attempts: attempts.filter((a) => a.outcome === 'tests_failed').length,
    acceptance,
    repaired: spec.expected.fixable ? repair?.status === 'verified' && acceptance === 'pass' : null,
    test_runs: records.testRuns(inv.id).map((t) => ({ label: t.label, exit_code: t.exit_code, passed: t.passed, failed: t.failed })),
    steps: steps.length,
    steps_run_more_than_once: steps.filter((s) => s.attempt > 1).length,
    duration_ms: durationMs,
    llm_calls: usage.calls,
    tokens: usage.promptTokens + usage.completionTokens,
    cost_usd: Number(usage.costUsd.toFixed(4)),
  };
  const fix = result.repaired === null ? '-' : result.repaired ? `fixed in ${repair?.attempts} attempt(s)` : `NOT fixed (${repair?.status ?? 'no repair'}, acceptance ${acceptance})`;
  console.log(`${result.verdict_correct ? 'ok ' : 'BAD'} ${id.padEnd(26)} ${verdict.padEnd(12)} files ${result.files_true_positive}/${reported.length} of ${expected.length}  ${fix.padEnd(44)} ${(durationMs / 1000).toFixed(0)}s  $${result.cost_usd}${crashed ? `  CRASHED: ${crashed}` : ''}`);
  return result;
}

const results: Awaited<ReturnType<typeof runCase>>[] = [];
for (const id of ids) results.push(await runCase(id));

const sum = (pick: (r: (typeof results)[number]) => number) => results.reduce((a, r) => a + pick(r), 0);
const fixable = results.filter((r) => r.fixable);
const withFailure = fixable.filter((r) => r.failed_attempts > 0);
const controls = results.filter((r) => r.type === 'control');
const allFindings = results.flatMap((r) => r.findings);
const testRuns = results.flatMap((r) => r.test_runs);
const summary = {
  tag,
  ran_at: new Date().toISOString(),
  model: activeModel(),
  node: process.version,
  sandbox: process.env.VERITAS_SANDBOX ?? 'docker',
  cases: results.length,
  verdicts_correct: results.filter((r) => r.verdict_correct).length,
  evidence_backed_findings: [allFindings.filter((f) => f.sources > 0).length, allFindings.length],
  affected_file_precision: [sum((r) => r.files_true_positive), sum((r) => r.reported_files.length)],
  affected_file_recall: [sum((r) => r.files_true_positive), sum((r) => r.expected_files.length)],
  repair_success: [fixable.filter((r) => r.repaired).length, fixable.length],
  fixed_on_first_attempt: fixable.filter((r) => r.repaired && r.repair?.attempts !== undefined && r.repair.attempts <= 1).length,
  recovery: [withFailure.filter((r) => r.repaired).length, withFailure.length],
  test_runs_completed: [testRuns.filter((t) => t.exit_code !== null).length, testRuns.length],
  false_positives_on_controls: [controls.filter((r) => !r.verdict_correct).length, controls.length],
  steps_run_more_than_once: sum((r) => r.steps_run_more_than_once),
  crashes: results.filter((r) => r.crashed).length,
  total_duration_s: Math.round(sum((r) => r.duration_ms) / 1000),
  llm_calls: sum((r) => r.llm_calls),
  tokens: sum((r) => r.tokens),
  cost_usd: Number(sum((r) => r.cost_usd).toFixed(4)),
};
console.log(`\n${JSON.stringify(summary, null, 1)}`);
const out = join(benchDir, '..', 'evidence', 'bench', `${tag}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(`\nwrote ${out}`);
const delivery = await shutdownTracing();
if (delivery && !delivery.delivered) console.error('neatlogs: traces were not fully delivered');
