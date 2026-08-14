# claude-tag-poc

A minimal reimplementation of [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)'s core loop: tag `@Claude` in a Slack thread, it reads the thread and answers in place.

Backend only so far. See [DESIGN.md](./DESIGN.md) for why it's shaped this way and what was deliberately left out.

## Run the checks (no dependencies, no credentials)

```bash
python3 test_worker.py
```

The tests drive the real code path with fake Slack and Claude clients, so the queue logic, retry dedupe, failure ceiling, and request shape are all verified without a network call.

## Run it for real

Needs a Slack app and an Anthropic key.

```bash
pip install -r requirements.txt

export SLACK_BOT_TOKEN=xoxb-...   # Bot User OAuth Token
export SLACK_APP_TOKEN=xapp-...   # App-Level Token, for Socket Mode
export ANTHROPIC_API_KEY=sk-ant-...

python3 app.py     # terminal 1 — Slack listener
python3 worker.py  # terminal 2 — does the work
```

Then invite the bot to a channel and `@mention` it.

### Slack app setup

Create an app at [api.slack.com/apps](https://api.slack.com/apps), then:

- **Socket Mode** → enable. Generate an App-Level Token with `connections:write` → that's `SLACK_APP_TOKEN`.
- **OAuth & Permissions** → bot token scopes: `app_mentions:read`, `channels:history`, `chat:write`. Install to workspace → that's `SLACK_BOT_TOKEN`.
- **Event Subscriptions** → subscribe to bot event `app_mention`.

Socket Mode means no public URL and no ngrok — the app dials out to Slack.

## Layout

| File | Job |
|---|---|
| `app.py` | Slack listener. Acks within Slack's 3s window, writes one row, returns. |
| `worker.py` | Claims a run, reads the thread, calls Claude, posts back. |
| `db.py` | SQLite queue: enqueue, claim, finish, fail. |
| `schema.sql` | One table. |
| `test_worker.py` | Runnable checks. |

## Status

- Queue, dedupe, claim, retry ceiling, and request shape — **verified by tests**.
- Live Slack + Anthropic round trip — **not yet run**; it needs credentials that weren't available when this was written.
