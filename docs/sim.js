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
    if (sp) out.push(pre("PARAM SCHEMA — validated before the call, in code", j(sp.params), "sys"));
    if (sp?.clamps) out.push(pre("CLAMPS", j(sp.clamps), "sys"));
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
    if (s.source) out.push(pre("PREDICATE SOURCE", s.source, "sys"));
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
  $("ckpt").innerHTML = `flow <b>${esc(flow.id)}</b>`;
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
  renderTiers(rt.tierId);
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
  $("tstats").innerHTML =
    `<span><b>${n}</b> spans</span><span><b>${(rt.ms / 1000).toFixed(1)}s</b> service` +
    (rt.asyncMs ? ` <em>+${(rt.asyncMs / 1000).toFixed(1)}s after</em>` : "") + `</span>` +
    `<span><b>${(rt.tokIn / 1000).toFixed(1)}k</b> in</span><span><b>${rt.tokOut}</b> out</span>` +
    `<span><b>${rt.calls}</b> tools</span>`;
}
function ack() {
  const ms = 28 + Math.floor(Math.random() * 34);
  $("ackUsed").textContent = ms;
  $("ackVerdict").textContent = "200 OK · budget kept";
  $("ackBar").style.transform = `scaleX(${Math.max(0.012, ms / 3000)})`;
}
function setState(s) {
  const el = $("rtState");
  el.textContent = s;
  el.className = (s === "running" || s === "waiting") ? "busy" : "";
}

function renderTiers(active) {
  $("lanes").innerHTML = TIERS.map(t => {
    const on = t.id === active;
    return `<li class="${on ? "act" : ""}"><span class="pip"></span>
      <span class="nm">${t.id} · ${t.name}</span>
      <span class="st">${on ? t.nodes.length + " nodes" : t.calls + (t.calls === "1" ? " call" : " calls")}</span></li>` +
      (on ? `<li class="sub"><span></span><span class="path">${t.nodes.join(" → ")}</span></li>` : "");
  }).join("");
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

const PROTO = [
  {h:"MCP", s:"Model Context Protocol · tools you own",
   p:"A typed, synchronous call into a capability inside your trust boundary. The catalogue below is the real one — the simulator dispatches against it, so a schema violation you can read here is a schema violation that actually rejects.",
   l:["Servers wrap Grafana, PagerDuty, GitHub and the platform itself","The agent never sees a credential — it is injected at egress","Per-agent allowlist, enforced as set membership at dispatch","Every call lands in the audit log with its actor"]},
  {h:"A2A", s:"Agent-to-Agent · work you delegate",
   p:"An asynchronous task handed to something with its own goals, model and lifecycle. You do not call it; you ask it, and it can decline. It earns the protocol only if it does something a tool structurally cannot.",
   l:["Agent card advertises skills, auth, transports","submitted → working → input-required | completed | failed | canceled | rejected","It can pause and ask YOU a question, then resume on the same task id","It can outlive the worker that started it"]},
];

const STACK = [
  ["What runs no model","orchestrator · librarian · verifier","Three of the nodes on the common path are code. The librarian was a small-model call until a measurement asked whether anything read its output — nothing did."],
  ["Ingress","Bolt · Socket Mode","No public URL, no signature handling, and the 3-second ack is the SDK's problem rather than yours."],
  ["Queue","Postgres · SKIP LOCKED","One table and a lease. Rows are mutated in place, so this is state, not an audit log."],
  ["Orchestration","LangGraph","Conditional edges, a checkpointer and interrupt() — the three things a hand-rolled loop reinvents badly."],
  ["Tracing","LangSmith","Per-node spans with tokens and latency. Without it, debugging a multi-agent run is archaeology."],
  ["Memory","mem0 + structured rows","Only symptom similarity wants an embedding. Entity facts and causal resolutions are rows, because contradiction is a comparison on (subject, predicate) and not a distance threshold."],
  ["Vectors","Qdrant","Payload filtering happens inside the query, which is what makes the scope predicate enforceable."],
  ["Models","Routed by tier","A tier predicate does not need a model at all. Librarian and Scribe are small; Planner, Critic and Writer are not."],
  ["Policy","Own it","Allowlist, clamps, budget and approval are code. Anything enforced only in a prompt is a request."],
];

const FAILS = [
  ["Platform retry storm","UNIQUE(event_id). The retry becomes a rejected insert instead of a duplicate answer."],
  ["Worker dies mid-run","Lease expiry requeues; the checkpointer resumes at the failed node so completed tool calls are not repeated."],
  ["Two workers post the same answer","The lease must exceed the worst-case run, and the right to post is reserved with an atomic UPDATE fenced on the attempt count."],
  ["One channel floods the queue","One run in flight per channel. FIFO is not fair when a single alert channel can put 200 rows ahead of everyone."],
  ["A forged turn in the transcript","Message bodies are flattened before formatting. Attribution lives in the line structure, so a newline used to manufacture a turn from someone who never spoke."],
  ["Memory crosses a channel","Scope in the query predicate, derived from the channel binding. Post-filtering leaks through result counts and ranking, and sits one refactor from deletion."],
  ["Prompt injection from a channel","Treated as content, never as instruction. The real boundary is the allowlist, which the model cannot edit."],
  ["Memory poisoned by a channel member","Nothing is written that a tool did not assert or a human did not confirm. Decay cannot fix a fact that was wrong the day it was written."],
  ["The model invents a number","The mechanical verifier set-differences every claim token against the evidence corpus and names what failed."],
  ["The model implies causation","It cannot be checked, so its FORM is constrained: a causal connective must share its sentence with a hedge."],
  ["The debate never ends","Five independent termination bounds, three of them constants. Rounds, tokens and wall-clock each terminate it alone."],
  ["The critic rubber-stamps","It never sees the planner's reasoning, only the proposal object — and it gets its own tool budget to check with."],
  ["Approval fatigue","Only genuinely consequential writes are non-auto, and a write escalates to debate BEFORE the human is asked."],
  ["An unbounded query kills the datasource","A bare high-cardinality matcher is rejected at dispatch; ranges are clamped by widening the step, never by truncating the window."],
  ["The specialist is down","A soft deadline, then answer without it and say so. The graph must not fail with a dependency it can survive."],
];

const CAP = [
  ["Engineers in workspace","100","Stated input."],
  ["In Claude-enabled channels","~40","4 channels; not everyone lives in them."],
  ["Mentions per active user per day","6","Assumption. The number most worth challenging."],
  ["Runs per day","~240","40 × 6. Ambient adds ~12."],
  ["Model calls per run","1 / 2–3 / 4–6","T0 / T1 / T2. Two of the five nodes on the common path run no model at all."],
  ["Share routed to T2 debate","~20%","Causal wording plus active incidents. Measure it in Phase 1 — this drives the token line below."],
  ["Peak hour share","18%","~43 runs/hr, so roughly 0.7/min."],
  ["p95 <i>service</i> time","33s T1 / 58s T2","Time to produce an answer once a worker starts. Both dropped ~5s when the librarian became code and the scribe moved after the post."],
  ["p95 <i>response</i> time","106s / 48s","What the user actually waits: 1 worker / 2 workers. M/D/c at 0.72/min."],
  ["Runs/min one worker absorbs<br>before p95 doubles","~0.8","ρ≈0.5. The row that makes every other row actionable."],
  ["Workers to deploy","2 (3 at Phase 3)","Two for load, a third so a rolling restart is not a degradation."],
  ["LLM tokens per day","~2.9M in / ~0.2M out","240 runs. Was ~3.4M: deleting the librarian's model call removed 18% of every run's spend for no loss, because nothing downstream read its output."],
  ["Ambient triage tokens/day","~1-2M","Scales with <i>messages</i> seen, not answers posted — plausibly the largest line here."],
  ["Debate token ceiling","12k / run","Enforced, not requested. A debate with no ceiling is an unbounded bill."],
  ["Vectors written per day","~480","2 memories per run. Under 200k in a year — Qdrant is not the constraint."],
  ["Postgres · graph checkpoints","~25 GB / year","A checkpointer serialises full state per node per run. The largest writer in the stack."],
];

const INTEG = [
  {h:"Alert channels", v:"read via platform events",
   l:["Alertmanager and synthetics post into #alerts-prod","Sentinel watches the stream; it is not in the request path","Correlates a firing alert with the deploy that preceded it"],
   r:"<b>Risk:</b> a noisy alert channel becomes a noisy agent. Ambient stays off here until the trigger rules earn it."},
  {h:"Grafana", v:"MCP · read-only",
   l:["list_metrics, query_datasource, error_budget","Ranges clamped to 6h; the step widens rather than the window truncating","A bare high-cardinality matcher is rejected outright"],
   r:"<b>Risk:</b> an unbounded matcher is a full-cardinality scan. Rejecting it forces list_metrics first."},
  {h:"Escalation", v:"MCP · PagerDuty",
   l:["get_oncall, list_incidents are auto","page_oncall is two_person — the only one in the catalogue","Answers name the human, so the reply is actionable"],
   r:"<b>Risk:</b> paging wakes someone at 3am. It is the one place a second approver is worth the friction."},
  {h:"Source control", v:"MCP · GitHub",
   l:["list_deploys, get_config, get_diff for correlation","create_pull_request is always_ask, base and head echoed verbatim","A base that does not exist is rejected before the human is asked"],
   r:"<b>Risk:</b> a revert PR on the wrong base is plausible and expensive."},
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
  ["blocker","<b>Scope isolation is the whole security model, and it is one predicate.</b> It needs a test that attempts every reachable path — direct query, semantic neighbour, injected instruction, and a tool that could exfiltrate — running in CI, not a manual check before launch."],
  ["high","<b>Debate is unfalsifiable without instrumentation.</b> Ship <code>debate_flip_rate</code>, <code>flip_regret</code> and <code>critic_ablation_delta</code> from day one. If ablating the critic changes nothing, the critic is theatre and a second pass was doing the work."],
  ["high","<b>The 6-mentions-per-day assumption drives every number here.</b> It is a guess. Phase 1 exists partly to replace it with a measurement."],
  ["high","<b>The verifier's biggest hole is a false negative, not a false positive.</b> Right tokens, wrong pairing — evidence says 41/s at 15:01, the draft says 41/s at 14:01 — passes. Fixing it needs span-level evidence binding, which is not 45 lines."],
  ["high","<b>Approval fatigue will defeat always_ask.</b> If every write prompts, people click approve without reading. Only genuinely consequential writes are non-auto, and the prompt must state exactly what changes."],
  ["watch","<b>A2A adds a dependency with its own availability.</b> The graph answers without the specialist rather than failing with it, and says plainly that it did."],
  ["watch","<b>Trace volume becomes its own cost.</b> Sample at org-wide scale; keep full traces for errors and for anything a human gave a thumbs-down."],
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

  $("cardJson").innerHTML = A2A_CARDS.map(c => pre(`AgentCard · ${c.name}`, j(c), "out")).join("");

  $("protoCards").innerHTML = PROTO.map(p => `
    <div class="pr-card"><h3>${p.h}</h3><p class="sub">${p.s}</p><p>${p.p}</p>
      <ul>${p.l.map(x => `<li>${x}</li>`).join("")}</ul></div>`).join("");

  const rows = (el, head, data, cls = "") => {
    $(el).innerHTML = `<div class="trow">${head.map(h => `<span>${h}</span>`).join("")}</div>` +
      data.map(r => `<div class="trow">${r.map((c, i) =>
        i === 0 ? `<b>${c}</b>` : i === 1 && cls === "num" ? `<span class="num">${c}</span>` : `<span>${c}</span>`).join("")}</div>`).join("");
  };
  rows("stackTable", ["Layer", "Choice", "Why"], STACK);
  rows("failTable", ["Failure", "What stops it"], FAILS);
  rows("capTable", ["Quantity", "Value", "Basis"], CAP, "num");

  $("debateSpec").innerHTML = `
    <div class="dbg">
      <div><h4>Turn order</h4><p>Planner proposes → Critic attacks → Planner revises. The Critic sees the
        <b>proposal object only</b>, never the Planner's reasoning, and holds its own budget of
        <b>${DEBATE.criticCalls} tool calls</b>. An objection it verified outranks one it argued.</p></div>
      <div><h4>Filtered in code</h4><ul>${DEBATE.filters.map(f => `<li><code>${esc(f.rule)}</code> — ${esc(f.why)}</li>`).join("")}</ul>
        <p class="dim">Discarded before the Planner sees them, so "cite your source" is a property of the system rather than a politeness the Critic can decline.</p></div>
      <div><h4>Termination — any one is sufficient</h4><ol>${DEBATE.exits.map(e => `<li><code>${esc(e)}</code></li>`).join("")}</ol>
        <p class="dim">Rounds is a monotonically increasing integer with a constant ceiling; tokens and wall-clock are monotonic non-decreasing with constant ceilings. Therefore the loop terminates.</p></div>
      <div><h4>Tie-break — never a default win</h4><ul>${Object.entries(DEBATE.tieBreak).map(([k, v]) => `<li><b>${esc(k)}</b> — ${esc(v)}</li>`).join("")}</ul></div>
    </div>`;

  $("integCards").innerHTML = INTEG.map(i => `
    <div class="in-card"><h3>${i.h}</h3><p class="via">${i.v}</p>
      <ul>${i.l.map(x => `<li>${x}</li>`).join("")}</ul>
      <p class="risk">${i.r}</p></div>`).join("");

  $("phaseCards").innerHTML = PHASES.map(p => `
    <div class="ph"><div class="k">${p.k}</div><b>${p.n}</b><p>${p.p}</p><p class="gate">${p.g}</p></div>`).join("");

  $("reviewTable").innerHTML = `<div class="trow"><span>Severity</span><span>Finding</span></div>` +
    REVIEW.map(([s, t]) => `<div class="trow"><span class="sev ${s}">${s}</span><span>${t}</span></div>`).join("");
}

/* ─────────────── boot ─────────────── */
function boot() {
  renderChannels();
  renderTiers(null);
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

  const tabs = [["tab-sim", "view-sim"], ["tab-arch", "view-arch"], ["tab-plan", "view-plan"]];
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
