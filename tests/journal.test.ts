import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/agent/orchestrator.ts';
import { loadLimits } from '../src/agent/limits.ts';
import { stubHandlers } from '../src/agent/handlers.ts';
import type { Handlers } from '../src/agent/states.ts';
import { openDb } from '../src/state/db.ts';
import { idemKey, Journal, stableJson } from '../src/state/journal.ts';

describe('journal', () => {
  it('hashes equal inputs to the same key regardless of key order', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(idemKey('S', 'n', { a: 1, b: 2 })).toBe(idemKey('S', 'n', { b: 2, a: 1 }));
    expect(idemKey('S', 'n', { a: 1 })).not.toBe(idemKey('S', 'n', { a: 2 }));
  });

  it('runs a finished step once and reuses its output', async () => {
    const journal = new Journal(openDb(':memory:'));
    const inv = journal.createInvestigation('repo', 'INTAKE');
    let calls = 0;
    const body = () => ({ n: ++calls });

    const first = await journal.runStep(inv.id, 'INTAKE', 'clone', { url: 'x' }, body);
    const second = await journal.runStep(inv.id, 'INTAKE', 'clone', { url: 'x' }, body);

    expect(first).toEqual({ output: { n: 1 }, reused: false });
    expect(second).toEqual({ output: { n: 1 }, reused: true });
    expect(calls).toBe(1);
  });

  it('records a failure and runs the step again on the next call', async () => {
    const journal = new Journal(openDb(':memory:'));
    const inv = journal.createInvestigation('repo', 'INTAKE');
    let calls = 0;
    const flaky = () => {
      if (++calls === 1) throw new Error('boom');
      return 'ok';
    };

    await expect(journal.runStep(inv.id, 'INTAKE', 'fetch', null, flaky)).rejects.toThrow('boom');
    expect(journal.steps(inv.id)[0]).toMatchObject({ status: 'failed', error: 'Error: boom', attempt: 1 });

    const retry = await journal.runStep(inv.id, 'INTAKE', 'fetch', null, flaky);
    expect(retry).toEqual({ output: 'ok', reused: false });
    expect(journal.steps(inv.id)[0]).toMatchObject({ status: 'done', error: null, attempt: 2 });
  });
});

describe('orchestrator', () => {
  it('walks the stub pipeline to AWAITING_APPROVAL', async () => {
    const db = openDb(':memory:');
    const orchestrator = new Orchestrator({ db, handlers: stubHandlers, limits: loadLimits() });
    const inv = await orchestrator.run(orchestrator.start('repo').id);

    expect(inv).toMatchObject({ status: 'awaiting_approval', current_state: 'AWAITING_APPROVAL' });
    expect(new Journal(db).steps(inv.id).map((s) => s.state)).toEqual([
      'INTAKE', 'INVENTORY', 'INTEL', 'IMPACT', 'PRIORITIZE', 'PLAN_REPAIR', 'REPORT',
    ]);
  });

  it('resumes after a crash without repeating finished steps', async () => {
    const db = openDb(':memory:');
    const ran: string[] = [];
    let crash = true;
    const handlers: Handlers = {
      ...stubHandlers,
      INTEL: async (ctx) => {
        await ctx.step('releases', {}, () => { ran.push('releases'); return 1; });
        await ctx.step('advisories', {}, () => {
          ran.push('advisories');
          if (crash) throw new Error('process killed');
          return 2;
        });
        return 'IMPACT';
      },
    };
    const orchestrator = new Orchestrator({ db, handlers, limits: loadLimits() });
    const { id } = orchestrator.start('repo');

    await expect(orchestrator.run(id)).rejects.toThrow('process killed');
    expect(new Journal(db).getInvestigation(id)).toMatchObject({ status: 'failed', current_state: 'INTEL' });

    crash = false;
    const inv = await orchestrator.run(id);

    expect(inv.status).toBe('awaiting_approval');
    // 'releases' finished before the crash, so it ran once; only 'advisories' ran again.
    expect(ran).toEqual(['releases', 'advisories', 'advisories']);
    const steps = new Journal(db).steps(id);
    expect(steps.filter((s) => s.state === 'INTAKE')).toHaveLength(1);
    expect(steps.find((s) => s.name === 'advisories')).toMatchObject({ status: 'done', attempt: 2 });
  });

  it('rejects a transition the state machine does not allow', async () => {
    const db = openDb(':memory:');
    const handlers: Handlers = { ...stubHandlers, PATCH: async () => 'REPORT', PLAN_REPAIR: async () => 'BASELINE', BASELINE: async () => 'PATCH' };
    const orchestrator = new Orchestrator({ db, handlers, limits: loadLimits() });
    await expect(orchestrator.run(orchestrator.start('repo').id)).rejects.toThrow('Illegal transition PATCH -> REPORT');
  });
});
