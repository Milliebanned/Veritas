import { createHash } from 'node:crypto';
import type { Db } from './db.ts';

export interface DependencyRecord {
  name: string;
  installed: string | null;
  latest: string | null;
  direct: number;
  deprecated: string | null;
}

export type FindingKind = 'breaking' | 'advisory' | 'deprecation';
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

  dependencies(investigationId: string): DependencyRecord[] {
    return this.db
      .prepare('SELECT name, installed, latest, direct, deprecated FROM dependencies WHERE investigation_id = ? ORDER BY direct DESC, name')
      .all(investigationId) as unknown as DependencyRecord[];
  }

  findings(investigationId: string): FindingRecord[] {
    return this.db
      .prepare('SELECT * FROM findings WHERE investigation_id = ? ORDER BY package, kind')
      .all(investigationId) as unknown as FindingRecord[];
  }

  sources(investigationId: string): SourceRecord[] {
    return this.db
      .prepare('SELECT * FROM sources WHERE investigation_id = ? ORDER BY id')
      .all(investigationId) as unknown as SourceRecord[];
  }
}
