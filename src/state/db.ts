import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export type Db = DatabaseSync;

export function openDb(path: string = process.env.VERITAS_DB_PATH ?? '.veritas/veritas.db'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS".
  const columns = (db.prepare('PRAGMA table_info(investigations)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('owner')) db.exec('ALTER TABLE investigations ADD COLUMN owner TEXT');
  return db;
}
