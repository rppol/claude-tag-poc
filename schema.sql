-- One table. A run is one @mention that needs an answer.
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY,
  event_id   TEXT UNIQUE,          -- Slack reuses this across retries; UNIQUE *is* the dedupe
  channel    TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  user_id    TEXT,
  text       TEXT,
  status     TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  attempts   INTEGER NOT NULL DEFAULT 0,       -- poison-pill guard; 3 strikes -> failed
  answer     TEXT,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS runs_queued ON runs(status, id);
