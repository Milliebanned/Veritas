CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  current_state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  neatlogs_trace_ref TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  state TEXT NOT NULL,
  name TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  UNIQUE (investigation_id, idem_key)
);

CREATE TABLE IF NOT EXISTS dependencies (
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  name TEXT NOT NULL,
  installed TEXT,
  latest TEXT,
  direct INTEGER NOT NULL DEFAULT 0,
  deprecated TEXT,
  PRIMARY KEY (investigation_id, name)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  package TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  severity REAL,
  confidence REAL,
  usage_score REAL,
  priority REAL,
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT REFERENCES findings(id),
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  excerpt TEXT,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS affected_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  file TEXT NOT NULL,
  line INTEGER,
  symbol TEXT,
  provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  n INTEGER NOT NULL,
  plan_text TEXT,
  diff TEXT,
  outcome TEXT,
  diagnosis_text TEXT
);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  attempt_id INTEGER REFERENCES attempts(id),
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  passed INTEGER,
  failed INTEGER,
  log_path TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
  investigation_id TEXT PRIMARY KEY REFERENCES investigations(id),
  markdown TEXT NOT NULL,
  json TEXT NOT NULL,
  verdict TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  investigation_id TEXT PRIMARY KEY REFERENCES investigations(id),
  decision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  pr_url TEXT
);
