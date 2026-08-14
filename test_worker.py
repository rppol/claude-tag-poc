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


def fresh_db(path=None):
    path = path or os.path.join(tempfile.mkdtemp(), "t.db")
    return db.connect(path)


def no_backoff():
    """Requeues now carry an exponential delay; tests shouldn't sleep through it."""
    db.BACKOFF_BASE = 0


def test_claim_advances_through_the_queue():
    """Renamed honestly: sequential claims on ONE connection show the queue
    advances. They say nothing about exclusivity — see the two-connection test
    below, which is what BEGIN IMMEDIATE actually has to survive."""
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
    no_backoff()

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


def test_failover_skips_a_rate_limited_model():
    """Two of six free models were 429 on a cold probe, so this is the median
    case, not an edge case. A 429 must cost a model, not one of the run's three
    attempts."""
    calls = []

    class FakeOR:
        def __init__(self, key=None, model=None):
            self.model = model
        def complete(self, system, user):
            calls.append(self.model)
            if self.model == "a:free":
                raise RuntimeError("HTTP 429: rate limited")
            if self.model == "b:free":
                raise RuntimeError("empty completion from b:free")
            return "answered by " + self.model

    real = worker.OpenRouter
    worker.OpenRouter = FakeOR
    try:
        f = worker.Failover(models=["a:free", "b:free", "c:free"])
        out = f.complete("sys", "user")
        assert out == "answered by c:free", out
        assert f.used == "c:free", f.used
        assert calls == ["a:free", "b:free", "c:free"], calls
        assert len(f.skipped) == 2, f.skipped

        # All models down is terminal — the run must fail, not hang or return "".
        f2 = worker.Failover(models=["a:free"])
        try:
            f2.complete("s", "u")
            raise AssertionError("expected an error when every model fails")
        except RuntimeError as e:
            assert "every model failed" in str(e), str(e)
    finally:
        worker.OpenRouter = real


def test_markdown_is_coerced_to_slack_mrkdwn():
    """Observed live: a free model emitted **bold** and Slack renders that
    literally. The prompt asks for mrkdwn; the prompt is not an enforcement
    mechanism."""
    out = worker.slackify("Check the **retry config**.\n### Next steps\nRevert **v2.3.1**.")
    assert "**" not in out, out
    assert "*retry config*" in out, out
    assert "### " not in out and "Next steps" in out, out
    # A lone asterisk pair that is already mrkdwn must survive untouched.
    assert worker.slackify("already *bold* here") == "already *bold* here"


def test_claim_is_exclusive_under_contention():
    """BEGIN IMMEDIATE is DESIGN.md's answer to 'why no lease manager'. The old
    test made three sequential calls on one connection and passed with the
    transaction removed, so the load-bearing decision had no coverage."""
    import threading
    path = os.path.join(tempfile.mkdtemp(), "contend.db")
    seed = fresh_db(path)
    for i in range(8):
        db.enqueue(seed, f"e{i}", "C1", "1.0", "U", "x")

    got, lock = [], threading.Lock()

    def grab():
        c = db.connect(path)
        try:
            for _ in range(6):
                try:
                    r = db.claim(c)
                except Exception:
                    continue          # a locked DB is transient, not fatal
                if r is not None:
                    with lock:
                        got.append(r["id"])
        finally:
            c.close()

    ts = [threading.Thread(target=grab) for _ in range(3)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert got, "no rows claimed at all"
    assert len(got) == len(set(got)), f"a row was claimed twice: {sorted(got)}"
    rows = seed.execute("SELECT attempts FROM runs WHERE status='running'").fetchall()
    assert all(r["attempts"] == 1 for r in rows), [r["attempts"] for r in rows]


def test_killed_worker_is_reclaimed_after_the_lease_expires():
    """The failure the docstring used to claim was handled and wasn't: a SIGKILLed
    worker never runs its except handler, so only a lease sweep recovers the run."""
    conn = fresh_db()
    db.enqueue(conn, "e_kill", "C1", "1.0", "U1", "x")
    taken = db.claim(conn)
    assert taken is not None
    # process dies here — no finish, no fail
    assert conn.execute("SELECT status FROM runs").fetchone()["status"] == "running"
    assert db.claim(conn) is None, "a live lease must not be stealable"

    before = db.LEASE_SECONDS
    db.LEASE_SECONDS = 0
    try:
        again = db.claim(conn)
    finally:
        db.LEASE_SECONDS = before
    assert again is not None and again["id"] == taken["id"], again
    assert conn.execute("SELECT attempts FROM runs").fetchone()["attempts"] == 2


def test_a_posted_answer_is_never_posted_twice():
    """If the post lands and finish() then fails, the retry must not repeat the
    same answer into the channel."""
    conn = fresh_db()
    no_backoff()
    db.enqueue(conn, "e_dup_post", "C1", "1.0", "U1", "x")
    slack = FakeSlack([{"user": "U1", "text": "hi"}])
    llm = FakeLLM(text="the answer")

    row = db.claim(conn)
    slack.chat_postMessage(channel="C1", thread_ts="1.0", text="the answer")
    db.mark_posted(conn, row["id"])
    db.fail(conn, row["id"], RuntimeError("died after posting"))

    worker.run_once(conn, slack, llm)         # retry
    assert len(slack.posted) == 1, slack.posted
    assert conn.execute("SELECT status FROM runs").fetchone()["status"] == "done"


def test_whitespace_completion_is_empty():
    """'   \n  ' is as empty as None. The guard checked truthiness before
    stripping, so a blank message posted and the run was marked done."""
    import urllib.request

    class R:
        def __init__(self, p): self._p = json.dumps(p).encode()
        def read(self, *a): return self._p
        def __enter__(self): return self
        def __exit__(self, *a): return False

    real = urllib.request.urlopen
    for blank in ("   \n  ", "", "\t"):
        urllib.request.urlopen = lambda req, timeout=None, b=blank: R(
            {"model": "m:free", "choices": [{"message": {"content": b}}]})
        try:
            worker.OpenRouter(key="t").complete("s", "u")
            raise AssertionError(f"{blank!r} should have raised")
        except RuntimeError as e:
            assert "empty completion" in str(e), str(e)
        finally:
            urllib.request.urlopen = real


def test_slackify_leaves_code_alone():
    """Observed: `ls **/*.py` became `ls */*.py` — silently wrong code posted
    into an engineering channel."""
    assert worker.slackify("Try `ls **/*.py` now") == "Try `ls **/*.py` now"
    assert worker.slackify("Use `a**b` for power") == "Use `a**b` for power"
    fenced = "```\n# install deps\npip install x\n```"
    assert worker.slackify(fenced) == fenced, worker.slackify(fenced)
    # #1234 is a ticket reference, not a heading.
    assert worker.slackify("#1234 is the ticket") == "#1234 is the ticket"
    # An odd number of asterisks must not leave ** behind (Slack renders it raw).
    for s_ in ("use ** here.\n\n**Next steps**", "***bold***", "**a and **b**"):
        assert "**" not in worker.slackify(s_), (s_, worker.slackify(s_))


def test_every_model_in_the_list_is_free():
    """Failover walks the whole list, so checking MODELS[0] alone would let a
    paid id at MODELS[2] bill silently — the exact failure this guards."""
    assert worker.MODELS, "model list is empty"
    for m in worker.MODELS:
        assert m.endswith(":free"), m


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("\nall checks passed")
