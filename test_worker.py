"""Runnable checks for the parts that can break silently: queue claiming, Slack's
retry dedupe, the failure ceiling, and one end-to-end pass with fake clients.

    python3 test_worker.py

No framework, no fixtures. The fake clients here are also the seam the browser
simulator will drive later.
"""

import json
import os
import tempfile

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


class FakeLLM:
    """Anything with .complete(system, user) satisfies the worker."""

    def __init__(self, text="the answer", raises=None):
        self._text = text
        self._raises = raises
        self.calls = []

    def complete(self, system, user):
        self.calls.append({"system": system, "user": user})
        if self._raises:
            raise self._raises
        return self._text


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
    llm = FakeLLM(raises=RuntimeError("429 rate limited"))

    for expected in ("queued", "queued", "failed"):
        assert worker.run_once(conn, slack, llm) is True
        status = conn.execute("SELECT status FROM runs").fetchone()["status"]
        assert status == expected, f"expected {expected}, got {status}"

    # Terminal, not looping: nothing left to claim.
    assert worker.run_once(conn, slack, llm) is False
    assert len(llm.calls) == 3, len(llm.calls)
    # Nothing was posted to Slack on a failed run.
    assert slack.posted == [], slack.posted


def test_end_to_end_with_fakes():
    conn = fresh_db()
    db.enqueue(conn, "e1", "C42", "999.0", "U1", "<@BOT> what broke?")
    slack = FakeSlack([
        {"user": "U1", "text": "prod is 500ing"},
        {"user": "U2", "text": "<@BOT> what broke?"},
    ])
    llm = FakeLLM(text="Looks like the retry config.")

    assert worker.run_once(conn, slack, llm) is True

    row = conn.execute("SELECT * FROM runs").fetchone()
    assert row["status"] == "done", row["status"]
    assert row["answer"] == "Looks like the retry config."

    # Replied in-thread, not in the channel.
    assert slack.posted == [
        {"channel": "C42", "thread_ts": "999.0", "text": "Looks like the retry config."}
    ], slack.posted

    # Both speakers reached the model, each attributed.
    sent = llm.calls[0]["user"]
    assert "<@U1>: prod is 500ing" in sent, sent
    assert "<@U2>: <@BOT> what broke?" in sent, sent
    assert "Slack mrkdwn" in llm.calls[0]["system"], "system prompt did not reach the model"


def test_only_free_models():
    """The brief is free models only — a paid id would bill silently."""
    assert worker.MODEL.endswith(":free"), worker.MODEL


def test_empty_completion_is_an_error_not_an_empty_post():
    """Observed for real: a free-tier model can return content: null. Without
    this guard the worker posts a blank message into the thread."""
    import urllib.request

    class FakeResponse:
        def __init__(self, payload): self._p = json.dumps(payload).encode()
        def read(self, *a): return self._p
        def __enter__(self): return self
        def __exit__(self, *a): return False

    real = urllib.request.urlopen
    urllib.request.urlopen = lambda req, timeout=None: FakeResponse(
        {"model": "some/model:free", "choices": [{"message": {"content": None}}]}
    )
    try:
        try:
            worker.OpenRouter(key="test").complete("sys", "user")
            raise AssertionError("expected an error, got a silent empty answer")
        except RuntimeError as e:
            assert "empty completion" in str(e), str(e)
    finally:
        urllib.request.urlopen = real


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("\nall checks passed")
