/* claude-tag-poc — the five things it does.
 *
 * A flow is an INPUT (a channel, a thread, a question) plus the model outputs
 * that would come back. Everything else — the queue writes, tier, tool
 * dispatch, retrieval ranking, memory writes, debate termination, the verifier
 * — is computed by runtime.js when the flow runs.
 *
 * Every model output below is a fixture and is labelled as one. The writer
 * fixtures are checked against the real verifier by tools/check_registry.js:
 * a hand-written answer that cannot survive its own evidence is a lie about
 * the system, and that is the exact failure mode this repo has hit five times.
 */
"use strict";

const M = (user, at, text) => ({ user, at, text });

const FLOWS = [

  /* ═══════════ 1 · investigate an incident ═══════════ */
  {
    id: "investigate", name: "Investigate an incident", desc: "the adaptive tool loop",
    impl: "partly", why: "the queue writes underneath are in the repo and tested; the agent graph above is designed",
    channel: "incidents", scope: "eng-claude", asker: "bob",
    question: "<@Claude> checkout is throwing 500s since about 14:02 — where do I start?",
    thread: [
      M("alice", "14:04", "checkout error rate just jumped, anyone looking?"),
      M("bob", "14:05", "seeing it too, started a few minutes ago"),
      M("bob", "14:06", "<@Claude> checkout is throwing 500s since about 14:02 — where do I start?"),
    ],
    proves: "The second tool call is chosen from the first one's result. A fixed plan could not know which deploy window to ask about, because the window comes from where the metric stepped.",
    run(rt) {
      rt.accept("e_401");
      rt.tier({ toolHints: ["grafana"] });
      const ctx = rt.library({ because: "the thread names a service and a rough time, and nothing else" });

      rt.tool("executor", "grafana.list_metrics", { service: "checkout-api" },
        { because: "the prompt forbids guessing an expression — a wrong one costs a round trip and returns nothing" });

      const q = rt.tool("executor", "grafana.query_datasource",
        { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "13:40", to: "14:10", step: 60 },
        { because: "list_metrics returned this exact expression; the window straddles the 14:02 bob reported",
          then: "the step is at 14:01:40 — so the deploy window to ask GitHub about is 13:40–14:10, which was NOT knowable before this call returned" });

      rt.tool("executor", "github.list_deploys", { service: "checkout-api", since: "13:40", limit: 5 },
        { because: `the step is at ${q.data?.step_change?.at} — ask what shipped in that window, not in a generic one` });

      rt.tool("executor", "github.get_config",
        { repo: "acme/checkout-api", keys: ["retry.max_attempts", "pool.max"] },
        { because: "the deploy's changelog names retry.max_attempts; confirm the live value rather than trusting the changelog" });

      rt.tool("executor", "pagerduty.get_oncall", { team: "payments" },
        { because: "an answer that does not name a human is not actionable" });

      rt.tool("executor", "pagerduty.page_oncall",
        { team: "payments", message: "checkout 5xx at 41 req/s since 14:01:40", urgency: "high" },
        { because: "the agent proposes waking someone up",
          then: "refused — two_person, the only tool in the catalogue with that policy. One approval is not two, and paging is the highest-consequence write here." });

      rt.think("executor", { question: rt.sc.question, entities: ctx.entities.join(", "),
        results: fmtResults(rt.results), budget: 12000 - rt.tokIn, calls: rt.calls },
        `{"findings":[
  {"tool":"grafana.query_datasource","result_id":"ev_2","says":"5xx steps 0.2 -> 41 at 14:01:40"},
  {"tool":"github.list_deploys","result_id":"ev_3","says":"v2.3.1 shipped 14:01, 40s before the step"},
  {"tool":"github.get_config","result_id":"ev_4","says":"retry.max_attempts is live at 0"},
  {"tool":"pagerduty.get_oncall","result_id":"ev_5","says":"@priya is on call for payments"}],
 "unresolved":["whether max_attempts 0 is sufficient to explain the magnitude"]}`,
        { because: "the next call would not change what gets written — stop" });

      const draft = rt.think("writer", { user: rt.sc.asker, question: rt.sc.question,
        results: fmtResults(rt.results), debate: "(no debate — T1)", memories: fmtMem(ctx.memories) },
        `The 5xx rate steps at *14:01:40*, which lines up with \`checkout-api\` *v2.3.1* going out at 14:01.\n\n• \`rate(http_5xx{service="checkout-api"}[5m])\` goes 0.2 → 41 req/s at 14:01:40\n• that deploy set \`retry.max_attempts\` 3 → 0, and the live value is now 0\n• @priya is on call for payments\n\nStart with the retry config. The timing is consistent with it and nothing else shipped in that window.`,
        { because: "the step at 14:01:40 and the deploy at 14:01 are 40 seconds apart, and get_config confirms the value is live at 0 — so the answer leads with the correlation and stops short of asserting cause" });
      rt.check(draft);
      rt.settle();
      return draft;
    },
  },

  /* ═══════════ 2 · book the review, send the writeup ═══════════ */
  {
    id: "writeup", name: "Book a review, email the writeup", desc: "two irreversible writes, both gated",
    impl: "design", why: "the policy gate and the argument echo are real code; interrupt() and the calendar and mail servers are designed",
    channel: "incidents", scope: "eng-claude", asker: "priya",
    question: "<@Claude> set up a review for this and email everyone what happened",
    thread: [
      M("priya", "14:40", "ok, reverted and it's recovering"),
      M("priya", "14:41", "<@Claude> set up a review for this and email everyone what happened"),
    ],
    proves: "Sending mail and booking time are the two writes people most want to see before they happen. The slot is derived from real free/busy, and the full body is shown before it leaves.",
    run(rt) {
      rt.accept("e_402");
      rt.tier({ toolHints: ["calendar"] });
      const ctx = rt.library({ because: "a writeup is assembled from what the incident established, so the recall matters more than the last message" });

      // Rebuild the facts rather than trusting memory — a summary that quotes a
      // remembered number is a summary that can be stale.
      rt.tool("executor", "github.list_deploys", { service: "checkout-api", since: "13:40", limit: 5 },
        { because: "a writeup states what shipped, and that is a lookup rather than a recollection" });
      rt.tool("executor", "grafana.query_datasource",
        { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "13:40", to: "14:10", step: 60 },
        { because: "the same for the numbers: fetch them again rather than quoting the thread" });

      const slot = rt.tool("executor", "calendar.find_slot",
        { attendees: ["alice", "bob", "priya"], minutes: 30, after: "15:00" },
        { because: "propose a time that exists rather than inventing one",
          then: "alice is busy 15:00–16:00 and priya 16:00–17:00, so the first slot all three are free is computed, not guessed" });

      // Both writes come back as policy refusals first. That is the gate.
      const ev = rt.tool("executor", "calendar.create_event",
        { title: "Checkout 5xx review", start: slot.data.start, minutes: 30, attendees: ["alice", "bob", "priya"],
          agenda: "v2.3.1 set retry.max_attempts to 0" },
        { because: "putting a meeting in three people's calendars is a write",
          then: "refused at the policy stage — always_ask. The title, time and invitee list are echoed verbatim for approval." });

      rt.emit({ kind: "gate", agent: "human_gate", label: "interrupt()", ms: 0,
        head: "graph paused · state checkpointed",
        detail: "calendar.create_event\ntitle: Checkout 5xx review\nstart: " + slot.data.start + " · 30 min\ninvitees: alice, bob, priya\n\nThe worker is free while this waits. The pause is a row, not a blocked thread.",
        approval: { tool: "calendar.create_event", args: { title: "Checkout 5xx review", start: slot.data.start, minutes: 30 } },
        fixture: null });
      rt.db("UPDATE · checkpoint", {
        sql: "UPDATE runs SET status='waiting', checkpoint=? WHERE id=?",
        head: "graph state serialised at human_gate",
        because: "a paused run must survive the worker. The lease sweep must also not reclaim it, which is why 'waiting' is a distinct status from 'running'." });

      rt.approve("calendar.create_event");
      rt.tool("executor", "calendar.create_event",
        { title: "Checkout 5xx review", start: slot.data.start, minutes: 30, attendees: ["alice", "bob", "priya"],
          agenda: "v2.3.1 set retry.max_attempts to 0" },
        { because: "@priya approved in thread — resumed from the checkpoint with the human's input" });
      void ev;

      const body = rt.think("writer", { user: rt.sc.asker, question: "draft the summary mail",
        results: fmtResults(rt.results), debate: "(no debate)", memories: fmtMem(ctx.memories) },
        `checkout-api v2.3.1 went out at 14:01. It set retry.max_attempts from 3 to 0.\n\nThe 5xx rate goes 0.2 to 41 req/s at 14:01:40, forty seconds after the deploy. The config value is live at 0.\n\nReverted at 14:40. Review booked for 17:00.`,
        { head: "drafts the mail body",
          because: "the body is written before it is sent so a human reads the actual text, not a description of it" });

      rt.approve("email.send_summary");
      rt.tool("executor", "email.send_summary",
        { to: ["alice@acme.internal", "bob@acme.internal", "priya@acme.internal"],
          subject: "Checkout 5xx on 2026-08-14 — what happened", body },
        { because: "mail is irreversible the moment it leaves, so the whole body goes in front of a human first",
          then: "approved, then sent. The recipient list is checked against the directory — an address that is not in it is rejected before the gate, not after." });

      const draft = rt.think("writer", { user: rt.sc.asker, question: rt.sc.question,
        results: fmtResults(rt.results), debate: "(no debate)", memories: fmtMem(ctx.memories) },
        `Done — both after you approved them.\n\n• *Checkout 5xx review* at 17:00 for 30 minutes, the first slot Alice, Bob and Priya are all free. Event \`evt_5512\`.\n• Summary mailed to the same three, subject "Checkout 5xx on 2026-08-14 — what happened".\n\nThe mail says \`v2.3.1\` went out at 14:01 and set \`retry.max_attempts\` to 0, and that the rate went 0.2 → 41 req/s at 14:01:40.`,
        { because: "the reply confirms exactly what was written and to whom — a person who approved a write should be able to check it happened as described without opening another tab" });
      rt.check(draft);
      rt.settle();
      return draft;
    },
  },

  /* ═══════════ 3 · fix an issue on a connected repo ═══════════ */
  {
    id: "fixrepo", name: "Fix an issue in the repo", desc: "read the issue, branch, commit, PR",
    impl: "design", why: "the allowlist, the policy classes and the argument validation are real code; the graph and the gate are designed",
    channel: "incidents", scope: "eng-claude", asker: "priya",
    question: "<@Claude> can you fix issue 812 — why is max_attempts allowed to be 0 at all?",
    thread: [
      M("priya", "15:02", "filed #812 for the retry default"),
      M("priya", "15:03", "<@Claude> can you fix issue 812 — why is max_attempts allowed to be 0 at all?"),
    ],
    proves: "A write escalates to debate BEFORE the human is asked, so the approval is the second review rather than the only one. Branch creation is auto because it is reversible; the commit is not.",
    run(rt) {
      rt.accept("e_403");
      rt.tier({ toolHints: ["github"] });
      const ctx = rt.library({ because: "the ask names an issue number, so the issue is the context — not the metrics" });

      const iss = rt.tool("executor", "github.get_issue", { repo: "acme/checkout-api", number: 812 },
        { because: "read what was actually asked for before proposing a change to satisfy it" });
      rt.tool("executor", "github.get_config", { repo: "acme/checkout-api", keys: ["retry.max_attempts"] },
        { because: "confirm the live value — the issue describes a state that may already have been changed" });
      rt.tool("executor", "github.get_diff", { repo: "acme/checkout-api", base: "main", head: "v2.3.1" },
        { because: "read the change that introduced the problem before writing one that fixes it",
          then: "one file, one line — so the fix should be one line too. A larger diff here would have argued for a revert instead." });

      const dbg = rt.debate(rt.sc.question, { memories: ctx.memories, entities: ["checkout-api", "retry.max_attempts"] }, [
        { why: "the issue asks for two things — reject 0, and default to 3 — and only one of them is a config edit",
          proposal: `{"claim":"Set max_attempts to 3 in config/retry.yaml and open a PR against main.",
 "evidence":[{"id":"ev_1","supports":"issue 812 asks for a default of 3"},{"id":"ev_2","supports":"the live value is 0"}],
 "action":{"kind":"tool","tool":"github.commit_file","args":{"path":"config/retry.yaml"}},
 "confidence":0.86,
 "alternatives_considered":[
   {"hypothesis":"add validation that rejects 0 rather than changing the value","ruled_out_by":"not ruled out - the issue asks for both"},
   {"hypothesis":"revert v2.3.1 wholesale","ruled_out_by":"ev_1 - the issue is about the default, not the release"}]}`,
          attackWhy: "the change is small and correct, and the objection is about what it leaves undone rather than what it does",
          attack: `{"objections":[
  {"id":"o1","target":"action","kind":"irreversible","severity":"high",
   "evidence_gap":"a commit on a tier-1 service repo. The diff must be echoed in the approval, not summarised.",
   "cites":"ev_2"},
  {"id":"o2","target":"claim","kind":"alternative_unexamined","severity":"low",
   "evidence_gap":"this sets the value but does not stop the next deploy setting it back to 0. The issue asks for validation too, and this PR does not add it.",
   "cites":"ev_1"}],
 "verdict":"accept"}`,
        },
      ]);

      rt.tool("executor", "github.create_branch", { repo: "acme/checkout-api", name: "fix-812", from: "main" },
        { because: "a branch is a write, but deleting one costs nothing — so it is auto rather than always_ask",
          then: "this is the line between the two policy classes: reversibility, not whether the word 'write' applies" });

      rt.tool("executor", "github.commit_file",
        { repo: "acme/checkout-api", branch: "fix-812", path: "config/retry.yaml",
          content: "max_attempts: 3\nbackoff: exponential\n", message: "retry: default max_attempts to 3 (#812)" },
        { because: "the actual edit",
          then: "refused — always_ask. The before and after content go into the approval, so a human reads the diff rather than a description of it." });

      rt.emit({ kind: "gate", agent: "human_gate", label: "interrupt()", ms: 0,
        head: "graph paused · diff echoed verbatim",
        detail: "github.commit_file  acme/checkout-api @ fix-812\nconfig/retry.yaml\n\n- max_attempts: 0\n+ max_attempts: 3\n  backoff: exponential",
        approval: { tool: "github.commit_file", args: { repo: "acme/checkout-api", branch: "fix-812", path: "config/retry.yaml" },
                    challenged: dbg.rounds[0].kept },
        fixture: null });

      rt.approve("github.commit_file");
      rt.approve("github.create_pull_request");
      rt.tool("executor", "github.commit_file",
        { repo: "acme/checkout-api", branch: "fix-812", path: "config/retry.yaml",
          content: "max_attempts: 3\nbackoff: exponential\n", message: "retry: default max_attempts to 3 (#812)" },
        { because: "approved — resumed from the checkpoint" });

      rt.tool("executor", "github.create_pull_request",
        { repo: "acme/checkout-api", base: "main", head: "fix-812", title: "retry: default max_attempts to 3 (#812)",
          body: "Closes #812." },
        { because: "the base is validated against the repo before a human is asked — a PR opened on a base that does not exist is a plausible and expensive mistake" });

      const draft = rt.think("writer", { user: rt.sc.asker, question: rt.sc.question,
        results: fmtResults(rt.results), debate: `accept, with an irreversible objection attached`, memories: fmtMem(ctx.memories) },
        `Opened *#4471* — \`fix-812\` → \`main\` on \`acme/checkout-api\`.\n\n• \`config/retry.yaml\`: \`max_attempts\` goes 0 → 3, which is what issue 812 asks for\n• the live value was 0 when I checked\n\nOne thing this does *not* do: it sets the default but adds no validation, so a future deploy can set it to 0 again. Issue 812 asks for that too and this PR is not it.`,
        { because: "the critic's surviving low-severity objection is that the fix is incomplete — that belongs in the reply rather than in a trace nobody reads" });
      rt.check(draft);
      void iss;
      rt.settle();
      return draft;
    },
  },

  /* ═══════════ 4 · wake itself up ═══════════ */
  {
    id: "wakeup", name: "Wake itself up later", desc: "the run outlives the worker",
    impl: "design", why: "the durable row is the same runs table that is built and tested; the scheduler and the resumed graph are designed",
    channel: "incidents", scope: "eng-claude", asker: "bob",
    question: "<@Claude> check in an hour whether the revert actually held",
    thread: [
      M("bob", "14:45", "<@Claude> check in an hour whether the revert actually held"),
    ],
    proves: "Long-horizon work is a row, not a held thread. The worker exits, the lease expires cleanly, and a different worker picks the run up an hour later with the context it needs carried on the row.",
    run(rt) {
      rt.accept("e_404");
      rt.tier({ toolHints: ["scheduler"] });
      const ctx = rt.library({ because: "the ask is about something that has not happened yet, so the useful context is what 'held' would mean" });

      rt.tool("executor", "grafana.query_datasource",
        { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "14:30", to: "14:45", step: 300 },
        { because: "record the baseline now, or there is nothing to compare against in an hour" });

      rt.tool("executor", "scheduler.list_pending", { channel: "incidents" },
        { because: "do not stack three wakeups on one question — check what this channel is already waiting on" });

      // Two mechanisms for outliving a worker, side by side: a row we own, and
      // a task someone else owns.
      rt.a2a("Incident Analyst", "postmortem_correlation",
        { service: "checkout-api", signals: ["5xx step at 14:01:40", "retry.max_attempts set to 0"] }, {
        taskId: "tsk_9f2",
        states: [
          { state: "submitted", ms: 180, head: "task created · we hold an id, not a promise",
            detail: "A tool call returns or throws. A task has a lifecycle we have to persist against — which is the same problem the wakeup row solves, seen from the other side." },
          { state: "working", ms: 700, head: "scanning the corpus · 2 of 14" },
          { state: "input-required", ms: 300, head: "the specialist asks US a question",
            asks: "Restrict to checkout-api, or include payments-api? The retry.max_attempts pattern appears in both.",
            detail: "\"Restrict to checkout-api, or include payments-api?\"\n\nThis is the first thing an MCP call cannot do: it has no state to return to." },
          { state: "working", ms: 500, head: "resumed on the same task id after our answer" },
          { state: "completed", ms: 400, head: "1 match · cited",
            artifact: { matches: [{ id: "PM-1183", shared: ["retry-config change immediately before onset"],
                                    differs: ["March raised max_attempts to 8; v2.3.1 set it to 0"] }] } },
        ],
      });

      const wk = rt.tool("executor", "scheduler.schedule_wakeup",
        { at: "15:45", reason: "confirm the checkout revert held", carry: { expr: 'rate(http_5xx{service="checkout-api"}[5m])', peak: 41, stepped_at: "14:01:40" } },
        { because: "an hour is far past any sane lease, so holding the run open is not an option",
          then: "the carry payload is the point: everything the future run needs is on the row, so it does not have to re-derive the context or re-read the thread" });

      const ack = rt.think("writer", { user: rt.sc.asker, question: rt.sc.question,
        results: fmtResults(rt.results), debate: "(no debate)", memories: fmtMem(ctx.memories) },
        `Will do — I have set a check for *15:45*.\n\nBaseline recorded now so there is something to compare: the rate stepped to 41 req/s at 14:01:40.`,
        { head: "acknowledges, then stops", because: "saying nothing for an hour is indistinguishable from having dropped the request" });
      rt.check(ack);

      rt.db("UPDATE · park", {
        sql: "UPDATE runs SET status='done', finished_at=datetime('now') WHERE id=?;\nINSERT INTO runs (event_id, channel, thread_ts, text, next_attempt_at)\nVALUES ('wk_41', 'incidents', '1699.0', ?, '15:45');",
        head: "this run finishes · a second row is queued for 15:45",
        because: "the first run does NOT stay open. It completes, and the future work is a new queued row — so nothing holds a worker, nothing holds a lease, and a restart in between loses nothing.",
        then: "this is the whole of 'long-horizon': a row with a next_attempt_at in the future." });

      rt.emit({ kind: "gate", agent: "orchestrator", label: "— one hour passes —", ms: 0,
        head: "worker restarted twice in between · the row is untouched",
        detail: "Nothing is running. There is a row in `runs` with next_attempt_at = 15:45 and the carry payload on it. Whichever worker is alive at 15:45 claims it.",
        fixture: null });

      rt.db("BEGIN IMMEDIATE", {
        sql: "SELECT * FROM runs WHERE status='queued' AND next_attempt_at <= datetime('now') ORDER BY id LIMIT 1",
        head: "claimed at 15:45 by a different worker · attempts 1",
        because: "the same claim predicate that handles a retry handles a scheduled wakeup. There is no second mechanism, because next_attempt_at already meant 'not before this time'." });

      const after = rt.tool("executor", "grafana.query_datasource",
        { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "15:20", to: "15:40", step: 300 },
        { because: `the expression came off the carry payload, not from re-reading the thread — ${wk.data.id} carried it`,
          then: "no step_change in this window, and the value is flat — which is what 'held' looks like" });

      const draft = rt.think("writer", { user: rt.sc.asker, question: "did the revert hold?",
        results: fmtResults(rt.results), debate: "(no debate)", memories: fmtMem(ctx.memories) },
        `Checked back as promised. *The revert held.*\n\n• \`rate(http_5xx{service="checkout-api"}[5m])\` is 0.3 req/s flat across 15:20–15:40\n• it had peaked at 41 req/s after the step at 14:01:40\n\nNothing to do. I am not going to check again unless you ask.`,
        { because: "the comparison is only meaningful against the baseline this run carried forward, so both numbers belong in the answer" });
      rt.check(draft);
      void after;
      rt.settle();
      return draft;
    },
  },

  /* ═══════════ 5 · remember what was learned ═══════════ */
  {
    id: "remember", name: "Remember what was learned", desc: "write, recall, contradict, and the scope wall",
    impl: "design", why: "the scope predicate, the ranking and the contradiction check are real code; the store and its embeddings are designed",
    channel: "incidents", scope: "eng-claude", asker: "alice",
    question: "<@Claude> note what we learned here so we don't repeat it",
    thread: [
      M("priya", "15:50", "so: never ship max_attempts 0, and raise pool.max if you raise retries"),
      M("alice", "15:51", "<@Claude> note what we learned here so we don't repeat it"),
    ],
    proves: "A memory is only written when a tool asserted it or a human confirmed it, it carries provenance, a contradiction on the same subject is flagged rather than merged, and the scope wall holds when the same question is asked from another channel.",
    run(rt) {
      rt.accept("e_405");
      rt.tier({ toolHints: [] });
      const ctx = rt.library({ because: "before writing anything, see what is already known — a duplicate memory is worse than none" });

      rt.tool("executor", "github.get_config", { repo: "acme/checkout-api", keys: ["retry.max_attempts", "pool.max"] },
        { because: "the Scribe may only write what a tool asserted or a human confirmed. This is the tool half." });

      rt.think("scribe", { scope: rt.scope, question: rt.sc.question,
        results: fmtResults(rt.results), memories: fmtMem(ctx.memories) },
        `[{"subject":"checkout-api","predicate":"retry_default","object":"max_attempts must not be 0; 3 is the safe default",
   "provenance":"human:<@priya>","kind":"resolution"},
  {"subject":"checkout-api","predicate":"pool_sizing","object":"raise pool.max whenever retries are raised",
   "provenance":"human:<@priya>","kind":"resolution"}]`,
        { because: "priya stated both in the thread and a tool confirmed the live config, so both clear the bar. The current metric values do not — those are fetched fresh, never remembered." });

      const written = rt.memWrite([
        { subject: "checkout-api", predicate: "retry_default", kind: "resolution",
          text: "retry.max_attempts must not be 0; 3 is the safe default.",
          provenance: "human:<@priya> + tool:github.get_config", confirmed_by: "priya" },
        { subject: "checkout-api", predicate: "pool_sizing", kind: "resolution",
          text: "Raise pool.max whenever retries are raised, not instead of.",
          provenance: "human:<@priya>", confirmed_by: "priya" },
      ], { because: "scope comes from the channel binding, never from the text. Each row carries provenance, because a memory nobody can trace is unfalsifiable later, which makes it permanent." });

      // The case a similarity threshold gets wrong.
      rt.memWrite([
        { subject: "checkout-api", predicate: "pool_sizing", kind: "resolution",
          text: "pool.max should be lowered to 40 to shed load faster.",
          provenance: "thread:C_INCIDENTS/1702", confirmed_by: null },
      ], { because: "a second claim about the same (subject, predicate) with the opposite sense. Near-identical embeddings, opposite meanings — a distance threshold would merge these and pick one arbitrarily. It is flagged for a human instead." });

      const back = rt.recall("retry max_attempts default pool sizing checkout",
        { because: "the same query again, now that the writes have landed — the new rows are really in the store and really rank" });

      rt.recall("retry max_attempts default pool sizing checkout",
        { asScope: "sales-claude",
          because: "the identical query, dispatched with the binding a #sales-eu event would carry. Nothing else changes." });

      const draft = rt.think("writer", { user: rt.sc.asker, question: rt.sc.question,
        results: fmtResults(rt.results), debate: "(no debate)", memories: fmtMem(back) },
        `Noted, scoped to this channel.\n\n• \`retry.max_attempts\` must not be 0 — 3 is the safe default\n• raise \`pool.max\` whenever retries go up, not instead of\n\nBoth are attributed to @priya and the config value was confirmed by a lookup, not taken from the thread.\n\nOne conflict I am not resolving on my own: something in this channel also claims \`pool.max\` should go *down*. Same subject, opposite direction — I have flagged both rather than picking one.`,
        { because: "the contradiction is the interesting part and it is a human's call, so it goes in the reply rather than being silently resolved" });
      rt.check(draft);
      void written;
      rt.settle();
      return draft;
    },
  },
];

const FLOW = Object.fromEntries(FLOWS.map(f => [f.id, f]));

if (typeof module !== "undefined") module.exports = { FLOWS, FLOW };
