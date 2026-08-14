"""SQLite queue for Claude Tag runs.

# ponytail: sqlite + one worker. Postgres with `SELECT ... FOR UPDATE SKIP LOCKED`
# when a second worker exists — BEGIN IMMEDIATE serializes writers, so two workers
# here would spend their time blocking on each other rather than working.
"""

import os
import pathlib
import sqlite3

DB_PATH = os.environ.get("CLAUDE_TAG_DB", "claude_tag.db")
MAX_ATTEMPTS = 3


def connect(path=None):
    # isolation_level=None turns off implicit transactions so BEGIN IMMEDIATE means what it says.
    db = sqlite3.connect(path or DB_PATH, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.executescript((pathlib.Path(__file__).parent / "schema.sql").read_text())
    return db


def enqueue(db, event_id, channel, thread_ts, user_id, text):
    """Returns True if this is a new run, False if Slack is retrying one we already have."""
    cur = db.execute(
        "INSERT OR IGNORE INTO runs (event_id, channel, thread_ts, user_id, text) "
        "VALUES (?, ?, ?, ?, ?)",
        (event_id, channel, thread_ts, user_id, text),
    )
    return cur.rowcount == 1


def claim(db):
    """Take the oldest queued run, or None. BEGIN IMMEDIATE holds the write lock
    across the select+update so two workers can't claim the same row."""
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute(
            "SELECT * FROM runs WHERE status = 'queued' ORDER BY id LIMIT 1"
        ).fetchone()
        if row is not None:
            db.execute(
                "UPDATE runs SET status = 'running', attempts = attempts + 1 WHERE id = ?",
                (row["id"],),
            )
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return row


def finish(db, run_id, answer):
    db.execute("UPDATE runs SET status = 'done', answer = ?, error = NULL WHERE id = ?",
               (answer, run_id))


def fail(db, run_id, error):
    """Requeue for another go, unless we've already burned MAX_ATTEMPTS on it.
    Without the ceiling a run that crashes deterministically loops forever."""
    db.execute(
        "UPDATE runs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END, "
        "error = ? WHERE id = ?",
        (MAX_ATTEMPTS, str(error)[:2000], run_id),
    )
