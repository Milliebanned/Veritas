import type { Db } from '../state/db.ts';
import { Journal, type Investigation } from '../state/journal.ts';
import { traced } from '../observability/neatlogs.ts';
import { loadLimits, type Limits } from './limits.ts';
import { TRANSITIONS, type Handlers, type RunContext, type State } from './states.ts';

export class InvestigationTimeout extends Error {
  constructor(ms: number) {
    super(`Investigation exceeded its ${ms} ms limit`);
    this.name = 'InvestigationTimeout';
  }
}

export interface OrchestratorOptions {
  db: Db;
  handlers: Handlers;
  limits?: Limits;
}

export class Orchestrator {
  private readonly journal: Journal;
  private readonly limits: Limits;

  constructor(private readonly opts: OrchestratorOptions) {
    this.journal = new Journal(opts.db);
    this.limits = opts.limits ?? loadLimits();
  }

  start(repoUrl: string): Investigation {
    return this.journal.createInvestigation(repoUrl, 'INTAKE');
  }

  /**
   * Drives an investigation from its recorded state until it needs approval.
   * Safe to call again after a crash: finished steps are reused from the journal.
   */
  async run(investigationId: string): Promise<Investigation> {
    const inv = this.journal.getInvestigation(investigationId);
    if (!inv) throw new Error(`Unknown investigation ${investigationId}`);
    if (inv.status === 'awaiting_approval' || inv.status === 'done') return inv;

    this.journal.setStatus(investigationId, 'running');
    const deadline = Date.now() + this.limits.investigationTimeoutMs;

    return traced(
      'veritas.investigation',
      'WORKFLOW',
      { investigation_id: investigationId, repo: inv.repo_url, resumed_from: inv.current_state },
      async () => {
        let state = inv.current_state as State;
        try {
          while (state !== 'AWAITING_APPROVAL') {
            if (Date.now() > deadline) throw new InvestigationTimeout(this.limits.investigationTimeoutMs);
            const next = await this.runState(inv, state);
            if (!TRANSITIONS[state].includes(next)) {
              throw new Error(`Illegal transition ${state} -> ${next}`);
            }
            this.journal.setState(investigationId, next);
            state = next;
          }
          this.journal.setStatus(investigationId, 'awaiting_approval');
        } catch (err) {
          this.journal.setStatus(investigationId, 'failed');
          throw err;
        }
        return this.journal.getInvestigation(investigationId)!;
      },
    );
  }

  private runState(inv: Investigation, state: Exclude<State, 'AWAITING_APPROVAL'>): Promise<State> {
    const ctx: RunContext = {
      investigationId: inv.id,
      repoUrl: inv.repo_url,
      db: this.opts.db,
      journal: this.journal,
      limits: this.limits,
      step: async (name, input, fn) => {
        const result = await this.journal.runStep(inv.id, state, name, input, () =>
          traced(`step.${name}`, 'CHAIN', { state, step: name }, fn, input),
        );
        // A reused step still shows in the trace, marked, so skipped work is visible.
        if (result.reused) await traced(`step.${name}`, 'CHAIN', { state, step: name, reused: true }, () => undefined);
        return result.output;
      },
    };
    return traced(`state.${state}`, 'CHAIN', { state }, async (set) => {
      const next = await this.opts.handlers[state](ctx);
      set({ next_state: next });
      return next;
    });
  }
}
