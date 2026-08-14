"""Does the actual work: claim a run, read the thread, ask the model, post back.

Runs as its own process. Kill it mid-run and the row goes back to 'queued' on
restart via the attempts guard, so work survives a crash.

The model is reached through OpenRouter, which is OpenAI-compatible — so the
whole integration is one POST and needs no SDK. Only free models are used.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request

import db

API = "https://openrouter.ai/api/v1/chat/completions"

# Preference order, not a single pin. Free models 429 constantly — 2 of 6 were
# already rate-limited on a cold probe — so the worker fails over rather than
# burning an attempt from the retry ceiling on a transient limit.
#
# Order is by measured behaviour, not parameter count: laguna answers a real
# thread in ~6s, while nemotron-120b took 12s and leaked its reasoning into the
# reply, which in a Slack thread reads as the bot talking to itself.
#
# Not `openrouter/free`: that auto-router sent a chat request to a content-safety
# classifier, which returned no content at all.
MODELS = [
    "poolside/laguna-s-2.1:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "google/gemma-4-31b-it:free",
]
MODEL = os.environ.get("OPENROUTER_MODEL", MODELS[0])
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


class Failover:
    """Tries each free model in turn. A 429, an empty completion and a transport
    error are the three ways a free model fails, and all three are transient for
    *this* model rather than terminal for the run — so move on instead of
    spending one of the run's three attempts."""

    def __init__(self, models=None):
        self.models = list(models or ([MODEL] if os.environ.get("OPENROUTER_MODEL") else MODELS))
        self.used = None
        self.skipped = []

    def complete(self, system, user):
        last = None
        for m in self.models:
            try:
                out = OpenRouter(model=m).complete(system, user)
                self.used = m
                return out
            except Exception as e:
                self.skipped.append((m, str(e)[:80]))
                last = e
        raise RuntimeError(f"every model failed; last: {last}")


def slackify(text):
    """Coerce markdown into Slack mrkdwn.

    The system prompt asks for mrkdwn and models still emit **bold** and ###
    headers, which Slack renders literally. A formatting rule enforced only in a
    prompt is not enforced — so enforce it here, once, for every model.
    """
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text, flags=re.S)   # **bold** -> *bold*
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)            # ### Heading -> Heading
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
        text = slackify(llm.complete(SYSTEM, thread_transcript(slack, row["channel"], row["thread_ts"])))
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
    llm = Failover()
    print("worker up — models: " + ", ".join(llm.models))
    while True:
        # ponytail: polling. Fine at this volume; LISTEN/NOTIFY when it isn't.
        if not run_once(conn, slack, llm):
            time.sleep(1)


if __name__ == "__main__":
    main()
