# claude-tag-poc

![test](https://github.com/rppol/claude-tag-poc/actions/workflows/test.yml/badge.svg)

A minimal reimplementation of [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)'s core loop: tag `@Claude` in a Slack thread, it reads the thread and answers in place.

**[Open the simulator →](https://rppol.github.io/claude-tag-poc/)** — a Slack channel on one side, the queue that serves it on the other. Fire a retry storm and watch three Slack events collapse into one run; crash the worker and watch the run survive it.

See [DESIGN.md](./DESIGN.md) for why it's shaped this way and what was deliberately left out.

## The one constraint

Slack's Events API wants HTTP 200 within **3 seconds** and retries with the *same* `event_id` when it doesn't get one — so a slow handler produces duplicate work, not just a timeout. Everything here follows from splitting at that seam:

```
Slack ──▶ app.py       ack + one INSERT, returns in ~40ms
             │
             ▼
          runs table   queued │ running │ done │ failed
             │
             ▼
          worker.py    claim → read thread → Claude → post back
```

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
| `test_worker.py` | Runnable checks, run in CI on every push. |
| `docs/index.html` | The simulator. Static, no build step, no key. |

## Status

- Queue, dedupe, claim, retry ceiling, and request shape — **verified by tests**, green in CI.
- The simulator — **verified in a browser**: retry storm collapses 3 events to 1 run, crash requeues and resumes.
- Live Slack + Anthropic round trip — **not yet run**. It needs credentials that weren't available when this was written.

## Why the simulator is scripted

It runs no model and holds no key. Calling the Anthropic API from a public page would mean shipping the key in client-side JS, where anyone can read it — Anthropic gates that behind a header named `anthropic-dangerous-direct-browser-access`, and the name is the warning.

The trade is a good one: "an LLM returns text" isn't the interesting part of Claude Tag. The state machine is — the ack seam, the dedupe, the claim, the requeue — and that's what the page actually runs.
