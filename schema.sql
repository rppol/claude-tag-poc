-- One table. A run is one @mention that needs an answer.
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY,
  event_id   TEXT UNIQUE,          -- the platform reuses this across retries; UNIQUE *is* the dedupe
  channel    TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  user_id    TEXT,
  text       TEXT,
  status     TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  attempts   INTEGER NOT NULL DEFAULT 0,       -- poison-pill guard; 3 strikes -> failed

  -- Set when a worker takes the row. A process that is SIGKILLed never runs its
  -- except handler, so without this the row sits in 'running' forever and no
  -- worker will ever look at it again. claim() reclaims rows whose lease expired.
  claimed_at TEXT,

  -- Backoff. Three attempts fired back-to-back in milliseconds turn a 10-second
  -- rate limit into a permanent failure.
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Set the moment the post succeeds. If anything after the post fails, the
  -- retry must not say the same thing into the channel a second time.
  posted_at  TEXT,

  answer     TEXT,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS runs_claimable ON runs(status, next_attempt_at, id);
