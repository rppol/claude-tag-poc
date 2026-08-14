"""Slack listener. Acks, writes one row, returns. That's the whole job.

Slack's Events API wants HTTP 200 within 3 seconds and retries with the *same*
event_id if it doesn't get one — so a slow handler produces duplicate work, not
just a timeout. Everything expensive happens in worker.py.
"""

import os

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

import db

app = App(token=os.environ["SLACK_BOT_TOKEN"])


@app.event("app_mention")
def on_mention(body, event, ack, logger):
    ack()  # before the write, not after: Bolt's auto-ack only fires once we return.

    # Our own reply contains the handle it was addressed as, and models echo it.
    # Without this guard a reply can re-fire app_mention on the bot's own post
    # and the thread loops.
    if event.get("bot_id") or event.get("user") == (body.get("authorizations") or [{}])[0].get("user_id"):
        logger.info("ignoring our own message")
        return

    # A connection per invocation. Bolt dispatches listeners on a thread pool,
    # and a module-scope connection raises ProgrammingError from any thread but
    # the one that opened it — which silently drops every mention, because the
    # ack already went out and Slack will never retry a 200.
    conn = db.connect()
    try:
        is_new = db.enqueue(
            conn,
            event_id=body["event_id"],
            channel=event["channel"],
            # A top-level mention has no thread_ts; reply under it, not in the channel.
            thread_ts=event.get("thread_ts") or event["ts"],
            user_id=event.get("user"),
            text=event.get("text", ""),
        )
        logger.info(("queued %s" if is_new else "duplicate %s"), body["event_id"])
    finally:
        conn.close()


if __name__ == "__main__":
    SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"]).start()
