import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers, stubHandlers } from '../src/agent/handlers.ts';
import { realTools, type IntelSummary, type IntelTools } from '../src/agent/intel.ts';
import { repoDir } from '../src/agent/intake.ts';
import { loadLimits } from '../src/agent/limits.ts';
import { Orchestrator } from '../src/agent/orchestrator.ts';
import { openDb } from '../src/state/db.ts';
import { Journal } from '../src/state/journal.ts';
import { Records } from '../src/state/records.ts';
import { parseAdvisories } from '../src/tools/advisories.ts';
import { parseNpmAudit } from '../src/tools/npmCli.ts';
import { parsePackument } from '../src/tools/npmRegistry.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

let workspace: string;
const previous = process.env.VERITAS_WORKSPACE_DIR;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'veritas-test-'));
  process.env.VERITAS_WORKSPACE_DIR = workspace;
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  if (previous === undefined) delete process.env.VERITAS_WORKSPACE_DIR;
  else process.env.VERITAS_WORKSPACE_DIR = previous;
});

/** The lockfile is read for real from a benchmark case; everything that would use the network is a recording. */
function recordedTools(calls: string[], overrides: Partial<IntelTools> = {}): IntelTools {
  return {
    readInventory: realTools.readInventory,
    runNpmAudit: async () => { calls.push('audit'); return []; },
    fetchPackageInfo: async (name, installed) => { calls.push(`registry:${name}`); return parsePackument(fixture(`packument-${name}.json`), installed); },
    fetchReleaseNotes: async (_repo, versions) => {
      calls.push(`notes:${versions.join(',')}`);
      return versions.map((version) => ({ version, url: `https://github.com/chalk/chalk/releases/tag/v${version}`, kind: 'release_notes' as const, excerpt: '### Breaking\n- pure ESM', publishedAt: null }));
    },
    fetchAdvisories: async (name) => { calls.push(`advisories:${name}`); return parseAdvisories(fixture(`advisories-${name}.json`), name); },
    ...overrides,
  };
}

/** The states under test are real; impact analysis and prioritisation have their own tests. */
const upToIntel = (tools: IntelTools) => {
  const { INTAKE, INVENTORY, INTEL } = createHandlers(tools);
  return { ...stubHandlers, INTAKE, INVENTORY, INTEL };
};

async function investigate(caseId: string, tools: IntelTools) {
  const db = openDb(':memory:');
  const orchestrator = new Orchestrator({ db, handlers: upToIntel(tools), limits: loadLimits() });
  const inv = await orchestrator.run(orchestrator.start(`bench/cases/${caseId}/repo`).id);
  return { db, inv, orchestrator, records: new Records(db), journal: new Journal(db) };
}

describe('intake, inventory and intel', () => {
  it('copies the repository into a private workspace with a baseline commit', async () => {
    const { inv } = await investigate('01-chalk-esm-only', recordedTools([]));
    expect(inv.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(repoDir(inv.id), 'src/format.js'), 'utf8')).toContain("require('chalk')");
  });

  it('records a potential breaking finding with registry and release-note sources', async () => {
    const calls: string[] = [];
    const { inv, records, journal } = await investigate('01-chalk-esm-only', recordedTools(calls));

    expect(records.dependencies(inv.id).find((d) => d.name === 'chalk')).toMatchObject({ installed: '4.1.2', latest: '6.0.1', direct: 1 });
    const [finding, ...others] = records.findings(inv.id);
    expect(others).toEqual([]);
    expect(finding).toMatchObject({ package: 'chalk', kind: 'breaking', status: 'potential', severity: null });
    expect(finding?.rationale).toContain('ES module only');
    expect(records.sources(inv.id).map((s) => [s.kind, s.verified])).toEqual([['registry', 1], ['release_notes', 1], ['release_notes', 1]]);
    expect(calls).toEqual(['audit', 'registry:chalk', 'notes:5.0.0,6.0.0']);
    expect(journal.output<IntelSummary>(inv.id, 'INTEL', 'candidates')?.candidates).toMatchObject([{ package: 'chalk', kind: 'breaking', targetVersion: '6.0.1' }]);
  });

  it('records an advisory finding with the version that fixes every reviewed advisory', async () => {
    const tools = recordedTools([], {
      runNpmAudit: async () => parseNpmAudit(fixture('audit-lodash.json')),
      fetchPackageInfo: async (name, installed) => ({ name, installed, latest: '4.18.1', deprecated: null, repository: null, majorsCrossed: [], latestIsEsmOnly: false, latestEngines: null, sourceUrl: 'https://registry.npmjs.org/lodash' }),
    });
    const { inv, records, journal } = await investigate('06-lodash-advisory', tools);

    const [finding, ...others] = records.findings(inv.id);
    expect(others).toEqual([]);
    expect(finding).toMatchObject({ package: 'lodash', kind: 'advisory', status: 'potential', severity: 0.75 });
    expect(finding?.rationale).toContain('6 published advisories affect lodash@4.17.15');
    expect(finding?.rationale).toContain('All are fixed from 4.18.0.');
    const sources = records.sources(inv.id);
    expect(sources).toHaveLength(6);
    expect(sources.every((s) => s.kind === 'advisory' && s.verified === 1)).toBe(true);
    expect(journal.output<IntelSummary>(inv.id, 'INTEL', 'candidates')?.candidates[0]).toMatchObject({ kind: 'advisory', targetVersion: '4.18.0' });
  });

  it('continues without a source that cannot be reached, and says which one', async () => {
    const tools = recordedTools([], { fetchReleaseNotes: async () => { throw new Error('GET https://api.github.com/... returned 503'); } });
    const { inv, records, journal } = await investigate('01-chalk-esm-only', tools);

    expect(inv.status).toBe('awaiting_approval');
    expect(records.sources(inv.id).map((s) => s.kind)).toEqual(['registry']);
    expect(journal.output<IntelSummary>(inv.id, 'INTEL', 'candidates')?.unavailable).toEqual(['release_notes for chalk: Error: GET https://api.github.com/... returned 503']);
  });

  it('does not repeat lookups when an investigation is resumed', async () => {
    const calls: string[] = [];
    let crash = true;
    const tools = recordedTools(calls);
    const db = openDb(':memory:');
    const handlers = upToIntel(tools);
    const intel = handlers.INTEL;
    handlers.INTEL = async (ctx) => {
      const next = await intel(ctx);
      if (crash) throw new Error('process killed');
      return next;
    };
    const orchestrator = new Orchestrator({ db, handlers, limits: loadLimits() });
    const { id } = orchestrator.start('bench/cases/01-chalk-esm-only/repo');

    await expect(orchestrator.run(id)).rejects.toThrow('process killed');
    crash = false;
    await orchestrator.run(id);

    expect(calls).toEqual(['audit', 'registry:chalk', 'notes:5.0.0,6.0.0']);
    expect(new Records(db).findings(id)).toHaveLength(1);
    expect(new Records(db).sources(id)).toHaveLength(3);
  });
});
