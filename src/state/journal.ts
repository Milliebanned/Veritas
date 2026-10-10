import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.ts';

export interface Investigation {
  id: string;
  repo_url: string;
  commit_sha: string | null;
  status: 'running' | 'awaiting_approval' | 'done' | 'failed';
  current_state: string;
  started_at: string;
  finished_at: string | null;
}

export interface StepRecord {
  id: number;
  state: string;
  name: string;
  idem_key: string;
  status: 'running' | 'done' | 'failed';
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  started_at: string;
  duration_ms: number | null;
  attempt: number;
}

export interface StepResult<T> {
  output: T;
  /** True when the output came from the journal and the step body did not run. */
  reused: boolean;
  /** How many times this step has been started; above 1 means an earlier run failed or was interrupted. */
  attempt: number;
}

/** JSON with sorted object keys, so equal inputs always hash the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function idemKey(state: string, name: string, input: unknown): string {
  return createHash('sha256').update(`${state}\n${name}\n${stableJson(input ?? null)}`).digest('hex');
}

/**
 * Durable record of what an investigation has done. A step that finished is
 * never run again for the same input: its stored output is returned instead.
 */
export class Journal {
  constructor(private readonly db: Db) {}

  createInvestigation(repoUrl: string, initialState: string): Investigation {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO investigations (id, repo_url, current_state, started_at) VALUES (?, ?, ?, ?)')
      .run(id, repoUrl, initialState, new Date().toISOString());
    return this.getInvestigation(id)!;
  }

  getInvestigation(id: string): Investigation | undefined {
    return this.db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as Investigation | undefined;
  }

  listInvestigations(): Investigation[] {
    return this.db.prepare('SELECT * FROM investigations ORDER BY started_at DESC').all() as unknown as Investigation[];
  }

  setState(id: string, state: string): void {
    this.db.prepare('UPDATE investigations SET current_state = ? WHERE id = ?').run(state, id);
  }

  setStatus(id: string, status: Investigation['status']): void {
    const finished = status === 'running' ? null : new Date().toISOString();
    this.db.prepare('UPDATE investigations SET status = ?, finished_at = ? WHERE id = ?').run(status, finished, id);
  }

  setCommit(id: string, commitSha: string): void {
    this.db.prepare('UPDATE investigations SET commit_sha = ? WHERE id = ?').run(commitSha, id);
  }

  /** Output of a finished step, for a later state that builds on it. */
  output<T>(investigationId: string, state: string, name: string): T | undefined {
    const row = this.db
      .prepare("SELECT output_json FROM steps WHERE investigation_id = ? AND state = ? AND name = ? AND status = 'done' ORDER BY id DESC")
      .get(investigationId, state, name) as { output_json: string | null } | undefined;
    return row ? (JSON.parse(row.output_json ?? 'null') as T) : undefined;
  }

  steps(id: string): StepRecord[] {
    return this.db
      .prepare('SELECT * FROM steps WHERE investigation_id = ? ORDER BY id')
      .all(id) as unknown as StepRecord[];
  }

  async runStep<T>(
    investigationId: string,
    state: string,
    name: string,
    input: unknown,
    fn: () => Promise<T> | T,
  ): Promise<StepResult<T>> {
    const key = idemKey(state, name, input);
    const prior = this.db
      .prepare('SELECT * FROM steps WHERE investigation_id = ? AND idem_key = ?')
      .get(investigationId, key) as StepRecord | undefined;

    if (prior?.status === 'done') {
      return { output: JSON.parse(prior.output_json ?? 'null') as T, reused: true, attempt: prior.attempt };
    }

    const startedAt = new Date().toISOString();
    if (prior) {
      // A step left 'running' means the process died inside it; 'failed' means it threw. Either way, run again.
      this.db
        .prepare("UPDATE steps SET status = 'running', error = NULL, started_at = ?, attempt = attempt + 1 WHERE id = ?")
        .run(startedAt, prior.id);
    } else {
      this.db
        .prepare(
          "INSERT INTO steps (investigation_id, state, name, idem_key, status, input_json, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
        )
        .run(investigationId, state, name, key, stableJson(input ?? null), startedAt);
    }

    const t0 = Date.now();
    const finish = this.db.prepare(
      'UPDATE steps SET status = ?, output_json = ?, error = ?, duration_ms = ? WHERE investigation_id = ? AND idem_key = ?',
    );
    try {
      const output = await fn();
      finish.run('done', JSON.stringify(output ?? null), null, Date.now() - t0, investigationId, key);
      return { output, reused: false, attempt: (prior?.attempt ?? 0) + 1 };
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      finish.run('failed', null, message, Date.now() - t0, investigationId, key);
      throw err;
    }
  }
}
