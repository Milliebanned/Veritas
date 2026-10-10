import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers, stubHandlers } from '../src/agent/handlers.ts';
import type { ImpactProvider } from '../src/agent/impact.ts';
import { repoDir } from '../src/agent/intake.ts';
import { realTools, type IntelTools } from '../src/agent/intel.ts';
import { loadLimits } from '../src/agent/limits.ts';
import { Orchestrator } from '../src/agent/orchestrator.ts';
import type { Judge } from '../src/agent/repair.ts';
import type { Chat, ChatRequest } from '../src/llm/client.ts';
import { openDb } from '../src/state/db.ts';
import { Records } from '../src/state/records.ts';
import { applyEdit, EditRejected, isTestFile } from '../src/tools/fileEdit.ts';
import { PathEscape } from '../src/tools/paths.ts';
import { dockerArgs, localSandbox, scrubbedEnv, type RunRequest, type Sandbox } from '../src/tools/sandbox.ts';
import { parseCounts } from '../src/tools/testRunner.ts';

let scratch: string;
const previous = process.env.VERITAS_WORKSPACE_DIR;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'veritas-repair-'));
  process.env.VERITAS_WORKSPACE_DIR = join(scratch, 'workspaces');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previous === undefined) delete process.env.VERITAS_WORKSPACE_DIR;
  else process.env.VERITAS_WORKSPACE_DIR = previous;
});

describe('edit tool', () => {
  const project = () => {
    const root = mkdtempSync(join(scratch, 'edit-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'src', 'a.js'), "const x = require('pkg');\nx();\nx();\n");
    writeFileSync(join(root, 'test', 'a.test.js'), 'assert(1);\n');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    return root;
  };

  it('replaces one exact, unique piece of text', () => {
    const root = project();
    expect(applyEdit(root, { file: 'src/a.js', oldText: "require('pkg')", newText: "require('pkg').default" })).toMatchObject({ file: 'src/a.js' });
    expect(readFileSync(join(root, 'src', 'a.js'), 'utf8')).toBe("const x = require('pkg').default;\nx();\nx();\n");
  });

  it('inserts replacement text literally, including dollar signs', () => {
    const root = project();
    applyEdit(root, { file: 'src/a.js', oldText: "require('pkg')", newText: "load('$&$1')" });
    expect(readFileSync(join(root, 'src', 'a.js'), 'utf8')).toContain("const x = load('$&$1');");
  });

  it('accepts text that differs from the file only in leading indentation, and re-indents the replacement', () => {
    const root = project();
    writeFileSync(join(root, 'src', 'b.js'), 'function f() {\n  if (x) {\n    call(1);\n  }\n}\n');
    // The model copied the block with two extra spaces on every line, as seen in trace 85740ee5c9d3c5369bd1b1ae7602c248.
    applyEdit(root, { file: 'src/b.js', oldText: '    if (x) {\n      call(1);\n    }', newText: '    if (x) {\n      call(2);\n    }' });
    expect(readFileSync(join(root, 'src', 'b.js'), 'utf8')).toBe('function f() {\n  if (x) {\n    call(2);\n  }\n}\n');
    // And with too little indentation.
    applyEdit(root, { file: 'src/b.js', oldText: 'if (x) {\n  call(2);\n}', newText: 'if (x) {\n  call(3);\n  call(4);\n}' });
    expect(readFileSync(join(root, 'src', 'b.js'), 'utf8')).toBe('function f() {\n  if (x) {\n    call(3);\n    call(4);\n  }\n}\n');
  });

  it('refuses an indentation-only match that fits more than one place', () => {
    const root = project();
    writeFileSync(join(root, 'src', 'c.js'), 'a();\n  done();\nb();\n    done();\n');
    expect(() => applyEdit(root, { file: 'src/c.js', oldText: '      done();', newText: 'stop();' })).toThrow(/appears 2 times/);
    expect(readFileSync(join(root, 'src', 'c.js'), 'utf8')).toBe('a();\n  done();\nb();\n    done();\n');
  });

  it('refuses text that is missing or matches more than once', () => {
    const root = project();
    expect(() => applyEdit(root, { file: 'src/a.js', oldText: 'nope', newText: 'y' })).toThrow(/was not found/);
    expect(() => applyEdit(root, { file: 'src/a.js', oldText: 'x();', newText: 'y();' })).toThrow(/appears 2 times/);
    expect(() => applyEdit(root, { file: 'src/missing.js', oldText: 'a', newText: 'b' })).toThrow(/does not exist/);
  });

  it('refuses paths outside the workspace, lockfiles and installed packages', () => {
    const root = project();
    expect(() => applyEdit(root, { file: '../outside.js', oldText: 'a', newText: 'b' })).toThrow(PathEscape);
    expect(() => applyEdit(root, { file: '/etc/hosts', oldText: 'a', newText: 'b' })).toThrow(PathEscape);
    expect(() => applyEdit(root, { file: 'package-lock.json', oldText: '{}', newText: '{ }' })).toThrow(EditRejected);
    expect(() => applyEdit(root, { file: 'node_modules/pkg/index.js', oldText: 'a', newText: 'b' })).toThrow(EditRejected);
  });

  it('refuses to edit a test unless a reason was given', () => {
    const root = project();
    expect(() => applyEdit(root, { file: 'test/a.test.js', oldText: 'assert(1)', newText: 'assert(2)' })).toThrow(/is a test file/);
    expect(applyEdit(root, { file: 'test/a.test.js', oldText: 'assert(1)', newText: 'assert(2)', allowTests: true }).file).toBe('test/a.test.js');
    expect(['test/x.js', 'src/__tests__/x.ts', 'src/x.spec.tsx', 'e2e/x.js'].every(isTestFile)).toBe(true);
    expect(['src/contest/x.js', 'src/latest.js', 'src/testing.js'].some(isTestFile)).toBe(false);
  });
});

describe('sandbox', () => {
  it('passes no secrets from the environment to repository code', async () => {
    const env = scrubbedEnv({ PATH: '/bin', HOME: '/h', LITELLM_API_KEY: 's1', NEATLOGS_API_KEY: 's2', GITHUB_TOKEN: 's3', AWS_SECRET_ACCESS_KEY: 's4' });
    expect(Object.values(env)).not.toEqual(expect.arrayContaining(['s1', 's2', 's3', 's4']));
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', CI: 'true' });

    process.env.VERITAS_TEST_SECRET = 'do-not-leak';
    try {
      const result = await localSandbox({ cwd: scratch, command: 'sh', args: ['-c', 'echo "secret=[$VERITAS_TEST_SECRET]"'], timeoutMs: 10_000, network: false });
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(result.output).toContain('secret=[]');
    } finally {
      delete process.env.VERITAS_TEST_SECRET;
    }
  });

  it('stops a command that runs past its time limit, with its children', async () => {
    const result = await localSandbox({ cwd: scratch, command: 'sh', args: ['-c', 'sleep 30 & sleep 30'], timeoutMs: 300, network: false });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('builds a container command with no network for tests and only the workspace mounted', () => {
    const request: RunRequest = { cwd: '/ws/repo', command: 'sh', args: ['-c', 'npm test'], timeoutMs: 1000, network: false };
    const args = dockerArgs(request);
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('--cap-drop ALL');
    expect(args.filter((a) => a.includes(':/')).join()).toBe('/ws/repo:/work');
    expect(dockerArgs({ ...request, network: true }).join(' ')).toContain('--network bridge');
    expect(args.slice(-3)).toEqual(['sh', '-c', 'npm test']);
  });
});

describe('test output', () => {
  it('reads pass and fail counts from common runners', () => {
    expect(parseCounts('ℹ tests 5\nℹ pass 4\nℹ fail 1\n')).toEqual({ passed: 4, failed: 1 });
    expect(parseCounts('# tests 3\n# pass 3\n# fail 0\n')).toEqual({ passed: 3, failed: 0 });
    expect(parseCounts('Tests:       1 failed, 7 passed, 8 total\n')).toEqual({ passed: 7, failed: 1 });
    expect(parseCounts('  12 passing (40ms)\n  2 failing\n')).toEqual({ passed: 12, failed: 2 });
    expect(parseCounts('\u001b[32mℹ pass 2\u001b[39m\nℹ fail 0\n')).toEqual({ passed: 2, failed: 0 });
    expect(parseCounts('all good')).toEqual({ passed: null, failed: null });
  });
});

// ---- the repair states, driven end to end with a scripted model and a simulated project runtime -------------

function scriptedChat(turns: { name: string; args: unknown }[][], seen: ChatRequest[] = []): Chat {
  let turn = 0;
  return async (request) => {
    seen.push(structuredClone(request));
    const calls = turns[turn++] ?? [];
    const message = { role: 'assistant', content: null, refusal: null, tool_calls: calls.map((c, i) => ({ id: `c${turn}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as ChatCompletionMessage;
    return { message, promptTokens: 1, completionTokens: 1, costUsd: 0 };
  };
}

/**
 * Stands in for npm and the test runner. "Installing" the new version writes a marker; the
 * tests fail while the marker is present and src/render.js still uses the removed default export.
 */
function simulatedSandbox(log: string[]): Sandbox {
  return async ({ cwd, command, args }) => {
    const line = [command, ...args].join(' ');
    log.push(line.replace(/ --(ignore-scripts|no-audit|no-fund|loglevel=error)/g, ''));
    if (command === 'npm' && args[0] === 'install') writeFileSync(join(cwd, 'UPGRADED'), args[1] ?? '');
    if (command === 'sh') {
      const upgraded = (() => { try { readFileSync(join(cwd, 'UPGRADED')); return true; } catch { return false; } })();
      const fixed = readFileSync(join(cwd, 'src/render.js'), 'utf8').includes("const { marked } = require('marked')");
      return upgraded && !fixed
        ? { exitCode: 1, output: 'TypeError: marked is not a function\n    at renderNote (src/render.js:4:10)\nℹ pass 1\nℹ fail 4\n', timedOut: false, durationMs: 5 }
        : { exitCode: 0, output: 'ℹ pass 5\nℹ fail 0\n', timedOut: false, durationMs: 5 };
    }
    return { exitCode: 0, output: '', timedOut: false, durationMs: 1 };
  };
}

const judge: Judge = {
  recordBaseline: async () => 'BASELINE RECORDED',
  verify: async () => ({ verdict: 'VERDICT: FAIL (exit 1)', passed: false, detail: '' }),
  explain: async () => 'DECLARATIONS: renderNote (src/render.js:3)',
  diff: async () => [{ file: 'src/render.js', type: 'body_changed', kind: 'function', name: 'renderNote', dependents: 1 }],
};
const provider: ImpactProvider = { edges: async () => readFileSync(new URL('./fixtures/graph-edges-marked.ndjson', import.meta.url), 'utf8'), callers: async () => [], search: async () => [] };
const tools: IntelTools = {
  readInventory: realTools.readInventory,
  runNpmAudit: async () => [],
  fetchPackageInfo: async (name, installed) => ({ name, installed, latest: '18.1.0', deprecated: null, repository: { owner: 'markedjs', repo: 'marked' }, majorsCrossed: [{ major: 4, version: '4.0.0', publishedAt: null }], latestIsEsmOnly: true, latestEngines: null, sourceUrl: 'https://registry.npmjs.org/marked' }),
  fetchReleaseNotes: async () => [{ version: '4.0.0', url: 'https://github.com/markedjs/marked/releases/tag/v4.0.0', kind: 'release_notes', excerpt: 'Default export removed. Use const { marked } = require("marked").', publishedAt: null }],
  fetchAdvisories: async () => [],
};

const impact = [{ name: 'report_impact', args: { changed_apis: [{ api: 'default export', change: 'removed', source_url: 'https://github.com/markedjs/marked/releases/tag/v4.0.0' }], sites: [{ file: 'src/render.js', line: 4, api: 'marked()', verdict: 'affected', reason: 'calls the removed default export' }], summary: 'Default export removed.' } }];
const goodEdit = { name: 'apply_edit', args: { file: 'src/render.js', old_text: "const marked = require('marked');", new_text: "const { marked } = require('marked');" } };
const wrongEdit = { name: 'apply_edit', args: { file: 'src/render.js', old_text: 'return marked(source);', new_text: 'return marked.default(source);' } };
const submit = (plan: string) => ({ name: 'submit_patch', args: { plan, files_changed: ['src/render.js'] } });
const diagnosis = (fixable = true) => ({ name: 'submit_diagnosis', args: { cause: 'marked has no default export; .default is undefined', attempt_assessment: 'wrong', next_change: 'destructure the named export', fixable } });

async function investigate(chat: Chat, log: string[] = [], maxAttempts = 3) {
  const db = openDb(':memory:');
  const handlers = { ...createHandlers(tools, { chat, provider, sandbox: simulatedSandbox(log), judge }), REPORT: stubHandlers.REPORT };
  const orchestrator = new Orchestrator({ db, handlers, limits: { ...loadLimits(), maxAttempts } });
  const inv = await orchestrator.run(orchestrator.start('bench/cases/03-marked-default-export/repo').id);
  return { inv, records: new Records(db), dir: repoDir(inv.id) };
}
const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('repair states', () => {
  it('proves the break, patches on a branch, and verifies on the first attempt', async () => {
    const log: string[] = [];
    const seen: ChatRequest[] = [];
    const { inv, records, dir } = await investigate(scriptedChat([impact, [goodEdit], [submit('Use the named export.')]], seen), log);

    expect(log).toEqual(['npm ci', 'sh -c npm test', 'npm install marked@18.1.0', 'sh -c npm test', 'sh -c npm test']);
    expect(records.repairs(inv.id)).toMatchObject([{ package: 'marked', from_version: '3.0.8', target_version: '18.1.0', status: 'verified', attempts: 1, branch: 'veritas/marked' }]);
    const [finding] = records.findings(inv.id);
    expect(finding).toMatchObject({ kind: 'breaking', status: 'confirmed', severity: 0.75, confidence: 1 });
    expect(finding?.rationale).toContain('Reproduced: tests pass on 3.0.8 and fail on 18.1.0 (TypeError: marked is not a function)');
    expect(records.testRuns(inv.id).map((r) => [r.label, r.exit_code, r.failed])).toEqual([['marked:baseline', 0, 0], ['marked:after_upgrade', 1, 4], ['marked:attempt_1', 0, 0]]);
    expect(records.attempts(inv.id)).toMatchObject([{ n: 1, outcome: 'tests_passed', plan_text: 'Use the named export.' }]);
    expect(records.attempts(inv.id)[0]?.diff).toContain("+const { marked } = require('marked');");

    // The fix lives on the branch as two commits; the workspace is back on the starting commit.
    expect(gitIn(dir, 'log', '--format=%s', 'veritas/marked', '-2')).toBe('Adapt to marked 18.1.0 (attempt 1)\nUpgrade marked from 3.0.8 to 18.1.0');
    expect(gitIn(dir, 'rev-parse', 'HEAD')).toBe(inv.commit_sha);
    // The repair agent was shown the real failure and the graph's explanation of it.
    expect(String(seen[1]?.messages[1]?.content)).toContain('TypeError: marked is not a function');
    expect(String(seen[1]?.messages[1]?.content)).toContain('DECLARATIONS: renderNote');
  });

  it('diagnoses a failed attempt, reverts it, and succeeds on the second', async () => {
    const seen: ChatRequest[] = [];
    const chat = scriptedChat([impact, [wrongEdit], [submit('Call .default.')], [diagnosis()], [goodEdit], [submit('Destructure the named export.')]], seen);
    const { inv, records, dir } = await investigate(chat);

    expect(records.repairs(inv.id)).toMatchObject([{ status: 'verified', attempts: 2 }]);
    expect(records.attempts(inv.id).map((a) => [a.n, a.outcome])).toEqual([[1, 'tests_failed'], [2, 'tests_passed']]);
    expect(records.attempts(inv.id)[0]?.diagnosis_text).toBe('marked has no default export; .default is undefined Next: destructure the named export');
    // Attempt 1 was reverted: the final branch has no trace of it.
    expect(gitIn(dir, 'show', 'veritas/marked:src/render.js')).not.toContain('marked.default');
    // Attempt 2 was told what attempt 1 changed and how it was diagnosed.
    const second = String(seen[4]?.messages[1]?.content);
    expect(second).toContain('Attempt 1 — plan: Call .default.');
    expect(second).toContain('+  return marked.default(source);');
    expect(second).toContain('Diagnosis afterwards: marked has no default export');
    expect(second).toContain('This is attempt 2 of 3.');
  });

  it('stops at the attempt limit and reports the finding as unresolved', async () => {
    const chat = scriptedChat([impact, [wrongEdit], [submit('one')], [diagnosis()], [wrongEdit], [submit('two')], [diagnosis()]]);
    const { inv, records, dir } = await investigate(chat, [], 2);

    expect(records.repairs(inv.id)).toMatchObject([{ status: 'unresolved', attempts: 2 }]);
    expect(records.repairs(inv.id)[0]?.note).toContain('Still failing after 2 attempts');
    expect(records.findings(inv.id)[0]).toMatchObject({ status: 'unresolved' });
    expect(inv.status).toBe('awaiting_approval');
    expect(gitIn(dir, 'rev-parse', 'HEAD')).toBe(inv.commit_sha);
  });

  it('stops early when the diagnosis says the project code cannot fix it', async () => {
    const chat = scriptedChat([impact, [wrongEdit], [submit('one')], [diagnosis(false)]]);
    const { inv, records } = await investigate(chat);
    expect(records.repairs(inv.id)).toMatchObject([{ status: 'unresolved', attempts: 1 }]);
    expect(records.repairs(inv.id)[0]?.note).toContain('Judged not fixable');
  });

  it('refuses a submission when nothing was edited, and blocks edits to tests', async () => {
    const seen: ChatRequest[] = [];
    const testEdit = { name: 'apply_edit', args: { file: 'test/render.test.js', old_text: "'<p>Hello <strong>world</strong></p>\\n'", new_text: "''" } };
    const chat = scriptedChat([impact, [testEdit, submit('Loosen the test.')], [goodEdit], [submit('Fix the code instead.')]], seen);
    const { inv, records, dir } = await investigate(chat);

    const replies = seen[2]?.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)) ?? [];
    expect(replies[0]).toContain('test/render.test.js is a test file');
    expect(replies[1]).toContain('No file has been edited yet');
    expect(records.repairs(inv.id)).toMatchObject([{ status: 'verified', attempts: 1 }]);
    expect(gitIn(dir, 'diff', '--name-only', String(inv.commit_sha), 'veritas/marked')).not.toContain('test/');
  });
});
