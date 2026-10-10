import type { Journal } from '../state/journal.ts';
import type { Db } from '../state/db.ts';
import type { Limits } from './limits.ts';

export const STATES = [
  'INTAKE',
  'INVENTORY',
  'INTEL',
  'IMPACT',
  'PRIORITIZE',
  'PLAN_REPAIR',
  'BASELINE',
  'PATCH',
  'TEST',
  'DIAGNOSE',
  'VERIFY',
  'REPORT',
  'AWAITING_APPROVAL',
] as const;

export type State = (typeof STATES)[number];

/** Allowed moves. The orchestrator rejects anything else, so a handler bug cannot skip verification. */
export const TRANSITIONS: Record<State, readonly State[]> = {
  INTAKE: ['INVENTORY'],
  INVENTORY: ['INTEL'],
  INTEL: ['IMPACT'],
  IMPACT: ['PRIORITIZE'],
  PRIORITIZE: ['PLAN_REPAIR'],
  PLAN_REPAIR: ['BASELINE', 'REPORT'],
  BASELINE: ['PATCH', 'VERIFY', 'PLAN_REPAIR', 'REPORT'],
  PATCH: ['TEST'],
  TEST: ['VERIFY', 'DIAGNOSE'],
  DIAGNOSE: ['PATCH', 'PLAN_REPAIR', 'REPORT'],
  VERIFY: ['PLAN_REPAIR', 'REPORT'],
  REPORT: ['AWAITING_APPROVAL'],
  AWAITING_APPROVAL: [],
};

export interface RunContext {
  investigationId: string;
  repoUrl: string;
  db: Db;
  journal: Journal;
  limits: Limits;
  /** Runs a journaled step inside the current state: skipped and reused if it already finished. */
  step<T>(name: string, input: unknown, fn: () => Promise<T> | T): Promise<T>;
}

export type StateHandler = (ctx: RunContext) => Promise<State>;
export type Handlers = Record<Exclude<State, 'AWAITING_APPROVAL'>, StateHandler>;
