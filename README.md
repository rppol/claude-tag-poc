# claude-tag-poc

![test](https://github.com/rppol/claude-tag-poc/actions/workflows/ci.yml/badge.svg)

A minimal reimplementation of [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)'s core loop: tag `@Claude` in a Slack thread, it reads the thread and answers in place.

**[Open the simulator →](https://rppol.github.io/claude-tag-poc/)** — a chat workspace on one side, the multi-agent runtime that serves it on the other. Nine scenarios: fire a retry storm and watch three events collapse into one run, crash the worker and watch LangGraph resume from a checkpoint, ask across a channel boundary and watch the scope predicate refuse.

Two more tabs: **Architecture** (data flow, agent roster, memory boundary, MCP vs A2A, failure modes) and **Rollout plan** (capacity worked from stated assumptions for 100 engineers, Grafana / alert-channel / escalation integration, phasing, and a review pass that says where it breaks).

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

Needs a Slack app and an OpenRouter key. The model call goes through OpenRouter,
which is OpenAI-compatible, so it's one POST over `urllib` — there's no LLM SDK
in `requirements.txt`.

```bash
pip install -r requirements.txt

export SLACK_BOT_TOKEN=xoxb-...          # Bot User OAuth Token
export SLACK_APP_TOKEN=xapp-...          # App-Level Token, for Socket Mode
export OPENROUTER_API_KEY=sk-or-v1-...

python3 app.py     # terminal 1 — Slack listener
python3 worker.py  # terminal 2 — does the work
```

Then invite the bot to a channel and `@mention` it.

**Model.** Defaults to `nvidia/nemotron-3-super-120b-a12b:free` — free tier only.
Override with `OPENROUTER_MODEL`; `google/gemma-4-31b-it:free` also works. Don't
reach for OpenRouter's `openrouter/free` auto-router: it can route to a
special-purpose model (a content-safety classifier, in testing) that returns no
content at all.

**On macOS**, if you get `CERTIFICATE_VERIFY_FAILED`, your Python has no CA
bundle. Either run `Install Certificates.command` from your Python's Applications
folder, or:

```bash
export SSL_CERT_FILE="$(python3 -c 'import certifi; print(certifi.where())')"
```

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
| `docs/` | Simulator source: `index.html`, `style.css`, `sim.js`, `diagrams/*.mmd`. |
| `tools/build.sh` | The build. Renders mermaid to SVG, self-hosts fonts, assembles `_site/`. |

## Status

- Queue, dedupe, claim, retry ceiling, empty-completion guard — **verified by tests**, green in CI.
- The simulator — **verified in a browser**: retry storm collapses 3 events to 1 run, crash requeues and resumes.
- Live model round trip — **verified**. A real thread went to `nemotron-3-super-120b:free` and came back with an answer that cited a detail from a message *other* than the one that tagged the bot, which is the whole point of sending the transcript rather than the mention.
- Live Slack round trip — **not yet run**; needs a workspace and a bot token.

## Why the simulator is scripted

It runs no model and holds no key. Calling any model API from a public page means shipping the key in client-side JS, where anyone with devtools can take it — and a key on a page served from GitHub Pages is a key you have published. That's true of OpenRouter, and Anthropic gates the equivalent behind a header named `anthropic-dangerous-direct-browser-access`, where the name is the warning.

The trade is a good one: "an LLM returns text" isn't the interesting part of Claude Tag. The state machine is — the ack seam, the dedupe, the claim, the requeue — and that's what the page actually runs. The real backend does call a live model; see Status above.

## The build

The published page fetches nothing at runtime — no CDN, no Google Fonts, no diagram
library. Everything expensive is moved into CI:

```
tools/build.sh
  → renders docs/diagrams/*.mmd to SVG   (mermaid-cli + headless Chromium)
  → gives each SVG an intrinsic size     (else <img> falls back to 300x150 and clips)
  → downloads the webfonts and rewrites the CSS to point at local files
  → copies the static files into _site/
  → fails the build if any runtime asset still points off-site
```

Run it locally with `./tools/build.sh`, then serve `_site/`. GitHub Pages deploys the
same artifact from `.github/workflows/ci.yml`.
