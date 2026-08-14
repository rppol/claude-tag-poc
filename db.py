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
# The lease MUST exceed the worst-case work time or two workers post the same
# answer into a public channel. worker.MODELS x MODEL_TIMEOUT + Slack calls is
# the number to beat; a test pins the relationship so adding a 5th model fails
# loudly instead of silently re-opening this.
LEASE_SECONDS = 300
BACKOFF_BASE = 5             # 5s, 10s, 20s — a transient limit gets time to clear


def connect(path=None):
    # isolation_level=None turns off implicit transactions so BEGIN IMMEDIATE
    # means what it says. check_same_thread=False because Bolt dispatches its
    # listeners on a thread pool, not the thread that imported this module —
    # the default raises ProgrammingError on the very first mention.
    db = sqlite3.connect(path or DB_PATH, isolation_level=None,
                         check_same_thread=False, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")     # measured ~2-5x claim throughput
    # NORMAL avoids an fsync per commit. It does NOT fix the ~2s p100 write tail
    # that appears the moment there are two writers — SQLite's busy handler is an
    # unfair sleep ladder. That limit is documented, not engineered around.
    db.execute("PRAGMA synchronous=NORMAL")
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
            "SELECT * FROM runs AS r WHERE "
            "  ((r.status = 'queued'  AND r.next_attempt_at <= datetime('now')) "
            "   OR (r.status = 'running' AND r.claimed_at <= datetime('now', ?))) "
            # One run in flight per channel. Without this a single alert channel
            # firing 200 events puts 200 rows ahead of everyone: at p95 38s and
            # two workers that is an hour of head-of-line blocking for the whole
            # workspace. FIFO is not fair when one channel can flood it.
            # ponytail: cap of 1; a counting subquery raises it if channels < workers.
            "  AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.channel = r.channel "
            "                  AND o.status = 'running' AND o.id != r.id "
            "                  AND o.claimed_at > datetime('now', ?)) "
            "ORDER BY r.id LIMIT 1",
            (f"-{LEASE_SECONDS} seconds", f"-{LEASE_SECONDS} seconds"),
        ).fetchone()
        if row is not None:
            db.execute(
                "UPDATE runs SET status = 'running', attempts = attempts + 1, "
                "claimed_at = datetime('now'), "
                "first_claimed_at = COALESCE(first_claimed_at, datetime('now')) "
                "WHERE id = ?",
                (row["id"],),
            )
            # Return the post-UPDATE row: the fencing token is `attempts`, and a
            # caller holding the stale value cannot reserve the post.
            row = db.execute("SELECT * FROM runs WHERE id = ?", (row["id"],)).fetchone()
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return row


def reserve_post(db, run_id, attempts, answer):
    """Claim the exclusive right to post, atomically. Returns False if someone
    else already did.

    `attempts` is a fencing token. A worker whose lease lapsed still holds the
    old value, so its UPDATE matches no row and it cannot post a second copy of
    an answer the channel already has. Checking `row["posted_at"]` in Python
    could not do this — the row was read before the other worker existed.
    """
    cur = db.execute(
        "UPDATE runs SET posted_at = datetime('now'), answer = ? "
        "WHERE id = ? AND attempts = ? AND posted_at IS NULL",
        (answer, run_id, attempts))
    return cur.rowcount == 1


def mark_posted(db, run_id, answer):
    """Called the instant chat.postMessage returns. Separate from finish() so a
    failure between the post and the finish cannot repost the same answer.

    The answer is stored here too: the recovery path used to finish with the
    row's answer column, which was still NULL at that point — so the runs that
    had trouble, the ones most worth inspecting, recorded an empty answer."""
    db.execute("UPDATE runs SET posted_at = datetime('now'), answer = ? WHERE id = ?",
               (answer, run_id))


def finish(db, run_id, answer, model=None, duration_ms=None, prompt_chars=None,
           tokens_in=None, tokens_out=None):
    db.execute(
        "UPDATE runs SET status = 'done', answer = ?, error = NULL, "
        "  finished_at = datetime('now'), "
        "  model = COALESCE(?, model), duration_ms = COALESCE(?, duration_ms), "
        "  prompt_chars = COALESCE(?, prompt_chars), "
        "  tokens_in = COALESCE(?, tokens_in), tokens_out = COALESCE(?, tokens_out) "
        "WHERE id = ?",
        (answer, model, duration_ms, prompt_chars, tokens_in, tokens_out, run_id))


def fail(db, run_id, error):
    """Requeue with backoff, unless we've burned MAX_ATTEMPTS on this run.

    Returns True when this was the last attempt, so the caller can tell the
    person who asked. Dying silently in a public thread leaves them waiting for
    an answer that is never coming.
    """
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
    return db.execute("SELECT status FROM runs WHERE id = ?",
                      (run_id,)).fetchone()["status"] == "failed"
