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
  return db;
}
