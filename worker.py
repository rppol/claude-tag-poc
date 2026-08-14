"""Does the actual work: claim a run, read the thread, ask Claude, post back.

Runs as its own process. Kill it mid-run and the row goes back to 'queued' on
restart via the attempts guard, so work survives a crash.
"""

import os
import time

import db

# anthropic/slack_sdk are imported inside main(): only the process entrypoint needs
# them. Everything above it runs against whatever client you pass in, so the tests
# (and the browser simulator later) drive the real code path with no deps installed.

MODEL = "claude-opus-5"
# Thinking is ON BY DEFAULT on Opus 5 (unlike 4.8), and max_tokens caps thinking +
# response text together — so this needs headroom or answers truncate mid-sentence.
MAX_TOKENS = 16000
THREAD_LIMIT = 50

SYSTEM = (
    "You are Claude, participating in a Slack thread as a member of the team.\n"
    "The transcript below is the whole thread, one message per line, each prefixed "
    "with the Slack user who wrote it. Multiple people may be talking; work out who "
    "is asking you for what.\n"
    "Reply with Slack mrkdwn: *bold*, _italic_, `code`. No markdown headers — Slack "
    "does not render them. Answer the question that was actually asked; skip the "
    "preamble and the recap."
)


def thread_transcript(slack, channel, thread_ts, limit=THREAD_LIMIT):
    """The room, not just the mention. Attribution matters — without the user id
    prefix the model cannot tell who asked what in a multi-person thread."""
    msgs = slack.conversations_replies(channel=channel, ts=thread_ts, limit=limit)["messages"]
    return "\n".join(
        f"<@{m.get('user', 'unknown')}>: {m.get('text', '')}" for m in msgs
    )


def answer(claude, transcript):
    resp = claude.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM,
        # Auto-places on the last cacheable block. Inert while the thread is short
        # (Opus 5 needs a 512-token prefix to cache at all) and starts paying by
        # itself once a real conversation gets long. One line, so it stays.
        cache_control={"type": "ephemeral"},
        output_config={"effort": "high"},
        messages=[{"role": "user", "content": transcript}],
    )
    if resp.stop_reason == "refusal":
        return "I can't help with that one."
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def run_once(conn, slack, claude):
    """Claim and process one run. Returns True if there was work to do."""
    row = db.claim(conn)
    if row is None:
        return False
    try:
        text = answer(claude, thread_transcript(slack, row["channel"], row["thread_ts"]))
        slack.chat_postMessage(channel=row["channel"], thread_ts=row["thread_ts"], text=text)
        db.finish(conn, row["id"], text)
    except Exception as e:
        # Requeued for another attempt, or marked failed on the third strike.
        db.fail(conn, row["id"], e)
        print(f"run {row['id']} failed (attempt {row['attempts'] + 1}): {e}")
    return True


def main():
    import anthropic
    from slack_sdk import WebClient

    conn = db.connect()
    slack = WebClient(token=os.environ["SLACK_BOT_TOKEN"])
    claude = anthropic.Anthropic()
    print("worker up")
    while True:
        # ponytail: polling. Fine at this volume; LISTEN/NOTIFY when it isn't.
        if not run_once(conn, slack, claude):
            time.sleep(1)


if __name__ == "__main__":
    main()
