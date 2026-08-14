"""Runnable checks for the parts that can break silently: queue claiming, Slack's
retry dedupe, the failure ceiling, and one end-to-end pass with fake clients.

    python3 test_worker.py

No framework, no fixtures. The fake clients here are also the seam the browser
simulator will drive later.
"""

import os
import tempfile
import types

import db
import worker


class FakeSlack:
    def __init__(self, messages):
        self._messages = messages
        self.posted = []

    def conversations_replies(self, channel, ts, limit=None):
        return {"messages": self._messages}

    def chat_postMessage(self, channel, thread_ts, text):
        self.posted.append({"channel": channel, "thread_ts": thread_ts, "text": text})
        return {"ok": True}


class FakeClaude:
    """Shaped like the real response: content is a list of typed blocks."""

    def __init__(self, text="the answer", raises=None):
        self._text = text
        self._raises = raises
        self.calls = []
        self.messages = types.SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._raises:
            raise self._raises
        block = types.SimpleNamespace(type="text", text=self._text)
        return types.SimpleNamespace(content=[block], stop_reason="end_turn")


def fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    return db.connect(path)


def test_claim_is_exclusive():
    conn = fresh_db()
    db.enqueue(conn, "e1", "C1", "111.0", "U1", "hi")
    db.enqueue(conn, "e2", "C1", "222.0", "U2", "yo")

    first, second, third = db.claim(conn), db.claim(conn), db.claim(conn)

    assert first["event_id"] == "e1", first["event_id"]
    assert second["event_id"] == "e2", second["event_id"]
    assert third is None, "queue should be drained"
    rows = conn.execute("SELECT status, attempts FROM runs ORDER BY id").fetchall()
    assert [r["status"] for r in rows] == ["running", "running"], [r["status"] for r in rows]
    assert [r["attempts"] for r in rows] == [1, 1], [r["attempts"] for r in rows]


def test_slack_retry_is_deduped():
    conn = fresh_db()
    assert db.enqueue(conn, "same", "C1", "111.0", "U1", "hi") is True
    # Slack retries the same event_id up to 3 times when it doesn't get its 200.
    assert db.enqueue(conn, "same", "C1", "111.0", "U1", "hi") is False
    assert db.enqueue(conn, "same", "C1", "111.0", "U1", "hi") is False
    assert conn.execute("SELECT count(*) c FROM runs").fetchone()["c"] == 1


def test_failure_requeues_then_gives_up():
    conn = fresh_db()
    db.enqueue(conn, "e1", "C1", "111.0", "U1", "hi")
    slack = FakeSlack([{"user": "U1", "text": "hi"}])
    claude = FakeClaude(raises=RuntimeError("api down"))

    for expected in ("queued", "queued", "failed"):
        assert worker.run_once(conn, slack, claude) is True
        status = conn.execute("SELECT status FROM runs").fetchone()["status"]
        assert status == expected, f"expected {expected}, got {status}"

    # Terminal, not looping: nothing left to claim.
    assert worker.run_once(conn, slack, claude) is False
    assert claude.calls and len(claude.calls) == 3, len(claude.calls)


def test_end_to_end_with_fakes():
    conn = fresh_db()
    db.enqueue(conn, "e1", "C42", "999.0", "U1", "<@BOT> what broke?")
    slack = FakeSlack([
        {"user": "U1", "text": "prod is 500ing"},
        {"user": "U2", "text": "<@BOT> what broke?"},
    ])
    claude = FakeClaude(text="Looks like the retry config.")

    assert worker.run_once(conn, slack, claude) is True

    row = conn.execute("SELECT * FROM runs").fetchone()
    assert row["status"] == "done", row["status"]
    assert row["answer"] == "Looks like the retry config."

    # Replied in-thread, not in the channel.
    assert slack.posted == [
        {"channel": "C42", "thread_ts": "999.0", "text": "Looks like the retry config."}
    ], slack.posted

    # Both speakers reached the model, each attributed.
    sent = claude.calls[0]["messages"][0]["content"]
    assert "<@U1>: prod is 500ing" in sent, sent
    assert "<@U2>: <@BOT> what broke?" in sent, sent

    # Params the API rejects on Opus 5 must never appear.
    for banned in ("temperature", "top_p", "top_k", "thinking"):
        assert banned not in claude.calls[0], f"{banned} 400s on {worker.MODEL}"
    assert claude.calls[0]["model"] == "claude-opus-5"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("\nall checks passed")
