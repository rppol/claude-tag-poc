/* claude-tag-poc — the UI.
 *
 * This file renders. It does not decide anything: the tier, the tool results,
 * the retrieval ranking, the debate termination and the verifier all come from
 * runtime.js executing the registries in agents.js / tools.js.
 *
 * The architecture tab reads the SAME arrays the simulator runs, which is the
 * point — the previous version had a NODES array animating a planner and an
 * executor while the architecture tab explained why those had been deleted.
 */
"use strict";

const P = {
  alice : {n:"Alice Rao",  c:"#7A4E9E", i:"AR"},
  bob   : {n:"Bob Menon",  c:"#C2612F", i:"BM"},
  priya : {n:"Priya Nair", c:"#2F7D6B", i:"PN"},
  sam   : {n:"Sam Iyer",   c:"#3B6FB5", i:"SI"},
  you   : {n:"You",        c:"#4A4458", i:"YO"},
  claude: {n:"Claude",     c:"#5B3578", i:"C", app:true},
};

const CHANNELS = [
  {id:"incidents",   name:"incidents",   topic:"prod issues · page @oncall · Claude is in this channel", on:true},
  {id:"alerts-prod", name:"alerts-prod", topic:"Alertmanager firehose", unread:12},
  {id:"platform",    name:"platform",    topic:"platform team"},
  {id:"sales-eu",    name:"sales-eu",    topic:"different scope · Claude cannot read eng memory"},
];

/* ─────────────── helpers ─────────────── */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const fmt = s => esc(s)
  .replace(/&lt;@(\w+)&gt;|@(\w+)/g, (_, a, b) => `<span class="mention">@${a || b}</span>`)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*([^*]+)\*/g, "<b>$1</b>");
const clock = () => new Date().toTimeString().slice(0, 5);
const j = v => JSON.stringify(v, null, 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ─────────────── chat ─────────────── */
let typingEl = null;
function say(who, text, o = {}) {
  const p = P[who] || P.you, box = $("msgs");
  const el = document.createElement("div");
  el.className = "msg" + (who === "claude" ? " bot" : "") + (o.ambient ? " ambient" : "");
  el.innerHTML = `
    <div class="av" style="background:${p.c}">${p.i}</div>
    <div>
      <div><span class="who">${esc(p.n)}</span>${o.tag ? `<span class="tag">${o.tag}</span>` : ""}<span class="at">${esc(o.at || clock())}</span></div>
      <div class="body">${fmt(text)}</div>
      ${o.reacts ? `<div class="reacts">${o.reacts.map(r => `<b>${esc(r)}</b>`).join("")}</div>` : ""}
      ${o.gate ? `<div class="reacts"><b>Approve</b><b>Deny</b></div>` : ""}
    </div>`;
  box.appendChild(el);
  if (typingEl) box.appendChild(typingEl);
  box.scrollTop = box.scrollHeight;
}
function typing(on) {
  if (on && !typingEl) {
    typingEl = document.createElement("div");
    typingEl.className = "msg";
    typingEl.innerHTML = `<div class="av" style="background:${P.claude.c}">C</div>
      <div class="typing"><span class="dots"><i></i><i></i><i></i></span> Claude is working…</div>`;
    $("msgs").appendChild(typingEl); $("msgs").scrollTop = 1e9;
  } else if (!on && typingEl) { typingEl.remove(); typingEl = null; }
}

/* ─────────────── the span inspector ───────────────
   Every span expands. There is no span whose contents you have to take on
   trust, because "we called an agent" is exactly the abstraction this page
   exists to replace. */

const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
const pre = (label, body, cls = "") =>
  `<div class="blk ${cls}"><div class="blk-h">${esc(label)}<span>${body.length} chars</span></div><pre>${esc(body)}</pre></div>`;

function spanBody(s) {
  const out = [];

  if (s.because) out.push(`<p class="why"><b>Why now:</b> ${esc(s.because)}</p>`);

  if (s.kind === "model") {
    out.push(`<div class="meta">${kv("agent", `${s.agent} · ${s.model} model`)}
      ${kv("tokens", `${s.tokIn} in · ${s.tokOut} out${s.budget ? ` · budget ${s.budget}` : ""}${s.over ? ' <b class="bad">over</b>' : ""}`)}
      ${kv("latency", s.ms + " ms")}</div>`);
    // 923 chars of every prompt are the shared preamble, identical for every
    // agent. Showing it first in a 280px window means you meet the same four
    // rules in every span and scroll to reach the part that differs.
    if (s.system.startsWith(PREAMBLE)) {
      out.push(`<details class="pre-fold"><summary>Shared preamble — ${PREAMBLE.length} chars, identical for every agent</summary><pre>${esc(PREAMBLE)}</pre></details>`);
      out.push(pre(`SYSTEM PROMPT — the part specific to ${s.label}`, s.system.slice(PREAMBLE.length).trim(), "sys"));
    } else {
      out.push(pre("SYSTEM PROMPT — sent verbatim", s.system, "sys"));
    }
    out.push(pre("USER TURN — assembled from the live context", s.user, "usr"));
    out.push(pre("RESPONSE", s.output, "out"));
  }

  if (s.kind === "tool") {
    const sp = s.spec;
    out.push(`<div class="meta">${kv("server", sp ? sp.server : "—")}
      ${kv("policy", sp ? `<span class="pol ${sp.policy}">${sp.policy}</span>` : "—")}
      ${kv("stage", `<span class="stage ${s.ok ? "ok" : "no"}">${s.stage}</span>`)}
      ${kv("latency", s.ms + " ms")}</div>`);
    out.push(pre("REQUEST — arguments as dispatched", j(s.args), "usr"));
    out.push(s.ok ? pre("RESPONSE", j(s.result), "out")
                  : `<div class="blk err"><div class="blk-h">REJECTED at the <b>${esc(s.stage)}</b> stage</div><pre>${esc(s.error)}</pre></div>`);
    if (s.then) out.push(`<p class="why then"><b>What it changed:</b> ${esc(s.then)}</p>`);
  }

  if (s.kind === "vector") {
    out.push(`<div class="meta">${kv("model", s.model)}${kv("dims", s.dims)}
      ${kv("latency", s.ms + " ms")}</div>`);
    out.push(pre("QUERY TEXT — embedded", s.query, "usr"));
    out.push(`<div class="blk sys"><div class="blk-h">QUERY VECTOR <span>first 8 of ${s.dims}</span></div>
      <pre>[${s.preview.join(", ")}, … ]</pre></div>`);
    out.push(`<div class="blk sys"><div class="blk-h">FILTER PREDICATE — applied <b>inside</b> the query</div>
      <pre>${esc(s.predicate)}</pre></div>`);
    out.push(`<p class="why"><b>${s.inScope} of ${s.corpus}</b> memories were candidates.
      <b>${s.excluded}</b> were excluded by the predicate before ranking — they are absent from the
      result set, not filtered out of it.</p>`);
    // A six-column table in a 400px panel gives the memory text one word per
    // line. One card per hit, meta on top, text as prose underneath.
    out.push(s.hits.length
      ? s.hits.map(h => `<div class="hit">
          <div class="hit-h"><code>${esc(h.id)}</code><b>${h.score}</b>
            <span>${esc(h.kind)} · ${h.age}d</span><em>${esc(h.prov)}</em></div>
          <p>${esc(h.text)}</p>
          <div class="hit-m">matched ${h.matched.map(m => `<code>${esc(m)}</code>`).join(" ")}</div>
        </div>`).join("")
      : `<p class="why bad-note">0 hits. Nothing in this scope matched.</p>`);
  }

  if (s.kind === "route") {
    if (s.rule) out.push(`<div class="blk sys"><div class="blk-h">RULE THAT FIRED</div><pre>${esc(s.rule)}</pre></div>`);
    if (s.note) out.push(`<p class="why">${esc(s.note)}</p>`);
    if (s.operands) out.push(pre("OPERANDS — evaluated against this run", j(s.operands), "usr"));
    if (s.path) out.push(`<p class="why"><b>Path:</b> ${s.path.map(n => `<code>${esc(n)}</code>`).join(" → ")}</p>`);
  }

  if (s.kind === "verify") {
    out.push(`<div class="meta">${kv("tokens checked", s.checked)}${kv("evidence corpus", s.corpus + " tokens")}
      ${kv("verdict", s.ok ? '<b class="good">pass</b>' : '<b class="bad">reject</b>')}</div>`);
    out.push(verifyTable(s.rows, s.unhedged));
  }

  if (s.kind === "gate") {
    if (s.detail) out.push(`<div class="blk sys"><pre>${esc(s.detail)}</pre></div>`);
    if (s.approval) out.push(pre("AWAITING APPROVAL — args echoed verbatim", j(s.approval.args), "usr"));
    if (s.kept?.length) out.push(pre("OBJECTIONS CARRIED FORWARD", j(s.kept), "out"));
    if (s.dropped?.length) out.push(`<div class="blk err"><div class="blk-h">DISCARDED BY THE RUNTIME — before the planner saw them</div><pre>${esc(j(s.dropped))}</pre></div>`);
    if (s.exits) out.push(`<p class="why"><b>Termination bounds, any one sufficient:</b> ${s.exits.map(e => `<code>${esc(e)}</code>`).join(" · ")}</p>`);
  }

  if (s.kind === "a2a") {
    out.push(`<div class="meta">${kv("task", `<code>${esc(s.taskId)}</code>`)}${kv("state", `<span class="a2a-st">${esc(s.state)}</span>`)}${kv("latency", s.ms + " ms")}</div>`);
    if (s.detail) out.push(`<div class="blk sys"><pre>${esc(s.detail)}</pre></div>`);
    if (s.request) out.push(pre("message/send", j(s.request), "usr"));
    if (s.artifact) out.push(pre("ARTIFACT", j(s.artifact), "out"));
  }

  out.push(`<p class="prov ${s.fixture ? "fix" : s.partial ? "part" : "comp"}">${
    s.fixture ? `<b>fixture:</b> ${esc(s.fixture)}. Everything else in this span was computed when you pressed play.`
    : s.partial ? `<b>mixed:</b> ${esc(s.partial)}.`
    : `<b>computed:</b> this span was produced by code running in your browser just now. Change the input and it changes.`}</p>`);
  return out.join("");
}

function verifyTable(rows, unhedged) {
  const t = `<table class="vtab"><tr><th>token</th><th>class</th><th>status</th><th>evidence it was found in</th></tr>` +
    rows.map(r => `<tr class="${r.found ? "" : "no"}">
      <td><code>${esc(r.raw)}</code></td><td>${r.cls}</td>
      <td>${r.found ? '<span class="ok">found</span>' : '<span class="no">NOT FOUND</span>'}</td>
      <td class="src">${r.src ? esc(r.src) : "—"}</td></tr>`).join("") + `</table>`;
  const h = unhedged?.length
    ? `<div class="blk err"><div class="blk-h">UNHEDGED CAUSAL CLAIM — a causal connective with no hedge in its sentence</div>
       <pre>${esc(unhedged.join("\n"))}</pre></div>` : "";
  return t + h;
}

const KIND_LABEL = { model: "model", tool: "tool", vector: "vector", route: "route", verify: "verify", gate: "gate", a2a: "a2a" };

function renderSpan(s, i) {
  const el = document.createElement("details");
  el.className = "span k-" + s.kind + (s.ok === false ? " failed" : "") + (s.async ? " async" : "");
  const badge = (s.fixture ? `<i class="pv fix">fixture</i>`
    : s.partial ? `<i class="pv part">mixed</i>` : `<i class="pv comp">computed</i>`)
    + (s.async ? `<i class="pv async">after the reply</i>` : "");
  el.innerHTML = `<summary>
      <span class="ix">${String(i + 1).padStart(2, "0")}</span>
      <span class="kd">${KIND_LABEL[s.kind]}</span>
      <span class="ag">${esc(s.label || s.agent)}</span>
      <span class="hd">${esc(s.head || "")}</span>
      ${badge}<span class="ms">${s.ms}ms</span>
    </summary><div class="sbody">${spanBody(s)}</div>`;
  return el;
}

/* ─────────────── run ─────────────── */
let running = false, lastRun = null;

async function play(flow) {
  if (running) return;
  running = true;
  document.querySelectorAll(".sc").forEach(b => b.disabled = true);

  setChannel(flow.channel);
  $("msgs").innerHTML = "";
  $("trace").innerHTML = "";
  $("traceEmpty").style.display = "none";
  for (const m of flow.thread) say(m.user, m.text, { at: m.at });

  // The whole run is COMPUTED first, then revealed. Nothing below this line
  // can change an outcome — the pacing is presentation, not simulation.
  const spans = [];
  const rt = new Run(flow, s => spans.push(s));
  let answer = "";
  try { answer = flow.run(rt); } catch (e) { spans.push({ kind: "gate", agent: "orchestrator", label: "error", ms: 0, head: e.message }); }
  lastRun = { flow, rt, spans, answer };

  ack();
  setState("running");
  const slow = !matchMedia("(prefers-reduced-motion: reduce)").matches;

  try {
    const live = spans.filter(s => !s.async), after = spans.filter(s => s.async);
    for (let i = 0; i < live.length; i++) {
      const s = live[i];
      if (slow) await sleep(Math.min(600, 120 + s.ms / 5));
      if (s.kind === "model" && s.agent === "writer") typing(true);
      $("trace").appendChild(renderSpan(s, i));
      $("trace").scrollTop = 1e9;
      stats(rt, i + 1);
      if (s.kind === "gate" && s.approval) {
        say("claude", `I need approval before I write anything.\n\n*${s.approval.tool}*\n\`${Object.entries(s.approval.args).map(([k, v]) => `${k}: ${v}`).join("` · `")}\`\n\nApprove or deny in this thread.`, { tag: "APP", gate: true });
        if (slow) await sleep(700);
        say("priya", "approved", { at: clock() });
      }
    }
    typing(false);
    if (answer) say("claude", answer, { tag: "APP", ambient: flow.id === "ambient" });
    // Everything below this line is off the critical path — the person who
    // asked is already reading the answer.
    for (let i = 0; i < after.length; i++) {
      if (slow) await sleep(300);
      $("trace").appendChild(renderSpan(after[i], live.length + i));
      $("trace").scrollTop = 1e9;
    }
    setState("idle");
    renderLedger(lastRun);
    openSandbox(lastRun);
  } finally {
    running = false;
    document.querySelectorAll(".sc").forEach(b => b.disabled = false);
  }
}

function stats(rt, n) {
  const tier = TIERS.find(t => t.id === rt.tierId);
  $("tstats").innerHTML =
    (tier ? `<span class="t-tier"><b>${tier.id}</b> ${tier.name}</span>` : "") +
    `<span><b>${ackMs}</b>ms ack</span>` +
    `<span><b>${n}</b> spans</span>` +
    `<span><b>${(rt.ms / 1000).toFixed(1)}s</b>` + (rt.asyncMs ? ` <em>+${(rt.asyncMs / 1000).toFixed(1)}s after</em>` : "") + `</span>` +
    `<span><b>${(rt.tokIn / 1000).toFixed(1)}k</b> in · <b>${rt.tokOut}</b> out</span>` +
    `<span><b>${rt.calls}</b> tools</span>` +
    (tier ? `<span class="t-path">${tier.nodes.join(" → ")}</span>` : "");
}
// The 3s ack budget had a whole panel and a meter. It is one number, and the
// only interesting thing about it is that it is two orders of magnitude clear.
let ackMs = 0;
function ack() { ackMs = 28 + Math.floor(Math.random() * 34); }
function setState(s) {
  const el = $("rtState");
  el.textContent = s;
  el.className = (s === "running" || s === "waiting") ? "busy" : "";
}


/* The fixture ledger. You should not have to infer how much of this was
   pre-written — it is counted for you. */
function renderLedger(run) {
  const fx = run.spans.filter(s => s.fixture);
  const mx = run.spans.filter(s => s.partial);
  $("ledger").innerHTML =
    `<div class="lg-row"><b>${run.spans.length - fx.length - mx.length}</b> spans computed in your browser</div>` +
    (mx.length ? `<div class="lg-row part"><b>${mx.length}</b> mixed — computed, with one illustrative value</div>` : "") +
    `<div class="lg-row fix"><b>${fx.length}</b> fixtures consumed — all of them model output</div>` +
    fx.map(f => `<div class="lg-item"><code>${esc(f.agent)}</code> ${esc(f.fixture)}</div>`).join("") +
    `<p class="lg-note">A static page holds no API key, so the model's text is the one thing
     that cannot be real. Every tier decision, tool result, retrieval score, budget and
     verifier verdict above was executed.</p>`;
}

/* ─────────────── the part you can't fake: run the verifier on YOUR text ─────────────── */
function openSandbox(run) {
  const box = $("sandbox");
  box.hidden = false;
  const ta = $("sbText");
  ta.value = run.answer || "";
  sandboxCheck();
}
function sandboxCheck() {
  if (!lastRun) return;
  const v = verify($("sbText").value, lastRun.rt.evidence);
  $("sbVerdict").className = "sb-verdict " + (v.pass ? "ok" : "no");
  $("sbVerdict").textContent = v.pass
    ? `pass — ${v.checked} claim tokens, all grounded in ${v.corpus} evidence tokens`
    : `reject — ${v.unsupported.length} unsupported${v.unhedged.length ? `, ${v.unhedged.length} unhedged causal` : ""}`;
  $("sbTable").innerHTML = verifyTable(v.rows, v.unhedged);
}

/* Live tier readout — the predicate re-evaluates on every keystroke. */
function liveTier() {
  const q = $("input").value.trim();
  const el = $("tierLive");
  if (!q) { el.hidden = true; return; }
  const d = tierFor({ question: q, toolHints: [], retryReason: $("incToggle").checked ? "VERIFY_FAIL" : null });
  el.hidden = false;
  el.innerHTML = `<b>${d.tier}</b> <code>${esc(d.rule)}</code> <span>${esc(d.note)}</span>`;
}

/* ─────────────── channels ─────────────── */
function setChannel(id) {
  const c = CHANNELS.find(x => x.id === id) || CHANNELS[0];
  CHANNELS.forEach(x => x.on = x.id === c.id);
  renderChannels();
  $("chanName").textContent = "# " + c.name;
  $("chanTopic").textContent = c.topic;
}
function renderChannels() {
  $("chans").innerHTML = CHANNELS.map(c =>
    `<li class="${c.on ? "on" : ""}"><span class="h">#</span>${esc(c.name)}${c.unread ? `<span class="unread">${c.unread}</span>` : ""}</li>`).join("");
}

/* ═══════════════ architecture tab — rendered from the SAME registries ═══════════════ */

const FAILS = [
  ["Platform retry storm","<code>UNIQUE(event_id)</code>. The retry becomes a rejected insert instead of a duplicate answer — no coordination, no dedupe service."],
  ["Worker dies mid-run","A lease, not an <code>except</code> handler. A SIGKILL runs no handler, so without the sweep the row sits in <code>running</code> forever."],
  ["Two workers post the same answer","The lease must exceed the worst-case run, and the right to post is reserved by an atomic UPDATE fenced on the attempt count. A worker whose lease lapsed holds a stale token and matches no row."],
  ["One channel floods the queue","One run in flight per channel. FIFO is not fair when a single alert channel can put 200 rows ahead of the whole workspace."],
  ["A forged turn in the transcript","Bodies are flattened before formatting. Attribution lives in the line structure, so a newline used to manufacture a turn from someone who never spoke."],
  ["Memory crosses a channel","The scope predicate runs inside the query, derived from the channel binding. Post-filtering leaks through result counts and ranking."],
  ["Memory poisoned by a channel member","Nothing is written that a tool did not assert or a human did not confirm. Decay cannot fix a fact that was wrong the day it was written."],
  ["The model invents a number","A mechanical set-difference over every claim token, against tool results and the transcript — and never against the model's own prior turns."],
  ["The debate never ends, or rubber-stamps","Five independent termination bounds, three of them constants. And the critic never sees the planner's reasoning, only its conclusion, with its own budget to check it."],
];

const CAP = [
  ["Engineers in workspace","100","Stated input."],
  ["Mentions per active user per day","6","An assumption, and the number most worth challenging. Phase 1 exists partly to replace it with a measurement."],
  ["Runs per day","~240","40 people in Claude-enabled channels × 6. Ambient adds ~12."],
  ["Model calls per run","1 / 2–3 / 4–6","T0 / T1 / T2. Two of the five nodes on the common path run no model at all."],
  ["p95 <i>service</i> vs <i>response</i>","33s vs 106s / 48s","Service is time to produce an answer once a worker starts. Response is what a person waits: 1 worker / 2 workers, M/D/c at 0.72/min. Queue wait is 2.8× the service figure at one worker, and it was never derived until someone asked."],
  ["Runs/min one worker absorbs<br>before p95 doubles","~0.8","ρ≈0.5. The row that makes every other row actionable."],
  ["Workers to deploy","2 (3 at Phase 3)","Two for load, a third so a rolling restart is not a degradation."],
  ["LLM tokens per day","~2.9M in / ~0.2M out","Was ~3.4M. Deleting the librarian's model call removed 18% of every run for no loss, because nothing downstream read its output."],
  ["Ambient triage tokens/day","~1–2M","Scales with <i>messages seen</i>, not answers posted — plausibly the largest line here, and it was missing entirely from the first version of this table."],
  ["Postgres · graph checkpoints","~25 GB / year","A checkpointer serialises full state per node per run. The largest writer in the stack."],
];

const PHASES = [
  {k:"Phase 1 · 2 weeks", n:"Shadow", p:"One channel, six volunteers, read-only tools, T0/T1 only. Memory off. Measure the real mentions-per-day and the T2 share.", g:"Gate: useful without editing, in the majority of runs."},
  {k:"Infra · alongside", n:"The stack the phases assume", p:"Postgres before a second worker. Tracing before traces are sampled. LEASE_SECONDS raised to 600 before debate ships at all.", g:"Gate: each phase blocked until its infrastructure exists."},
  {k:"Phase 2 · 3 weeks", n:"Assisted", p:"Three channels, 25 people. Memory on. T2 debate on. Write tools behind always_ask. Red-team the scope boundary deliberately.", g:"Gate: isolation holds under an attempt to break it, and debate_flip_rate clears 10%."},
  {k:"Phase 3 · 4 weeks", n:"Org-wide", p:"All 100. Ambient still off. Budgets and per-agent allowlists enforced. Traces sampled and reviewed weekly.", g:"Gate: spend predictable, no scope incident."},
  {k:"Phase 4 · ongoing", n:"Ambient", p:"Opt-in per channel, starting with a low-traffic one — not #alerts-prod. Offer before post. Replies and mutes are the signal; a 👍 is not.", g:"Gate: mute rate stays below the agreed line."},
];

const REVIEW = [
  ["blocker","<b>Debate does not fit the current lease.</b> Eight model calls at a 30s timeout is 300s against a 300s lease — the same class of bug that already put two identical answers in a public channel here. <code>LEASE_SECONDS</code> must go to 600 and the debate must get its own 90s wall-clock budget, in the commit that builds it."],
  ["blocker","<b>Scope isolation is the whole security model, and it is one predicate.</b> It needs a test attempting every reachable path — direct query, semantic neighbour, injected instruction, and a tool that could exfiltrate — running in CI, not a manual check before launch."],
  ["high","<b>Debate is unfalsifiable without instrumentation.</b> Ship <code>debate_flip_rate</code>, <code>flip_regret</code> and <code>critic_ablation_delta</code> from day one. If ablating the critic changes nothing, the critic is theatre and a second pass was doing the work."],
  ["high","<b>The verifier's biggest hole is a false negative.</b> Right tokens, wrong pairing, passes. Fixing it needs span-level evidence binding, which is not forty-five lines."],
];

function renderArch() {
  /* Tier is the primary axis on purpose. Eleven equal cards would read as a
     re-expansion to nine, which is the argument this page is making against. */
  $("tierCards").innerHTML = TIERS.map(t => `
    <div class="tr-card">
      <div class="tr-h"><b>${t.id}</b><em>${t.name}</em><span>${t.calls} model calls</span></div>
      <p>${esc(t.when)}</p>
      <div class="tr-path">${t.nodes.map(n => `<code>${esc(n)}</code>`).join("<i>→</i>")}</div>
    </div>`).join("");

  $("agentCards").innerHTML = AGENTS.map(a => `
    <details class="ag-card">
      <summary><i style="background:${a.colour}"></i><b>${esc(a.name)}</b>
        <em>${a.model === "none" ? "no model" : a.model}</em>
        <span class="tchip">${esc(a.tier)}</span></summary>
      <p class="goal"><b>Owns:</b> ${esc(a.owns)}</p>
      <dl><dt>in</dt><dd>${esc(a.inputs)}</dd><dt>out</dt><dd><code>${esc(a.output)}</code></dd>
        <dt>tools</dt><dd>${a.tools.length ? a.tools.map(t => `<code>${esc(t)}</code>`).join(" ") : "none"}</dd>
        <dt>budget</dt><dd>${a.budget ? a.budget + " tokens" : "—"}</dd></dl>
      ${pre(a.model === "none" ? "PREDICATE SOURCE — this is the whole agent" : "SYSTEM PROMPT", a.model === "none" ? a.predicate : a.system, "sys")}
      ${a.model === "none" ? "" : pre("USER TURN TEMPLATE", a.userTemplate, "usr")}
      <p class="fails"><b>How it fails:</b> ${esc(a.fails)}</p>
    </details>`).join("");

  $("toolTable").innerHTML =
    `<div class="trow"><span>Tool</span><span>Policy</span><span>Callers</span><span>Params &amp; clamps</span></div>` +
    TOOLS.map(t => `<div class="trow">
      <b><code>${t.server}.${t.name}</code></b>
      <span><span class="pol ${t.policy}">${t.policy}</span> <em>${t.kind}</em></span>
      <span>${t.callers.map(c => `<code>${esc(c)}</code>`).join(" ")}</span>
      <span>${esc(t.desc)}<br><code class="dim">${esc(Object.keys(t.params.properties || {}).join(", ") || "—")}</code>
        ${t.clamps ? `<br><b class="clamp">clamps</b> <code class="dim">${esc(j(t.clamps).replace(/\s+/g, " "))}</code>` : ""}</span>
    </div>`).join("");

  // The full agent card stays reachable, folded, rather than occupying a section.
  $("toolTable").insertAdjacentHTML("afterend", A2A_CARDS.map(c =>
    `<details class="pre-fold card-fold"><summary>A2A AgentCard · ${esc(c.name)} — the full JSON</summary><pre>${esc(j(c))}</pre></details>`).join(""));

  const rows = (el, head, data, cls = "") => {
    $(el).innerHTML = `<div class="trow">${head.map(h => `<span>${h}</span>`).join("")}</div>` +
      data.map(r => `<div class="trow">${r.map((c, i) =>
        i === 0 ? `<b>${c}</b>` : i === 1 && cls === "num" ? `<span class="num">${c}</span>` : `<span>${c}</span>`).join("")}</div>`).join("");
  };
  rows("failTable", ["Failure", "What stops it"], FAILS);
  rows("capTable", ["Quantity", "Value", "Basis"], CAP, "num");

  $("phaseCards").innerHTML = PHASES.map(p => `
    <div class="ph"><div class="k">${p.k}</div><b>${p.n}</b><p>${p.p}</p><p class="gate">${p.g}</p></div>`).join("");

  $("reviewTable").innerHTML = `<div class="trow"><span>Severity</span><span>Finding</span></div>` +
    REVIEW.map(([s, t]) => `<div class="trow"><span class="sev ${s}">${s}</span><span>${t}</span></div>`).join("");
}

/* ─────────────── boot ─────────────── */
function boot() {
  renderChannels();
  $("faces").innerHTML = ["alice", "bob", "priya", "sam"].map(k =>
    `<i style="background:${P[k].c}">${P[k].i}</i>`).join("");

  $("scenarios").innerHTML = FLOWS.map(f =>
    `<button class="sc" data-id="${f.id}" title="${esc(f.desc)} — ${esc(f.why)}">
       <span class="sc-n"><b>${esc(f.name)}</b><i class="chip ${f.impl}">${
         f.impl === "built" ? "repo" : f.impl === "partly" ? "partly" : "design"
       }</i></span><span class="sc-d">${esc(f.desc)}</span></button>`).join("");
  $("scenarios").addEventListener("click", e => {
    const b = e.target.closest(".sc"); if (!b) return;
    play(FLOW[b.dataset.id]);
  });

  $("input").addEventListener("input", liveTier);
  $("incToggle").addEventListener("change", liveTier);
  $("form").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("input").value.trim(); if (!v) return;
    const d = tierFor({ question: v, toolHints: [], retryReason: $("incToggle").checked ? "VERIFY_FAIL" : null });
    say("you", v);
    $("input").value = ""; liveTier();
    // Honest about what this does: the predicate is real, the run that follows
    // is the nearest flow. Pretending otherwise would be the black box again.
    const pick = d.tier === "T2" ? (/roll ?back|revert|open .*pr/i.test(v) ? "gate" : "debate")
               : d.tier === "T0" ? "direct" : "fast";
    $("trace").innerHTML = "";
    $("traceEmpty").innerHTML = `Your question routed <b>${d.tier}</b> by <code>${esc(d.rule)}</code>. Playing the nearest flow: <b>${esc(FLOW[pick].name)}</b>.`;
    $("traceEmpty").style.display = "";
    setTimeout(() => play(FLOW[pick]), 900);
  });

  $("sbText").addEventListener("input", sandboxCheck);

  const tabs = [["tab-arch", "view-arch"], ["tab-sim", "view-sim"]];
  function select(i, focus) {
    tabs.forEach(([t, v], k) => {
      const on = k === i;
      $(t).classList.toggle("on", on);
      $(t).setAttribute("aria-selected", on);
      $(t).tabIndex = on ? 0 : -1;
      $(v).classList.toggle("on", on);
      $(v).hidden = !on;
    });
    if (focus) $(tabs[i][0]).focus();
    window.scrollTo(0, 0);
  }
  tabs.forEach(([t], i) => {
    $(t).addEventListener("click", () => select(i));
    $(t).addEventListener("keydown", e => {
      let n = null;
      if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = tabs.length - 1;
      if (n !== null) { e.preventDefault(); select(n, true); }
    });
  });
  select(0);

  renderArch();
  for (const m of FLOW.fast.thread.slice(0, 2)) say(m.user, m.text, { at: m.at });
}
document.addEventListener("DOMContentLoaded", boot);
