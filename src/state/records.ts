import { createHash } from 'node:crypto';
import type { Db } from './db.ts';

export interface DependencyRecord {
  name: string;
  installed: string | null;
  latest: string | null;
  direct: number;
  deprecated: string | null;
}

/** `unchecked` records a package Veritas could not examine, so a failed lookup is never reported as "nothing found". */
export type FindingKind = 'breaking' | 'advisory' | 'deprecation' | 'unchecked';
export type FindingStatus = 'confirmed' | 'potential' | 'unresolved' | 'not_affected';

export interface FindingInput {
  package: string;
  kind: FindingKind;
  status: FindingStatus;
  /** 0–1, per the priority formula. Null until it is known. */
  severity: number | null;
  rationale: string;
}

export interface FindingRecord extends FindingInput {
  id: string;
  confidence: number | null;
  usage_score: number | null;
  priority: number | null;
}

export interface SourceInput {
  url: string;
  kind: 'registry' | 'release_notes' | 'changelog' | 'migration_guide' | 'advisory';
  excerpt: string;
  /** True when the excerpt was read from the URL; false when it is a model's inference. */
  verified: boolean;
}

export interface SourceRecord {
  id: number;
  finding_id: string | null;
  url: string;
  kind: string;
  retrieved_at: string;
  excerpt: string | null;
  verified: number;
}

export interface AffectedSiteRecord {
  finding_id: string;
  file: string;
  line: number | null;
  symbol: string | null;
  provider: string;
}

export type RepairStatus = 'planned' | 'reproduced' | 'patched' | 'verified' | 'unresolved' | 'not_reproduced';

export interface RepairRecord {
  id: number;
  investigation_id: string;
  package: string;
  from_version: string;
  target_version: string;
  /** JSON array of the finding ids this repair addresses. */
  finding_ids: string;
  branch: string;
  base_commit: string | null;
  bump_commit: string | null;
  status: RepairStatus;
  attempts: number;
  note: string | null;
}

export interface AttemptRecord {
  id: number;
  finding_id: string;
  n: number;
  plan_text: string | null;
  diff: string | null;
  outcome: string | null;
  diagnosis_text: string | null;
}

export interface TestRunRecord {
  id: number;
  attempt_id: number | null;
  label: string;
  command: string;
  exit_code: number | null;
  passed: number | null;
  failed: number | null;
  log_path: string | null;
  duration_ms: number | null;
}

/** One finding per package and kind in an investigation, so writing it again replaces it. */
export const findingId = (investigationId: string, kind: string, pkg: string) =>
  createHash('sha256').update(`${investigationId}\n${kind}\n${pkg}`).digest('hex').slice(0, 16);

/** Reads and writes what an investigation has learned. Every write can be repeated safely. */
export class Records {
  constructor(private readonly db: Db) {}

  saveInventory(investigationId: string, entries: { name: string; installed: string; direct: boolean }[]): void {
    const insert = this.db.prepare(
      `INSERT INTO dependencies (investigation_id, name, installed, direct) VALUES (?, ?, ?, ?)
       ON CONFLICT (investigation_id, name) DO UPDATE SET installed = excluded.installed, direct = excluded.direct`,
    );
    for (const e of entries) insert.run(investigationId, e.name, e.installed, e.direct ? 1 : 0);
  }

  setRegistryInfo(investigationId: string, name: string, latest: string, deprecated: string | null): void {
    this.db
      .prepare('UPDATE dependencies SET latest = ?, deprecated = ? WHERE investigation_id = ? AND name = ?')
      .run(latest, deprecated, investigationId, name);
  }

  saveFinding(investigationId: string, finding: FindingInput, sources: SourceInput[]): string {
    const id = findingId(investigationId, finding.kind, finding.package);
    this.db
      .prepare(
        `INSERT INTO findings (id, investigation_id, package, kind, status, severity, rationale) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, severity = excluded.severity, rationale = excluded.rationale`,
      )
      .run(id, investigationId, finding.package, finding.kind, finding.status, finding.severity, finding.rationale);
    this.db.prepare('DELETE FROM sources WHERE finding_id = ?').run(id);
    const insert = this.db.prepare(
      'INSERT INTO sources (finding_id, investigation_id, url, kind, retrieved_at, excerpt, verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const retrievedAt = new Date().toISOString();
    for (const s of sources) insert.run(id, investigationId, s.url, s.kind, retrievedAt, s.excerpt, s.verified ? 1 : 0);
    return id;
  }

  /** Records what impact analysis concluded for a finding and where the package is used. */
  saveImpact(
    findingId: string,
    impact: { status: FindingStatus; confidence: number; usageScore: number; rationale: string },
    sites: { file: string; line: number | null; symbol: string | null; provider: string }[],
  ): void {
    this.db
      .prepare('UPDATE findings SET status = ?, confidence = ?, usage_score = ?, rationale = ? WHERE id = ?')
      .run(impact.status, impact.confidence, impact.usageScore, impact.rationale, findingId);
    this.db.prepare('DELETE FROM affected_sites WHERE finding_id = ?').run(findingId);
    const insert = this.db.prepare('INSERT INTO affected_sites (finding_id, file, line, symbol, provider) VALUES (?, ?, ?, ?, ?)');
    for (const s of sites) insert.run(findingId, s.file, s.line, s.symbol, s.provider);
  }

  setPriority(findingId: string, priority: number): void {
    this.db.prepare('UPDATE findings SET priority = ? WHERE id = ?').run(priority, findingId);
  }

  sourcesFor(findingId: string): SourceRecord[] {
    return this.db.prepare('SELECT * FROM sources WHERE finding_id = ? ORDER BY id').all(findingId) as unknown as SourceRecord[];
  }

  affectedSites(investigationId: string): AffectedSiteRecord[] {
    return this.db
      .prepare(
        `SELECT s.finding_id, s.file, s.line, s.symbol, s.provider FROM affected_sites s
         JOIN findings f ON f.id = s.finding_id WHERE f.investigation_id = ? ORDER BY s.id`,
      )
      .all(investigationId) as unknown as AffectedSiteRecord[];
  }

  /** Plans one repair per package. Planning again leaves existing repairs as they are. */
  planRepair(investigationId: string, repair: { package: string; from: string; target: string; findingIds: string[]; branch: string }): void {
    this.db
      .prepare(
        `INSERT INTO repairs (investigation_id, package, from_version, target_version, finding_ids, branch) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (investigation_id, package) DO NOTHING`,
      )
      .run(investigationId, repair.package, repair.from, repair.target, JSON.stringify(repair.findingIds), repair.branch);
  }

  repairs(investigationId: string): RepairRecord[] {
    return this.db.prepare('SELECT * FROM repairs WHERE investigation_id = ? ORDER BY id').all(investigationId) as unknown as RepairRecord[];
  }

  /** The repair being worked on: the first one that has not reached an end state. */
  currentRepair(investigationId: string): RepairRecord | undefined {
    return this.repairs(investigationId).find((r) => r.status === 'planned' || r.status === 'reproduced' || r.status === 'patched');
  }

  updateRepair(id: number, fields: Partial<Pick<RepairRecord, 'status' | 'attempts' | 'note' | 'base_commit' | 'bump_commit'>>): void {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE repairs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v as string | number | null), id);
  }

  setFindingStatus(findingId: string, status: FindingStatus, fields: { severity?: number; confidence?: number; note?: string } = {}): void {
    this.db
      .prepare(
        `UPDATE findings SET status = ?, severity = COALESCE(?, severity), confidence = COALESCE(?, confidence),
           rationale = CASE WHEN ? IS NULL THEN rationale ELSE rationale || ' ' || ? END WHERE id = ?`,
      )
      .run(status, fields.severity ?? null, fields.confidence ?? null, fields.note ?? null, fields.note ?? null, findingId);
  }

  /** Records an attempt, replacing an earlier record of the same attempt number so a re-run step does not duplicate it. */
  saveAttempt(findingId: string, n: number, fields: { plan?: string; diff?: string; outcome?: string; diagnosis?: string }): number {
    const existing = this.db.prepare('SELECT id FROM attempts WHERE finding_id = ? AND n = ?').get(findingId, n) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE attempts SET plan_text = COALESCE(?, plan_text), diff = COALESCE(?, diff), outcome = COALESCE(?, outcome),
             diagnosis_text = COALESCE(?, diagnosis_text) WHERE id = ?`,
        )
        .run(fields.plan ?? null, fields.diff ?? null, fields.outcome ?? null, fields.diagnosis ?? null, existing.id);
      return existing.id;
    }
    const result = this.db
      .prepare('INSERT INTO attempts (finding_id, n, plan_text, diff, outcome, diagnosis_text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(findingId, n, fields.plan ?? null, fields.diff ?? null, fields.outcome ?? null, fields.diagnosis ?? null);
    return Number(result.lastInsertRowid);
  }

  attempts(investigationId: string): AttemptRecord[] {
    return this.db
      .prepare('SELECT a.* FROM attempts a JOIN findings f ON f.id = a.finding_id WHERE f.investigation_id = ? ORDER BY a.finding_id, a.n')
      .all(investigationId) as unknown as AttemptRecord[];
  }

  saveTestRun(
    investigationId: string,
    run: { label: string; command: string; exitCode: number | null; passed: number | null; failed: number | null; logPath: string; durationMs: number; attemptId?: number },
  ): void {
    this.db.prepare('DELETE FROM test_runs WHERE investigation_id = ? AND label = ?').run(investigationId, run.label);
    this.db
      .prepare('INSERT INTO test_runs (investigation_id, attempt_id, label, command, exit_code, passed, failed, log_path, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(investigationId, run.attemptId ?? null, run.label, run.command, run.exitCode, run.passed, run.failed, run.logPath, run.durationMs);
  }

  testRuns(investigationId: string): TestRunRecord[] {
    return this.db.prepare('SELECT * FROM test_runs WHERE investigation_id = ? ORDER BY id').all(investigationId) as unknown as TestRunRecord[];
  }

  dependencies(investigationId: string): DependencyRecord[] {
    return this.db
      .prepare('SELECT name, installed, latest, direct, deprecated FROM dependencies WHERE investigation_id = ? ORDER BY direct DESC, name')
      .all(investigationId) as unknown as DependencyRecord[];
  }

  findings(investigationId: string): FindingRecord[] {
    return this.db
      .prepare('SELECT * FROM findings WHERE investigation_id = ? ORDER BY priority DESC NULLS LAST, package, kind')
      .all(investigationId) as unknown as FindingRecord[];
  }

  sources(investigationId: string): SourceRecord[] {
    return this.db
      .prepare('SELECT * FROM sources WHERE investigation_id = ? ORDER BY id')
      .all(investigationId) as unknown as SourceRecord[];
  }
}
