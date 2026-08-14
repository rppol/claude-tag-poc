"""SQLite queue for Claude Tag runs.

# ponytail: sqlite + a lease. Postgres with `SELECT ... FOR UPDATE SKIP LOCKED`
# when a second worker exists — BEGIN IMMEDIATE serializes writers, so two
# workers here contend rather than scale.
"""

import os
import pathlib
import sqlite3

DB_PATH = os.environ.get("CLAUDE_TAG_DB", "claude_tag.db")
MAX_ATTEMPTS = 3
LEASE_SECONDS = 120          # a run held longer than this is presumed dead
BACKOFF_BASE = 5             # 5s, 10s, 20s — a transient limit gets time to clear


def connect(path=None):
    # isolation_level=None turns off implicit transactions so BEGIN IMMEDIATE
    # means what it says. check_same_thread=False because Bolt dispatches its
    # listeners on a thread pool, not the thread that imported this module —
    # the default raises ProgrammingError on the very first mention.
    db = sqlite3.connect(path or DB_PATH, isolation_level=None,
                         check_same_thread=False, timeout=30)
    db.row_factory = sqlite3.Row
    db.executescript((pathlib.Path(__file__).parent / "schema.sql").read_text())
    return db


def enqueue(db, event_id, channel, thread_ts, user_id, text):
    """Returns True if this is a new run, False if the platform is retrying one
    we already hold."""
    cur = db.execute(
        "INSERT OR IGNORE INTO runs (event_id, channel, thread_ts, user_id, text) "
        "VALUES (?, ?, ?, ?, ?)",
        (event_id, channel, thread_ts, user_id, text),
    )
    return cur.rowcount == 1


def claim(db):
    """Take the next claimable run, or None.

    Claimable means: queued and past its backoff, OR running but the lease
    expired — that second clause is the only thing that recovers a run whose
    worker was killed rather than raising.

    BEGIN IMMEDIATE holds the write lock across the select and the update, so
    two workers cannot take the same row.
    """
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute(
            "SELECT * FROM runs WHERE "
            "  (status = 'queued'  AND next_attempt_at <= datetime('now')) "
            "  OR (status = 'running' AND claimed_at <= datetime('now', ?)) "
            "ORDER BY id LIMIT 1",
            (f"-{LEASE_SECONDS} seconds",),
        ).fetchone()
        if row is not None:
            db.execute(
                "UPDATE runs SET status = 'running', attempts = attempts + 1, "
                "claimed_at = datetime('now') WHERE id = ?",
                (row["id"],),
            )
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return row


def mark_posted(db, run_id):
    """Called the instant chat.postMessage returns. Separate from finish() so a
    failure between the post and the finish cannot repost the same answer."""
    db.execute("UPDATE runs SET posted_at = datetime('now') WHERE id = ?", (run_id,))


def finish(db, run_id, answer):
    db.execute("UPDATE runs SET status = 'done', answer = ?, error = NULL WHERE id = ?",
               (answer, run_id))


def fail(db, run_id, error):
    """Requeue with backoff, unless we've burned MAX_ATTEMPTS on this run."""
    row = db.execute("SELECT attempts FROM runs WHERE id = ?", (run_id,)).fetchone()
    delay = BACKOFF_BASE * (2 ** max(0, (row["attempts"] if row else 1) - 1))
    db.execute(
        "UPDATE runs SET "
        "  status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END, "
        "  next_attempt_at = datetime('now', ?), "
        "  error = ? "
        "WHERE id = ?",
        (MAX_ATTEMPTS, f"+{delay} seconds", str(error)[:2000], run_id),
    )
