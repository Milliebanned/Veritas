import { createImpactHandler } from './impact.ts';
import { intake } from './intake.ts';
import { createInventoryHandler, createIntelHandler, realTools, type IntelTools } from './intel.ts';
import { prioritize } from './prioritize.ts';
import { createRepairHandlers, type RepairDeps } from './repair.ts';
import type { Handlers, State, StateHandler } from './states.ts';

/** Placeholder for a state that is not implemented yet: records one step and moves on. */
const stub =
  (name: string, next: State): StateHandler =>
  async (ctx) => {
    await ctx.step(name, { repo: ctx.repoUrl }, () => ({ stub: true }));
    return next;
  };

/** Every state as a placeholder. Tests build on this; real handlers replace entries below. */
export const stubHandlers: Handlers = {
  INTAKE: stub('intake', 'INVENTORY'),
  INVENTORY: stub('inventory', 'INTEL'),
  INTEL: stub('intel', 'IMPACT'),
  IMPACT: stub('impact', 'PRIORITIZE'),
  PRIORITIZE: stub('prioritize', 'PLAN_REPAIR'),
  PLAN_REPAIR: stub('plan_repair', 'REPORT'),
  BASELINE: stub('baseline', 'PATCH'),
  PATCH: stub('patch', 'TEST'),
  TEST: stub('test', 'VERIFY'),
  DIAGNOSE: stub('diagnose', 'PATCH'),
  VERIFY: stub('verify', 'REPORT'),
  REPORT: stub('report', 'AWAITING_APPROVAL'),
};

/** Handlers are replaced one by one as each state is implemented. */
export function createHandlers(tools: IntelTools = realTools, deps: RepairDeps = {}): Handlers {
  return {
    ...stubHandlers,
    INTAKE: intake,
    INVENTORY: createInventoryHandler(tools),
    INTEL: createIntelHandler(tools),
    IMPACT: createImpactHandler(deps),
    PRIORITIZE: prioritize,
    ...createRepairHandlers(deps),
  };
}

export const handlers: Handlers = createHandlers();
