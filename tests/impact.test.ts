import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers, stubHandlers } from '../src/agent/handlers.ts';
import type { ImpactProvider, ImpactResult } from '../src/agent/impact.ts';
import { realTools, type IntelTools } from '../src/agent/intel.ts';
import { loadLimits } from '../src/agent/limits.ts';
import { Orchestrator } from '../src/agent/orchestrator.ts';
import { priority, termsFor, usageScore } from '../src/agent/prioritize.ts';
import type { Chat, ChatRequest } from '../src/llm/client.ts';
import { LoopFailed, runToolLoop, type LoopTool } from '../src/llm/loop.ts';
import { openDb } from '../src/state/db.ts';
import { Journal } from '../src/state/journal.ts';
import { Records, type FindingRecord } from '../src/state/records.ts';
import { fallbackUsage, scanImports } from '../src/tools/fallbackImpact.ts';
import { parseEdges } from '../src/tools/graph.ts';
import { PathEscape, resolveInside } from '../src/tools/paths.ts';

const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

let scratch: string;
const previous = process.env.VERITAS_WORKSPACE_DIR;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'veritas-impact-'));
  process.env.VERITAS_WORKSPACE_DIR = join(scratch, 'workspaces');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previous === undefined) delete process.env.VERITAS_WORKSPACE_DIR;
  else process.env.VERITAS_WORKSPACE_DIR = previous;
});

/** A model that replies with the given tool calls, one turn at a time, and records what it was sent. */
function scriptedChat(turns: { name: string; args: unknown }[][], seen: ChatRequest[] = []): Chat {
  let turn = 0;
  return async (request) => {
    seen.push(structuredClone(request));
    const calls = turns[turn++] ?? [];
    const message = {
      role: 'assistant',
      content: null,
      refusal: null,
      tool_calls: calls.map((c, i) => ({ id: `call_${turn}_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })),
    } as ChatCompletionMessage;
    return { message, promptTokens: 10, completionTokens: 5, costUsd: 0.001 };
  };
}

const ctx = { investigationId: 'i', state: 'IMPACT', step: 's' };
const echo: LoopTool = { name: 'echo', description: 'echo', parameters: { type: 'object' }, run: (args) => `echo:${String(args.text)}` };
const submit = {
  name: 'submit',
  description: 'submit',
  parameters: { type: 'object' },
  parse: (args: unknown) => {
    const answer = (args as { answer?: unknown }).answer;
    if (typeof answer !== 'number') throw new Error('answer must be a number.');
    return answer;
  },
};

describe('tool loop', () => {
  it('runs tools, feeds results back, and returns the validated submission', async () => {
    const seen: ChatRequest[] = [];
    const chat = scriptedChat([[{ name: 'echo', args: { text: 'a' } }], [{ name: 'submit', args: { answer: 42 } }]], seen);
    const out = await runToolLoop({ chat, ctx, system: 'sys', user: 'go', tools: [echo], submit, maxToolCalls: 5 });

    expect(out).toMatchObject({ result: 42, turns: 2, costUsd: 0.002 });
    expect(out.toolCalls).toEqual([{ name: 'echo', args: { text: 'a' }, ok: true }, { name: 'submit', args: { answer: 42 }, ok: true }]);
    expect(seen[1]?.messages.at(-1)).toMatchObject({ role: 'tool', content: 'echo:a' });
    expect(seen[0]?.toolChoice).toBe('required');
  });

  it('returns a rejected submission to the model once, with the reason', async () => {
    const seen: ChatRequest[] = [];
    const chat = scriptedChat([[{ name: 'submit', args: { answer: 'x' } }], [{ name: 'submit', args: { answer: 7 } }]], seen);
    const out = await runToolLoop({ chat, ctx, system: 's', user: 'u', tools: [], submit, maxToolCalls: 5 });

    expect(out.result).toBe(7);
    expect(String(seen[1]?.messages.at(-1)?.content)).toContain('answer must be a number.');
  });

  it('fails when the model submits an invalid answer twice', async () => {
    const chat = scriptedChat([[{ name: 'submit', args: {} }], [{ name: 'submit', args: {} }]]);
    await expect(runToolLoop({ chat, ctx, system: 's', user: 'u', tools: [], submit, maxToolCalls: 5 })).rejects.toThrow(LoopFailed);
  });

  it('offers only the submit tool once the call limit is reached', async () => {
    const seen: ChatRequest[] = [];
    const chat = scriptedChat([[{ name: 'echo', args: { text: '1' } }], [{ name: 'echo', args: { text: '2' } }], [{ name: 'submit', args: { answer: 1 } }]], seen);
    const out = await runToolLoop({ chat, ctx, system: 's', user: 'u', tools: [echo], submit, maxToolCalls: 3 });

    expect(out.result).toBe(1);
    expect(seen[2]?.tools?.map((t) => (t.type === 'function' ? t.function.name : ''))).toEqual(['submit']);
    expect(seen[2]?.toolChoice).toEqual({ type: 'function', function: { name: 'submit' } });
  });

  it('reports a tool error and malformed arguments to the model instead of crashing', async () => {
    const seen: ChatRequest[] = [];
    const boom: LoopTool = { ...echo, name: 'boom', run: () => { throw new Error('disk on fire'); } };
    const chat = scriptedChat([[{ name: 'boom', args: {} }, { name: 'echo', args: '{not json' }], [{ name: 'submit', args: { answer: 3 } }]], seen);
    const out = await runToolLoop({ chat, ctx, system: 's', user: 'u', tools: [echo, boom], submit, maxToolCalls: 6 });

    expect(out.result).toBe(3);
    const replies = seen[1]?.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(replies).toEqual(['Error: disk on fire', 'Error: the arguments were not valid JSON. Call the tool again with valid JSON.']);
  });
});

describe('code graph usage', () => {
  it('separates import sites from calls and keeps the enclosing function', () => {
    const sites = parseEdges(fixtureText('graph-edges-marked.ndjson'), 'marked');
    expect(sites.filter((s) => s.kind === 'import').map((s) => s.file).sort()).toEqual(['src/outline.js', 'src/render.js']);
    expect(sites.filter((s) => s.kind === 'call').map((s) => [s.file, s.symbol, s.uses])).toEqual([
      ['src/outline.js', 'outline', 'marked.lexer'],
      ['src/render.js', 'renderNote', 'marked'],
      ['src/render.js', 'renderTitle', 'marked.parseInline'],
    ]);
    expect(sites.every((s) => s.provider === 'graph')).toBe(true);
  });

  it('attributes deep imports to their package and ignores other packages', () => {
    const sites = parseEdges(fixtureText('graph-edges-uuid.ndjson'), 'uuid');
    expect(sites.filter((s) => s.kind === 'import').map((s) => s.uses).sort()).toEqual(['uuid/v4', 'uuid/v5']);
    expect(parseEdges(fixtureText('graph-edges-uuid.ndjson'), 'uu')).toEqual([]);
    expect(parseEdges(fixtureText('graph-edges-uuid.ndjson'), 'node:test').map((s) => s.file)).toEqual(['test/ids.test.js']);
  });
});

describe('source scan fallback', () => {
  it('finds require, import, dynamic import and re-export forms', () => {
    const text = [
      "const a = require('pkg');",
      "import b from 'pkg/sub';",
      "const c = await import('pkg');",
      "export { d } from 'pkg';",
      "import 'pkg';",
      "const e = require('pkg-other');",
      "// from 'pkgs'",
    ].join('\n');
    expect(scanImports('f.js', text, 'pkg').map((s) => [s.line, s.uses])).toEqual([[1, 'pkg'], [2, 'pkg/sub'], [3, 'pkg'], [4, 'pkg'], [5, 'pkg']]);
  });

  it('scans a real project and skips node_modules', () => {
    const sites = fallbackUsage('bench/cases/04-uuid-deep-imports/repo', 'uuid');
    expect(sites.map((s) => [s.file, s.uses, s.provider])).toEqual([['src/ids.js', 'uuid/v4', 'fallback'], ['src/keys.js', 'uuid/v5', 'fallback']]);
  });
});

describe('workspace paths', () => {
  it('allows paths inside the workspace and refuses every way out', () => {
    const root = join(scratch, 'ws');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.js'), '');
    writeFileSync(join(scratch, 'secret.txt'), 'secret');
    symlinkSync(join(scratch, 'secret.txt'), join(root, 'link.txt'));

    expect(resolveInside(root, 'src/a.js').endsWith('/ws/src/a.js')).toBe(true);
    expect(resolveInside(root, 'src/new.js').endsWith('/ws/src/new.js')).toBe(true);
    for (const bad of ['../secret.txt', 'src/../../secret.txt', '/etc/passwd', join(scratch, 'secret.txt'), 'link.txt', '.git/config']) {
      expect(() => resolveInside(root, bad), bad).toThrow(PathEscape);
    }
  });
});

describe('priority formula', () => {
  it('weights severity 0.35, usage 0.30, confidence 0.20 and fix availability 0.15', () => {
    expect(priority({ severity: 1, usage: 1, confidence: 1, fixAvailable: 1 })).toBe(1);
    expect(priority({ severity: 0, usage: 0, confidence: 0, fixAvailable: 0 })).toBe(0);
    expect(priority({ severity: 1, usage: 0, confidence: 0, fixAvailable: 0 })).toBe(0.35);
    expect(priority({ severity: 0, usage: 1, confidence: 0, fixAvailable: 0 })).toBe(0.3);
    expect(priority({ severity: 0, usage: 0, confidence: 1, fixAvailable: 0 })).toBe(0.2);
    expect(priority({ severity: 0, usage: 0, confidence: 0, fixAvailable: 1 })).toBe(0.15);
    expect(priority({ severity: 0.75, usage: 0.4, confidence: 1, fixAvailable: 1 })).toBe(0.733);
  });

  it('clamps terms to 0–1 and scales usage by affected sites', () => {
    expect(priority({ severity: 5, usage: -1, confidence: 1, fixAvailable: 1 })).toBe(0.7);
    expect([0, 1, 5, 12].map(usageScore)).toEqual([0, 0.2, 1, 1]);
  });

  it('ranks a confirmed high advisory above an unconfirmed breaking change with the same usage', () => {
    const base = { id: 'f', package: 'p', rationale: '', priority: null };
    const advisory: FindingRecord = { ...base, kind: 'advisory', status: 'confirmed', severity: 0.75, confidence: 1, usage_score: 0.4 };
    const breaking: FindingRecord = { ...base, kind: 'breaking', status: 'potential', severity: null, confidence: 0.5, usage_score: 0.4 };
    expect(termsFor(breaking, true).severity).toBe(0.5);
    expect(priority(termsFor(advisory, true))).toBeGreaterThan(priority(termsFor(breaking, true)));
  });
});

describe('impact state', () => {
  const markedInfo: IntelTools['fetchPackageInfo'] = async (name, installed) => ({
    name, installed, latest: '18.1.0', deprecated: null, repository: { owner: 'markedjs', repo: 'marked' },
    majorsCrossed: [{ major: 4, version: '4.0.0', publishedAt: null }], latestIsEsmOnly: true, latestEngines: null, sourceUrl: 'https://registry.npmjs.org/marked',
  });
  const tools: IntelTools = {
    readInventory: realTools.readInventory,
    runNpmAudit: async () => [],
    fetchPackageInfo: markedInfo,
    fetchReleaseNotes: async () => [{ version: '4.0.0', url: 'https://github.com/markedjs/marked/releases/tag/v4.0.0', kind: 'release_notes', excerpt: 'Default export removed.', publishedAt: null }],
    fetchAdvisories: async () => [],
  };
  const provider: ImpactProvider = { edges: async () => fixtureText('graph-edges-marked.ndjson'), callers: async () => [{ symbol: 'caller', file: 'src/x.js', line: 3 }], search: async () => [{ file: 'src/render.js', line: 3, symbol: 'renderNote', snippet: 'function renderNote(source) {' }] };
  const report = (sites: { file: string; verdict: string }[]) => ({
    changed_apis: [{ api: 'default export', change: 'removed', source_url: 'https://github.com/markedjs/marked/releases/tag/v4.0.0' }],
    sites: sites.map((s) => ({ ...s, line: 1, api: 'marked()', reason: 'because' })),
    summary: 'The default export was removed.',
  });

  async function run(chat: Chat, p: ImpactProvider = provider) {
    const db = openDb(':memory:');
    // Repair has its own tests; here the pipeline stops being real after prioritisation.
    const { INTAKE, INVENTORY, INTEL, IMPACT, PRIORITIZE } = createHandlers(tools, { chat, provider: p });
    const handlers = { ...stubHandlers, INTAKE, INVENTORY, INTEL, IMPACT, PRIORITIZE };
    const orchestrator = new Orchestrator({ db, handlers, limits: loadLimits() });
    const inv = await orchestrator.run(orchestrator.start('bench/cases/03-marked-default-export/repo').id);
    return { inv, records: new Records(db), journal: new Journal(db) };
  }

  it('records the affected file, leaves the decoy out, and scores the finding', async () => {
    const seen: ChatRequest[] = [];
    const chat = scriptedChat(
      [
        [{ name: 'read_file', args: { path: 'src/render.js' } }, { name: 'read_file', args: { path: '../../../etc/passwd' } }, { name: 'find_callers', args: { symbol: 'renderNote' } }],
        [{ name: 'report_impact', args: report([{ file: 'src/render.js', verdict: 'affected' }, { file: 'src/outline.js', verdict: 'not_affected' }]) }],
      ],
      seen,
    );
    const { inv, records, journal } = await run(chat);

    const [finding] = records.findings(inv.id);
    expect(finding).toMatchObject({ package: 'marked', kind: 'breaking', status: 'potential', confidence: 0.5, usage_score: 0.2 });
    expect(finding?.priority).toBe(priority({ severity: 0.5, usage: 0.2, confidence: 0.5, fixAvailable: 1 }));
    expect(records.affectedSites(inv.id)).toMatchObject([{ file: 'src/render.js', symbol: 'renderNote', provider: 'graph' }]);

    // The prompt names the graph's usage sites and the release note; tool results come from the workspace only.
    const first = String(seen[0]?.messages[1]?.content);
    expect(first).toContain('src/render.js:3  calls marked (in renderNote)');
    expect(first).toContain('Default export removed.');
    const replies = seen[1]?.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)) ?? [];
    expect(replies[0]).toContain("const marked = require('marked');");
    expect(replies[1]).toBe('Error: Path is outside the workspace: ../../../etc/passwd');
    expect(replies[2]).toBe('caller  src/x.js:3');
    expect(journal.output<ImpactResult>(inv.id, 'IMPACT', 'impact_reasoning')?.toolCalls).toHaveLength(4);
  });

  it('marks the finding not affected when no site is affected', async () => {
    const chat = scriptedChat([[{ name: 'report_impact', args: report([{ file: 'src/render.js', verdict: 'not_affected' }]) }]]);
    const { inv, records } = await run(chat);
    expect(records.findings(inv.id)[0]).toMatchObject({ status: 'not_affected', usage_score: 0, priority: null });
    expect(records.affectedSites(inv.id)).toEqual([]);
  });

  it('rejects a report that names a file the project does not have', async () => {
    const seen: ChatRequest[] = [];
    const chat = scriptedChat(
      [
        [{ name: 'report_impact', args: report([{ file: 'src/imaginary.js', verdict: 'affected' }]) }],
        [{ name: 'report_impact', args: report([{ file: 'src/render.js', verdict: 'affected' }]) }],
      ],
      seen,
    );
    const { inv, records } = await run(chat);
    expect(String(seen[1]?.messages.at(-1)?.content)).toContain('These files do not exist in the project: src/imaginary.js');
    expect(records.affectedSites(inv.id).map((s) => s.file)).toEqual(['src/render.js']);
  });

  it('falls back to the source scan when the code graph is unavailable', async () => {
    const seen: ChatRequest[] = [];
    const chat = scriptedChat([[{ name: 'report_impact', args: report([{ file: 'src/render.js', verdict: 'affected' }]) }]], seen);
    const broken: ImpactProvider = { edges: async () => { throw new Error('entire graph edges failed: spawn entire ENOENT'); }, callers: async () => [], search: async () => [] };
    const { inv, records, journal } = await run(chat, broken);

    expect(journal.output<{ graphError: string }>(inv.id, 'IMPACT', 'usage_map')?.graphError).toContain('ENOENT');
    expect(String(seen[0]?.messages[1]?.content)).toContain('(from a source scan)');
    expect(records.affectedSites(inv.id)).toMatchObject([{ file: 'src/render.js', provider: 'fallback' }]);
  });
});
