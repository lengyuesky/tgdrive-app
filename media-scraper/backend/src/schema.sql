PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA user_version=1;
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL,
  backend_url TEXT NOT NULL, token TEXT,
  overwrite_nfo INTEGER NOT NULL DEFAULT 0, overwrite_poster INTEGER NOT NULL DEFAULT 0,
  directory TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL,
  root TEXT NOT NULL, scope_revision TEXT NOT NULL, state TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  scan_complete INTEGER NOT NULL DEFAULT 0, scan_cursor TEXT, retry_of TEXT,
  overwrite_nfo INTEGER NOT NULL, overwrite_poster INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_history ON runs(updated_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active ON runs((1)) WHERE state IN ('scanning','running','stopping');
CREATE TABLE IF NOT EXISTS run_config (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  backend_url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_nodes (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id INTEGER NOT NULL,
  parent_id TEXT NOT NULL, stem_key TEXT NOT NULL, document TEXT NOT NULL,
  PRIMARY KEY(run_id,id)
);
CREATE INDEX IF NOT EXISTS scan_groups ON scan_nodes(run_id,parent_id,stem_key,id);
CREATE TABLE IF NOT EXISTS retry_nodes (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL, PRIMARY KEY(run_id,id)
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, document TEXT NOT NULL, state TEXT NOT NULL, video_count INTEGER NOT NULL,
  UNIQUE(run_id,position)
);
CREATE INDEX IF NOT EXISTS items_state ON items(run_id,state,position);
CREATE TABLE IF NOT EXISTS item_files (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL, PRIMARY KEY(item_id,node_id)
);
CREATE INDEX IF NOT EXISTS item_files_lookup ON item_files(run_id,node_id);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS attempts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, provider TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_item ON attempts(item_id,sequence);
CREATE TABLE IF NOT EXISTS sources (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, number_key TEXT NOT NULL,
  movie TEXT NOT NULL, PRIMARY KEY(run_id,number_key)
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, role TEXT NOT NULL,
  state TEXT NOT NULL, document TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_item ON steps(item_id,created_at,id);
CREATE INDEX IF NOT EXISTS steps_unsettled ON steps(run_id,state);
