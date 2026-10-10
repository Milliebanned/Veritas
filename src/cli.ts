#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { handlers } from './agent/handlers.ts';
import { Orchestrator } from './agent/orchestrator.ts';
import { initTracing, shutdownTracing } from './observability/neatlogs.ts';
import { openDb } from './state/db.ts';
import { Journal } from './state/journal.ts';

const USAGE = `Veritas — Verified changes. Reliable software.

Usage:
  veritas investigate <repo-url-or-path>   Start a new investigation
  veritas resume <investigation-id>        Continue an interrupted investigation
  veritas status [investigation-id]        Show investigations, or the steps of one
`;

async function main(): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [command, arg] = process.argv.slice(2);
  const db = openDb();
  const journal = new Journal(db);

  if (command === 'status') {
    if (!arg) {
      console.table(journal.listInvestigations().map(({ id, repo_url, status, current_state }) => ({ id, repo_url, status, current_state })));
      return 0;
    }
    const inv = journal.getInvestigation(arg);
    if (!inv) return fail(`Unknown investigation ${arg}`);
    console.log(`${inv.id}  ${inv.status}  state=${inv.current_state}  repo=${inv.repo_url}`);
    console.table(journal.steps(arg).map(({ state, name, status, attempt, duration_ms, error }) => ({ state, name, status, attempt, duration_ms, error })));
    return 0;
  }

  if (command !== 'investigate' && command !== 'resume') {
    console.log(USAGE);
    return command ? 1 : 0;
  }
  if (!arg) return fail(USAGE);

  await initTracing();
  const orchestrator = new Orchestrator({ db, handlers });
  try {
    const id = command === 'investigate' ? orchestrator.start(arg).id : arg;
    console.log(`investigation ${id}`);
    const inv = await orchestrator.run(id);
    console.log(`${inv.status}  state=${inv.current_state}`);
    return 0;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await shutdownTracing();
  }
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

process.exitCode = await main();
