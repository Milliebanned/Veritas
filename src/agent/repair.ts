import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createChat, type Chat } from '../llm/client.ts';
import { runToolLoop, type LoopTool } from '../llm/loop.ts';
import { loadPrompt, type PromptName } from '../llm/prompts.ts';
import { guarded, note, traced, type SetAttrs } from '../observability/neatlogs.ts';
import { Records, type FindingRecord, type RepairRecord } from '../state/records.ts';
import { applyEdit } from '../tools/fileEdit.ts';
import { changedFiles, commitAll, diffBetween, git, resetTo, startBranch } from '../tools/git.ts';
import { graphDiff, graphExplain, graphRecordBaseline, graphVerify, type EntityChange, type Verdict } from '../tools/graph.ts';
import { dockerArgs, scrubbedEnv, selectSandbox, type Sandbox } from '../tools/sandbox.ts';
import { runInstall, runTests, type TestRun } from '../tools/testRunner.ts';
import { callersTool, describeRuntime, graphProvider, readFileTool, searchTool, type ImpactProvider } from './impact.ts';
import { repoDir, workspaceRoot } from './intake.ts';
import type { IntelSummary } from './intel.ts';
import type { RunContext, StateHandler } from './states.ts';

/**
 * Entire's graph as the judge of test runs and changes: it adjudicates a run against a recorded
 * baseline, resolves the symbols a failure names, and lists the entities a change touched.
 */
export interface Judge {
  recordBaseline(dir: string, testCommand: string, baselinePath: string, timeoutMs: number): Promise<string>;
  verify(dir: string, testCommand: string, baselinePath: string, timeoutMs: number): Promise<Verdict>;
  explain(dir: string, failureOutput: string): Promise<string>;
  diff(dir: string, base: string): Promise<EntityChange[]>;
}

export const graphJudge: Judge = {
  recordBaseline: (dir, command, path, timeoutMs) => graphRecordBaseline(dir, command, path, scrubbedEnv(), timeoutMs),
  verify: (dir, command, path, timeoutMs) => graphVerify(dir, command, path, scrubbedEnv(), timeoutMs),
  explain: graphExplain,
  diff: graphDiff,
};

export interface RepairDeps {
  chat?: Chat;
  provider?: ImpactProvider;
  sandbox?: Sandbox;
  judge?: Judge;
}

const PatchSubmission = z.object({
  plan: z.string().min(1).describe('What you changed and why, in two or three sentences.'),
  files_changed: z.array(z.string()).describe('Files you edited.'),
  test_change_reason: z.string().optional().describe('Required only if you edited a test file: the documented behaviour change that made it necessary.'),
});
type PatchSubmission = z.infer<typeof PatchSubmission>;

const Diagnosis = z.object({
  cause: z.string().min(1).describe('The specific cause of the remaining failure: file, line or call, and what the new version does differently there.'),
  attempt_assessment: z.enum(['wrong', 'incomplete', 'correct_but_insufficient']),
  next_change: z.string().min(1).describe('Exactly what the next attempt should change, and why.'),
  fixable: z.boolean().describe('False only when evidence shows this cannot be fixed by changing the project code.'),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

export interface PatchResult {
  attempt: number;
  commit: string | null;
  plan: string;
  files: string[];
  entities: EntityChange[];
  toolCalls: number;
  costUsd: number;
  promptVersion: string;
}

export interface Check {
  name: 'baseline_passed' | 'failure_reproduced' | 'tests_pass_now' | 'no_regression' | 'graph_verdict';
  ok: boolean;
  detail: string;
}

export interface Verification {
  verified: boolean;
  checks: Check[];
  /** Things that do not block verification but that a reviewer should know. */
  caveats: string[];
}

interface RunCounts {
  exit_code: number | null;
  passed: number | null;
  failed: number | null;
}

/**
 * The rules a repair must meet before it is called verified (plan section 15):
 * the tests passed before the upgrade, the failure was reproduced when code had to change,
 * the tests pass now, and nothing that passed before fails now.
 */
export function checkVerification(input: {
  baseline: RunCounts | undefined;
  afterUpgrade: RunCounts | undefined;
  last: RunCounts | undefined;
  codeChanged: boolean;
  judgeVerdict: Verdict | null;
  changedFiles: string[];
  flaggedFiles: string[];
}): Verification {
  const { baseline, afterUpgrade, last } = input;
  const checks: Check[] = [];
  const caveats: string[] = [];

  checks.push({ name: 'baseline_passed', ok: baseline?.exit_code === 0, detail: baseline?.exit_code === 0 ? 'Tests passed before the upgrade.' : 'There is no passing test run from before the upgrade.' });
  if (input.codeChanged) {
    const reproduced = afterUpgrade !== undefined && afterUpgrade.exit_code !== 0;
    checks.push({ name: 'failure_reproduced', ok: reproduced, detail: reproduced ? 'Tests failed after the upgrade and before the fix.' : 'The failure was not reproduced before the code was changed.' });
  }
  checks.push({ name: 'tests_pass_now', ok: last?.exit_code === 0, detail: last?.exit_code === 0 ? 'Tests pass with the fix.' : 'The latest test run did not pass.' });

  const countsKnown = baseline?.passed != null && last?.passed != null;
  const fewer = countsKnown && (last!.passed! < baseline!.passed! || (last!.failed ?? 0) > 0);
  checks.push({
    name: 'no_regression',
    ok: !fewer,
    detail: fewer
      ? `Fewer tests pass now (${last!.passed}) than before the upgrade (${baseline!.passed}).`
      : countsKnown
        ? `As many tests pass now (${last!.passed}) as before the upgrade (${baseline!.passed}).`
        : 'Test counts could not be read from the runner output; the exit code is the only signal.',
  });
  if (!countsKnown) caveats.push('Per-test comparison was not possible: the test runner output has no recognised summary.');

  if (input.judgeVerdict) {
    checks.push({ name: 'graph_verdict', ok: input.judgeVerdict.passed, detail: `entire graph verify: ${input.judgeVerdict.verdict}` });
    if (/exit-code only/i.test(input.judgeVerdict.detail)) caveats.push('entire graph verify could not read test names from this runner, so its verdict is pass or fail only.');
  } else {
    caveats.push('entire graph verify was not available for this run.');
  }

  const outside = input.changedFiles.filter((f) => !input.flaggedFiles.includes(f));
  if (outside.length) caveats.push(`The fix also changed ${outside.join(', ')}, which impact analysis had not flagged.`);

  return { verified: checks.every((c) => c.ok), checks, caveats };
}

interface StepOutcome {
  ok: boolean;
  run?: TestRun;
  verdict?: Verdict | { unavailable: string };
  reason?: string;
}

const MAX_SOURCE_CHARS = 16_000;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const logPath = (id: string, name: string) => join(workspaceRoot(), id, 'logs', `${name.replace(/[^\w.-]+/g, '_')}.log`);
const baselinePath = (id: string, pkg: string) => join(workspaceRoot(), id, 'verify', `${pkg.replace(/[^\w.-]+/g, '_')}.json`);
const findingIds = (repair: RepairRecord) => JSON.parse(repair.finding_ids) as string[];

function testCommand(dir: string): string | null {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const script = manifest.scripts?.test;
  return script && !/no test specified/.test(script) ? 'npm test' : null;
}

/** The command the judge runs: the same isolation as the sandbox, so adjudication never runs repository code on the host. */
function judgedCommand(dir: string, command: string): string {
  if ((process.env.VERITAS_SANDBOX ?? 'docker') !== 'docker') return command;
  const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;
  return ['docker', ...dockerArgs({ cwd: dir, command: 'sh', args: ['-c', command], timeoutMs: 0, network: false })].map(quote).join(' ');
}

/** The findings a repair addresses, the one attempts are recorded against first: the breaking change when there is one. */
function findingsOf(records: Records, ctx: RunContext, repair: RepairRecord): { all: FindingRecord[]; primary: FindingRecord } {
  const ids = findingIds(repair);
  const all = records.findings(ctx.investigationId).filter((f) => ids.includes(f.id));
  const primary = all.find((f) => f.kind === 'breaking') ?? all[0];
  if (!primary) throw new Error(`Repair ${repair.id} has no findings`);
  return { all, primary };
}

function endRepair(records: Records, ctx: RunContext, repair: RepairRecord, status: 'unresolved' | 'not_reproduced' | 'verified', reason: string): void {
  records.updateRepair(repair.id, { status, note: reason });
  note('repair of {package} ended: {status}. {reason}', { package: repair.package, status, reason, level: status === 'unresolved' ? 'warn' : 'info' });
  // Leave the branch as it is for inspection and return the workspace to the starting commit for the next repair.
  if (repair.base_commit) git(repoDir(ctx.investigationId), 'checkout', '--quiet', '--force', '--detach', repair.base_commit);
}

export function createRepairHandlers(deps: RepairDeps = {}): Record<'PLAN_REPAIR' | 'BASELINE' | 'PATCH' | 'TEST' | 'DIAGNOSE' | 'VERIFY', StateHandler> {
  const provider = deps.provider ?? graphProvider;
  const judge = deps.judge ?? graphJudge;
  const sandbox = () => deps.sandbox ?? selectSandbox();
  const tool = <T>(name: string, attrs: Record<string, string | number>, fn: (set: SetAttrs) => Promise<T> | T) => traced(`tool.${name}`, 'TOOL', attrs, fn);

  /** Runs the tests, records the run, and has the graph adjudicate it against the baseline. */
  async function testAndJudge(ctx: RunContext, repair: RepairRecord, label: string, attemptId?: number): Promise<StepOutcome> {
    const dir = repoDir(ctx.investigationId);
    const command = testCommand(dir)!;
    const run = await tool('run_tests', { label, command }, async (set) => {
      const result = await runTests(sandbox(), dir, command, ctx.limits.cmdTimeoutMs, logPath(ctx.investigationId, `${repair.package}-${label}`));
      set({ exit_code: result.exitCode ?? -1, passed: result.passed ?? -1, failed: result.failed ?? -1, timed_out: result.timedOut });
      return result;
    });
    new Records(ctx.db).saveTestRun(ctx.investigationId, { label: `${repair.package}:${label}`, command, exitCode: run.exitCode, passed: run.passed, failed: run.failed, logPath: run.logPath, durationMs: run.durationMs, attemptId });
    const verdict = await traced('eval.entire_graph_verify', 'EVALUATOR', { label }, async (): Promise<Verdict | { unavailable: string }> => {
      try {
        return await judge.verify(dir, judgedCommand(dir, command), baselinePath(ctx.investigationId, repair.package), ctx.limits.cmdTimeoutMs * 2);
      } catch (err) {
        return { unavailable: message(err) };
      }
    });
    note('tests {label} for {package}: {result}', { label, package: repair.package, result: run.ok ? 'pass' : run.timedOut ? 'timed out' : `fail (exit ${run.exitCode})`, level: run.ok ? 'info' : 'warn' });
    return { ok: run.ok, run, verdict };
  }

  const planRepair: StateHandler = async (ctx) => {
    const records = new Records(ctx.db);
    const open = records.findings(ctx.investigationId).filter((f) => f.status !== 'not_affected');
    await ctx.step('plan', { findings: open.map((f) => f.id).sort() }, () => {
      const candidates = ctx.journal.output<IntelSummary>(ctx.investigationId, 'INTEL', 'candidates')?.candidates ?? [];
      const packages = [...new Set(open.map((f) => f.package))];
      const plans = packages
        .map((pkg) => {
          const group = open.filter((f) => f.package === pkg);
          const forPackage = candidates.filter((c) => c.package === pkg);
          // The latest version when a breaking change is in play (it also clears advisories); otherwise the first fully patched one.
          const target = forPackage.find((c) => c.kind === 'breaking')?.targetVersion ?? forPackage.find((c) => c.kind === 'advisory')?.targetVersion ?? null;
          const repairable = group.filter((f) => f.kind === 'breaking' || f.kind === 'advisory');
          return { package: pkg, from: forPackage[0]?.installed ?? '', target, findings: repairable, priority: Math.max(0, ...group.map((f) => f.priority ?? 0)) };
        })
        .sort((a, b) => b.priority - a.priority);

      const planned: { package: string; from: string; target: string; findings: string[] }[] = [];
      const skipped: { package: string; reason: string }[] = [];
      for (const p of plans) {
        if (!p.target || p.findings.length === 0) {
          skipped.push({ package: p.package, reason: p.target ? 'only a deprecation notice, which has no version to move to' : 'no fixed version is published' });
          continue;
        }
        records.planRepair(ctx.investigationId, { package: p.package, from: p.from, target: p.target, findingIds: p.findings.map((f) => f.id), branch: `veritas/${p.package.replace(/[^\w.-]+/g, '-')}` });
        planned.push({ package: p.package, from: p.from, target: p.target, findings: p.findings.map((f) => `${f.kind}:${f.status}`) });
      }
      note('repair plan: {planned} package(s) to repair, {skipped} skipped', { planned: planned.length, skipped: skipped.length });
      return { planned, skipped };
    });
    return records.currentRepair(ctx.investigationId) ? 'BASELINE' : 'REPORT';
  };

  const baseline: StateHandler = async (ctx) => {
    const records = new Records(ctx.db);
    const repair = records.currentRepair(ctx.investigationId);
    if (!repair) return 'PLAN_REPAIR';
    const dir = repoDir(ctx.investigationId);
    const base = ctx.journal.getInvestigation(ctx.investigationId)?.commit_sha;
    if (!base) throw new Error('BASELINE needs the starting commit recorded by INTAKE');
    const key = { repair: repair.id };
    const { all } = findingsOf(records, ctx, repair);
    const give_up = (reason: string) => {
      for (const f of all) records.setFindingStatus(f.id, 'unresolved', { note: reason });
      endRepair(records, ctx, { ...repair, base_commit: base }, 'unresolved', reason);
      return 'PLAN_REPAIR' as const;
    };

    await ctx.step('branch', key, () => tool('git_branch', { branch: repair.branch }, () => {
      startBranch(dir, repair.branch, base);
      records.updateRepair(repair.id, { base_commit: base });
      return { branch: repair.branch, base };
    }));
    if (!testCommand(dir)) return give_up('The project has no test command, so a fix could not be verified.');

    const install = await ctx.step('install_baseline', key, () => tool('npm_ci', {}, () => runInstall(sandbox(), dir, ['ci'], ctx.limits.cmdTimeoutMs, logPath(ctx.investigationId, `${repair.package}-install-baseline`))));
    if (!install.ok) return give_up(`npm ci failed at the current versions: ${install.tail.trim().split('\n').at(-1) ?? ''}`);

    const before = await ctx.step('test_baseline', key, async (): Promise<StepOutcome> => {
      const command = testCommand(dir)!;
      const run = await tool('run_tests', { label: 'baseline', command }, () => runTests(sandbox(), dir, command, ctx.limits.cmdTimeoutMs, logPath(ctx.investigationId, `${repair.package}-baseline`)));
      records.saveTestRun(ctx.investigationId, { label: `${repair.package}:baseline`, command, exitCode: run.exitCode, passed: run.passed, failed: run.failed, logPath: run.logPath, durationMs: run.durationMs });
      return { ok: run.ok, run };
    });
    if (!before.ok) return give_up('The tests already fail before any change, so a failure after the upgrade would prove nothing.');

    await ctx.step('record_baseline', key, () =>
      traced('eval.entire_graph_verify', 'EVALUATOR', { label: 'record_baseline' }, async () => {
        try {
          return { recorded: (await judge.recordBaseline(dir, judgedCommand(dir, testCommand(dir)!), baselinePath(ctx.investigationId, repair.package), ctx.limits.cmdTimeoutMs * 2)).trim().slice(0, 400) };
        } catch (err) {
          return { unavailable: message(err) };
        }
      }),
    );

    const bump = await ctx.step('upgrade', { ...key, to: repair.target_version }, () =>
      tool('npm_install', { package: repair.package, version: repair.target_version }, async () => {
        const result = await runInstall(sandbox(), dir, ['install', `${repair.package}@${repair.target_version}`], ctx.limits.cmdTimeoutMs, logPath(ctx.investigationId, `${repair.package}-upgrade`));
        if (!result.ok) return { ok: false, commit: null, tail: result.tail };
        const commit = commitAll(dir, `Upgrade ${repair.package} from ${repair.from_version} to ${repair.target_version}`);
        records.updateRepair(repair.id, { bump_commit: commit });
        return { ok: true, commit, tail: '' };
      }),
    );
    if (!bump.ok || !bump.commit) return give_up(`Installing ${repair.package}@${repair.target_version} failed: ${bump.tail.trim().split('\n').at(-1) ?? 'no change to commit'}`);

    const after = await ctx.step('test_after_upgrade', key, () => testAndJudge(ctx, { ...repair, bump_commit: bump.commit }, 'after_upgrade'));
    const breaking = all.filter((f) => f.kind === 'breaking');

    if (after.ok) {
      for (const f of breaking) records.setFindingStatus(f.id, 'potential', { note: `Not reproduced: the project's tests still pass on ${repair.package} ${repair.target_version}.` });
      if (all.some((f) => f.kind === 'advisory')) return 'VERIFY';
      endRepair(records, ctx, { ...repair, base_commit: base }, 'not_reproduced', `Tests pass on ${repair.target_version} without any code change; the predicted breakage was not reproduced.`);
      return 'PLAN_REPAIR';
    }

    const firstError = after.run?.tail.split('\n').find((l) => /\b\w*Error\b.*:|ERR_[A-Z_]+/.test(l))?.trim().slice(0, 240) ?? `exit code ${after.run?.exitCode}`;
    // A test that passed before the upgrade and fails after it is the proof the plan asks for.
    for (const f of breaking) records.setFindingStatus(f.id, 'confirmed', { severity: 0.75, confidence: 1, note: `Reproduced: tests pass on ${repair.from_version} and fail on ${repair.target_version} (${firstError}).` });
    records.updateRepair(repair.id, { status: 'reproduced', note: firstError });
    note('reproduced: {package} {target} breaks the tests: {error}', { package: repair.package, target: repair.target_version, error: firstError, level: 'warn' });
    return 'PATCH';
  };

  /** Runs one model role as a neatlogs AGENT span linked to the managed prompt version it used. */
  async function agent<T>(name: string, prompt: PromptName, attrs: Record<string, string | number>, body: (system: string, version: string, set: SetAttrs) => Promise<T>): Promise<T> {
    const loaded = await loadPrompt(prompt);
    return traced(name, 'AGENT', { ...attrs, prompt_version: loaded.version, prompt_source: loaded.source }, (set) => body(loaded.text, loaded.version, set), undefined, {
      promptTemplate: loaded.text,
      version: `${loaded.name}@${loaded.version}`,
    });
  }

  /** What the repair and diagnosis agents are told about the situation. */
  async function briefing(ctx: RunContext, repair: RepairRecord, failure: string): Promise<string> {
    const records = new Records(ctx.db);
    const dir = repoDir(ctx.investigationId);
    const { all, primary } = findingsOf(records, ctx, repair);
    let budget = MAX_SOURCE_CHARS;
    const excerpts = records
      .sourcesFor(primary.id)
      .filter((s) => s.kind !== 'registry')
      .map((s, i) => {
        const text = (s.excerpt ?? '').slice(0, Math.max(0, budget));
        budget -= text.length;
        return `[${i + 1}] ${s.kind} — ${s.url}\n${text}`;
      });
    const sites = records.affectedSites(ctx.investigationId).filter((s) => findingIds(repair).includes(s.finding_id));
    const explained = await judge.explain(dir, failure).catch(() => '');
    const earlier = records.attempts(ctx.investigationId).filter((a) => a.finding_id === primary.id && a.outcome);
    return [
      `Package: ${repair.package}\nUpgrade: ${repair.from_version} -> ${repair.target_version} (already installed in the project)`,
      describeRuntime(dir),
      `Findings:\n${all.map((f) => `- ${f.kind}: ${f.rationale}`).join('\n')}`,
      `Places impact analysis flagged:\n${sites.map((s) => `- ${s.file}${s.line ? `:${s.line}` : ''}${s.symbol ? ` (in ${s.symbol})` : ''}`).join('\n') || '- none recorded'}`,
      `Excerpts from the package's release notes:\n\n${excerpts.join('\n\n') || '(none available)'}`,
      `Output of the failing test run (end of log):\n${failure.trim() || '(empty)'}`,
      explained.trim() ? `Declarations the failure names (from the code graph):\n${explained.trim().slice(0, 3000)}` : '',
      earlier.length
        ? `Earlier attempts, each reverted after its tests failed:\n${earlier.map((a) => `Attempt ${a.n} — plan: ${a.plan_text ?? '(none)'}\nChange made:\n${(a.diff ?? '').slice(0, 4000)}\nDiagnosis afterwards: ${a.diagnosis_text ?? '(none yet)'}`).join('\n\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  function editTool(dir: string, edited: Set<string>): LoopTool {
    return {
      name: 'apply_edit',
      description: 'Replace one exact piece of text in one file of the project. old_text must match the file exactly and appear once. To edit a test file you must give test_change_reason.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path relative to the project root' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          test_change_reason: { type: 'string', description: 'Only for test files: the documented behaviour change that requires it.' },
        },
        required: ['file', 'old_text', 'new_text'],
      },
      run: async (args) => {
        const result = await guarded('edit', `${String(args.file)}`, () =>
          applyEdit(dir, { file: String(args.file), oldText: String(args.old_text ?? ''), newText: String(args.new_text ?? ''), allowTests: typeof args.test_change_reason === 'string' && args.test_change_reason.trim().length > 20 }),
        );
        edited.add(result.file);
        return `Edited ${result.file} (${result.linesBefore} -> ${result.linesAfter} lines).`;
      },
    };
  }

  const patch: StateHandler = async (ctx) => {
    const records = new Records(ctx.db);
    const repair = records.currentRepair(ctx.investigationId);
    if (!repair?.bump_commit) return 'TEST';
    const dir = repoDir(ctx.investigationId);
    const n = repair.attempts + 1;
    const { primary } = findingsOf(records, ctx, repair);

    await ctx.step('patch', { repair: repair.id, attempt: n }, () =>
      agent('agent.repair', 'veritas-repair-engineer', { package: repair.package, attempt: n }, async (system, version, set): Promise<PatchResult> => {
        // A crash mid-attempt can leave half an edit behind; every attempt starts from the upgraded, unpatched tree.
        resetTo(dir, repair.bump_commit!);
        const lastRun = records.testRuns(ctx.investigationId).filter((r) => r.label.startsWith(`${repair.package}:`)).at(-1);
        const failure = lastRun?.log_path && existsSync(lastRun.log_path) ? readFileSync(lastRun.log_path, 'utf8').slice(-6000) : '';
        const edited = new Set<string>();
        const loop = await runToolLoop<PatchSubmission>({
          chat: deps.chat ?? createChat(ctx.db, ctx.limits),
          ctx: { investigationId: ctx.investigationId, state: 'PATCH', step: `patch:${repair.package}:${n}` },
          system,
          user: `${await briefing(ctx, repair, failure)}\n\nThis is attempt ${n} of ${ctx.limits.maxAttempts}.`,
          tools: [readFileTool(dir), searchTool(dir, provider), callersTool(dir, provider), editTool(dir, edited)],
          submit: {
            name: 'submit_patch',
            description: 'Declare the edits complete so the tests can be run.',
            parameters: z.toJSONSchema(PatchSubmission) as Record<string, unknown>,
            parse: (args) => {
              const submission = PatchSubmission.parse(args);
              if (edited.size === 0) throw new Error('No file has been edited yet. Use apply_edit to change the code, then submit.');
              return submission;
            },
          },
          maxToolCalls: ctx.limits.maxToolCallsPerStep + 8,
        });
        const commit = commitAll(dir, `Adapt to ${repair.package} ${repair.target_version} (attempt ${n})`);
        const files = changedFiles(dir, repair.bump_commit!);
        const entities = await traced('tool.entire_graph_diff', 'TOOL', { base: repair.bump_commit! }, () => judge.diff(dir, repair.bump_commit!).catch(() => []));
        records.saveAttempt(primary.id, n, { plan: loop.result.plan, diff: diffBetween(dir, repair.bump_commit!) });
        records.updateRepair(repair.id, { attempts: n, status: 'patched' });
        set({ attempt: n, files_changed: files.length, tool_calls: loop.toolCalls.length, 'neatlogs.agent.cost_usd': loop.costUsd, 'neatlogs.agent.num_turns': loop.turns });
        note('attempt {n} for {package}: {plan}', { n, package: repair.package, plan: loop.result.plan });
        return { attempt: n, commit, plan: loop.result.plan, files, entities, toolCalls: loop.toolCalls.length, costUsd: loop.costUsd, promptVersion: version };
      }),
    );
    return 'TEST';
  };

  const test: StateHandler = async (ctx) => {
    const records = new Records(ctx.db);
    const repair = records.currentRepair(ctx.investigationId);
    if (!repair) return 'VERIFY';
    const outcome = await ctx.step('test', { repair: repair.id, attempt: repair.attempts }, () => testAndJudge(ctx, repair, `attempt_${repair.attempts}`));
    return outcome.ok ? 'VERIFY' : 'DIAGNOSE';
  };

  const diagnose: StateHandler = async (ctx) => {
    const records = new Records(ctx.db);
    const repair = records.currentRepair(ctx.investigationId);
    if (!repair?.bump_commit) return 'PLAN_REPAIR';
    const dir = repoDir(ctx.investigationId);
    const n = repair.attempts;
    const { all, primary } = findingsOf(records, ctx, repair);
    const lastRun = records.testRuns(ctx.investigationId).find((r) => r.label === `${repair.package}:attempt_${n}`);
    const failure = lastRun?.log_path && existsSync(lastRun.log_path) ? readFileSync(lastRun.log_path, 'utf8').slice(-6000) : '';
    records.saveAttempt(primary.id, n, { outcome: 'tests_failed' });

    const stop = (reason: string) => {
      for (const f of all) records.setFindingStatus(f.id, 'unresolved', { note: reason });
      endRepair(records, ctx, repair, 'unresolved', reason);
      return 'PLAN_REPAIR' as const;
    };

    const diagnosis = await ctx.step('diagnose', { repair: repair.id, attempt: n }, () =>
      agent('agent.diagnose', 'veritas-failure-diagnostician', { package: repair.package, attempt: n }, async (system, _version, set): Promise<Diagnosis> => {
        const loop = await runToolLoop<Diagnosis>({
          chat: deps.chat ?? createChat(ctx.db, ctx.limits),
          ctx: { investigationId: ctx.investigationId, state: 'DIAGNOSE', step: `diagnose:${repair.package}:${n}` },
          system,
          user: `${await briefing(ctx, repair, failure)}\n\nAttempt ${n} is still applied in the project, so read_file shows the code as that attempt left it.`,
          tools: [readFileTool(dir), searchTool(dir, provider), callersTool(dir, provider)],
          submit: { name: 'submit_diagnosis', description: 'Submit the diagnosis of the failed attempt.', parameters: z.toJSONSchema(Diagnosis) as Record<string, unknown>, parse: (args) => Diagnosis.parse(args) },
          maxToolCalls: ctx.limits.maxToolCallsPerStep,
        });
        records.saveAttempt(primary.id, n, { diagnosis: `${loop.result.cause} Next: ${loop.result.next_change}` });
        set({ assessment: loop.result.attempt_assessment, fixable: loop.result.fixable, 'neatlogs.agent.cost_usd': loop.costUsd, 'neatlogs.agent.num_turns': loop.turns });
        note('diagnosis after attempt {n}: {cause} Next: {next}', { n, cause: loop.result.cause, next: loop.result.next_change, level: 'warn' });
        return loop.result;
      }),
    );

    if (!diagnosis.fixable) return stop(`Judged not fixable in this project after attempt ${n}: ${diagnosis.cause}`);
    if (n >= ctx.limits.maxAttempts) return stop(`Still failing after ${n} attempts. Last diagnosis: ${diagnosis.cause}`);
    // The failed attempt stays on record in the journal; the tree goes back to the upgraded, unpatched state.
    resetTo(dir, repair.bump_commit);
    return 'PATCH';
  };

  const verify: StateHandler = async (ctx) => {
    const records = new Records(ctx.db);
    const repair = records.currentRepair(ctx.investigationId);
    if (!repair) return 'PLAN_REPAIR';
    const { all, primary } = findingsOf(records, ctx, repair);
    const verification = await ctx.step('verify', { repair: repair.id, attempt: repair.attempts }, () =>
      traced('eval.verification', 'EVALUATOR', { package: repair.package, attempt: repair.attempts }, (set): Verification => {
        const runs = records.testRuns(ctx.investigationId);
        const run = (label: string) => runs.find((r) => r.label === `${repair.package}:${label}`);
        const lastLabel = repair.attempts > 0 ? `attempt_${repair.attempts}` : 'after_upgrade';
        const judged = ctx.journal.output<StepOutcome>(ctx.investigationId, repair.attempts > 0 ? 'TEST' : 'BASELINE', repair.attempts > 0 ? 'test' : 'test_after_upgrade')?.verdict;
        const patched = repair.attempts > 0 ? ctx.journal.output<PatchResult>(ctx.investigationId, 'PATCH', 'patch') : undefined;
        const flagged = new Set(records.affectedSites(ctx.investigationId).filter((s) => findingIds(repair).includes(s.finding_id)).map((s) => s.file));
        const result = checkVerification({
          baseline: run('baseline'),
          afterUpgrade: run('after_upgrade'),
          last: run(lastLabel),
          codeChanged: repair.attempts > 0,
          judgeVerdict: judged && 'verdict' in judged ? judged : null,
          changedFiles: (patched?.files ?? []).filter((f) => f !== 'package.json' && f !== 'package-lock.json'),
          flaggedFiles: [...flagged],
        });
        set({ verified: result.verified, checks_failed: result.checks.filter((c) => !c.ok).length, caveats: result.caveats.length });
        return result;
      }),
    );

    if (!verification.verified) {
      const failed = verification.checks.filter((c) => !c.ok).map((c) => c.detail).join(' ');
      for (const f of all) records.setFindingStatus(f.id, 'unresolved', { note: `Tests pass, but the fix did not meet the verification rules: ${failed}` });
      endRepair(records, ctx, repair, 'unresolved', `Not verified: ${failed}`);
      return 'PLAN_REPAIR';
    }
    if (repair.attempts > 0) records.saveAttempt(primary.id, repair.attempts, { outcome: 'tests_passed' });
    const how = repair.attempts > 0 ? `a code change (attempt ${repair.attempts})` : 'the version upgrade alone';
    for (const f of all) {
      if (f.kind === 'advisory' || f.status === 'confirmed') records.setFindingStatus(f.id, 'confirmed', { note: `Verified: tests pass on ${repair.package} ${repair.target_version} with ${how}.` });
    }
    const caveats = verification.caveats.length ? ` Note: ${verification.caveats.join(' ')}` : '';
    endRepair(records, ctx, repair, 'verified', `Verified on ${repair.target_version}, branch ${repair.branch}.${caveats}`);
    return 'PLAN_REPAIR';
  };

  return { PLAN_REPAIR: planRepair, BASELINE: baseline, PATCH: patch, TEST: test, DIAGNOSE: diagnose, VERIFY: verify };
}
