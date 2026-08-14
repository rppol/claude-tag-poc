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
conn = db.connect()


@app.event("app_mention")
def on_mention(body, event, ack, logger):
    ack()  # before the write, not after: Bolt's auto-ack only fires once we return.
    is_new = db.enqueue(
        conn,
        event_id=body["event_id"],
        channel=event["channel"],
        # A top-level mention has no thread_ts; reply under it rather than in the channel.
        thread_ts=event.get("thread_ts") or event["ts"],
        user_id=event.get("user"),
        text=event.get("text", ""),
    )
    logger.info("queued %s" % body["event_id"] if is_new else "duplicate %s" % body["event_id"])


if __name__ == "__main__":
    SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"]).start()
