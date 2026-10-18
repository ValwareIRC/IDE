import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    adapter TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth TEXT NOT NULL,
    extra_headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    probed_at INTEGER,
    probe_latency_ms INTEGER,
    probe_error TEXT
  );
  CREATE TABLE IF NOT EXISTS models (
    key TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_models_endpoint ON models (endpoint_id);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    model TEXT,
    mode TEXT NOT NULL DEFAULT 'ask',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    parent_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_ws ON sessions (workspace, updated_at);
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ts INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_session ON items (session_id, seq);
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    session_id TEXT,
    ok INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read INTEGER,
    cache_write INTEGER,
    latency_ms INTEGER,
    cost REAL,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events (created_at);
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    label TEXT NOT NULL,
    files TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints (session_id, ts);
  CREATE TABLE IF NOT EXISTS checkpoint_files (
    checkpoint_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content BLOB,
    existed INTEGER NOT NULL,
    PRIMARY KEY (checkpoint_id, path)
  );
  `,
  // v2: a checkpoint remembers which user turn it belongs to (rewind)
  `ALTER TABLE checkpoints ADD COLUMN turn_item_id TEXT;`,
  // v3: per-session context settings (pinned files, extra instructions) as JSON
  `ALTER TABLE sessions ADD COLUMN extras TEXT NOT NULL DEFAULT '{}';`,
  // v4: every change the agent made to a file, step by step (time machine, why-is-this-here, undo by request)
  `CREATE TABLE IF NOT EXISTS file_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    turn_item_id TEXT,
    call_id TEXT,
    path TEXT NOT NULL,
    ts INTEGER NOT NULL,
    before BLOB,
    before_exists INTEGER NOT NULL,
    after BLOB,
    after_exists INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_versions_session ON file_versions (session_id, id);
  CREATE INDEX IF NOT EXISTS idx_versions_path ON file_versions (workspace, path, id);`
]

export function openDb(file: string): Db {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const v = row?.user_version ?? 0
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]!)
    db.exec(`PRAGMA user_version = ${i + 1};`)
  }
  return db
}
