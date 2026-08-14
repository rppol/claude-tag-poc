"""Does the actual work: claim a run, read the thread, ask the model, post back.

Runs as its own process. Kill it mid-run and the row goes back to 'queued' on
restart via the attempts guard, so work survives a crash.

The model is reached through OpenRouter, which is OpenAI-compatible — so the
whole integration is one POST and needs no SDK. Only free models are used.
"""

import json
import os
import time
import urllib.error
import urllib.request

import db

API = "https://openrouter.ai/api/v1/chat/completions"

# Pinned deliberately. OpenRouter's `openrouter/free` auto-router is tempting and
# is a trap: it can route to a special-purpose model (a content-safety classifier
# in testing) that returns no content at all. Override with OPENROUTER_MODEL.
# Verified working alternative: google/gemma-4-31b-it:free
MODEL = os.environ.get("OPENROUTER_MODEL", "nvidia/nemotron-3-super-120b-a12b:free")
MAX_TOKENS = 800
THREAD_LIMIT = 50

SYSTEM = (
    "You are a helpful teammate in a Slack thread.\n"
    "The transcript below is the whole thread, one message per line, each prefixed "
    "with the Slack user who wrote it. Multiple people may be talking; work out who "
    "is asking you for what.\n"
    "Reply with Slack mrkdwn: *bold*, _italic_, `code`. No markdown headers — Slack "
    "does not render them. Answer the question that was actually asked, in a few "
    "sentences. Skip the preamble and the recap."
)


class OpenRouter:
    """One POST, no SDK. Anything with a .complete(system, user) works here —
    that's the seam the tests and the browser simulator both drive."""

    def __init__(self, key=None, model=MODEL):
        self.key = key or os.environ["OPENROUTER_API_KEY"]
        self.model = model

    def complete(self, system, user):
        body = json.dumps({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": MAX_TOKENS,
        }).encode()
        req = urllib.request.Request(API, data=body, headers={
            "Authorization": "Bearer " + self.key,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://rppol.github.io/claude-tag-poc/",
            "X-Title": "claude-tag-poc",
        })
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            # Free models rate-limit often; surfacing the body makes 429s readable.
            raise RuntimeError(f"HTTP {e.code}: {e.read(400).decode(errors='replace')}")
        if "error" in d:
            raise RuntimeError(d["error"].get("message", "unknown error"))
        text = (d.get("choices") or [{}])[0].get("message", {}).get("content")
        if not text:
            # A real failure mode, not paranoia: some free models return a null
            # completion. Raising here lets the attempts ceiling handle it instead
            # of posting an empty message into the thread.
            raise RuntimeError(f"empty completion from {d.get('model', self.model)}")
        return text.strip()


def thread_transcript(slack, channel, thread_ts, limit=THREAD_LIMIT):
    """The room, not just the mention. Attribution matters — without the user id
    prefix the model cannot tell who asked what in a multi-person thread."""
    msgs = slack.conversations_replies(channel=channel, ts=thread_ts, limit=limit)["messages"]
    return "\n".join(
        f"<@{m.get('user', 'unknown')}>: {m.get('text', '')}" for m in msgs
    )


def run_once(conn, slack, llm):
    """Claim and process one run. Returns True if there was work to do."""
    row = db.claim(conn)
    if row is None:
        return False
    try:
        text = llm.complete(SYSTEM, thread_transcript(slack, row["channel"], row["thread_ts"]))
        slack.chat_postMessage(channel=row["channel"], thread_ts=row["thread_ts"], text=text)
        db.finish(conn, row["id"], text)
    except Exception as e:
        # Requeued for another attempt, or marked failed on the third strike.
        db.fail(conn, row["id"], e)
        # row is the pre-UPDATE snapshot from claim(), so its attempts count is
        # one behind the attempt that just ran.
        print(f"run {row['id']} failed (attempt {row['attempts'] + 1}/{db.MAX_ATTEMPTS}): {e}")
    return True


def main():
    from slack_sdk import WebClient

    conn = db.connect()
    slack = WebClient(token=os.environ["SLACK_BOT_TOKEN"])
    llm = OpenRouter()
    print(f"worker up — model {llm.model}")
    while True:
        # ponytail: polling. Fine at this volume; LISTEN/NOTIFY when it isn't.
        if not run_once(conn, slack, llm):
            time.sleep(1)


if __name__ == "__main__":
    main()
