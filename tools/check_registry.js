#!/usr/bin/env node
/* The registry is load-bearing: the simulator executes it and the design page
 * documents it. This asserts the two cannot diverge.
 *
 * It exists because this repo once published TWO contradictory rosters — a
 * NODES array animating a planner/executor/reviewer in the simulator, and an
 * AGENTS array explaining at length why those three had been deleted. Nothing
 * detected it, because they were unrelated data that happened to share a file.
 *
 * Every check here was verified to FAIL against a deliberate mutation before
 * being written. A check that cannot fail is worse than no check.
 *
 *   node tools/check_registry.js
 */
"use strict";
const path = require("path");
const d = f => path.join(__dirname, "..", "docs", f);

// Load order matters: plain globals, exactly as the page loads them.
Object.assign(global, require(d("tools.js")));
Object.assign(global, require(d("agents.js")));
Object.assign(global, require(d("runtime.js")));
Object.assign(global, require(d("flows.js")));

let fails = 0, n = 0;
const ok = (cond, label, detail = "") => {
  n++;
  if (cond) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); fails++; }
};

/* ═══════ registry ═══════ */
console.log("\nregistry");
const ids = new Set(AGENTS.map(a => a.id));
ok(AGENTS.every(a => a.owns && a.fails && a.inputs && a.output), "every agent declares owns / inputs / output / fails");
ok(AGENTS.every(a => (a.model === "none" || a.model === "external") ? true : a.system.length > 400),
   "every model-backed agent carries a real system prompt");
ok(AGENTS.filter(a => a.model === "none").every(a => a.predicate),
   "every model-less agent shows its predicate source instead");
ok(AGENTS.every(a => a.tools.every(t => TOOL[t])), "every tool in every allowlist exists",
   AGENTS.flatMap(a => a.tools.filter(t => !TOOL[t])).join(", "));
ok(TOOLS.every(t => t.callers.every(c => ids.has(c))), "every callers entry names a real agent",
   TOOLS.flatMap(t => t.callers.filter(c => !ids.has(c))).join(", "));
ok(TOOLS.every(t => t.params && t.kind && t.policy && t.callers && t.desc),
   "every tool declares params / kind / policy / callers / desc");
ok(TIERS.length === 2, `two tiers, not three (${TIERS.map(t => t.id).join(" ")})`);

/* ═══════ invariants with teeth ═══════ */
console.log("\ninvariants with teeth");
const badWrites = TOOLS.filter(t => t.kind === "write" && t.policy === "auto" && !t.reversible);
ok(badWrites.length === 0, "no irreversible write tool has policy:auto",
   badWrites.map(t => `${t.server}.${t.name}`).join(", "));
// Posting runs after the verifier, fenced by db.reserve_post(). As a tool it
// would be a path around the verifier, and a gate that can be bypassed is not one.
ok(!TOOL["slack.post_message"], "slack.post_message is NOT a tool");
ok(AGENT.librarian.model === "none" && AGENT.librarian.predicate.length > 400,
   "the librarian is code, and the registry shows its source");

/* ═══════ run every flow ═══════ */
const reached = new Set(), usedTools = new Set();
for (const f of FLOWS) {
  const spans = [];
  const rt = new Run(f, s => spans.push(s));
  try { f.run(rt); } catch (e) { console.log(`  FAIL  flow ${f.id} threw: ${e.message}`); fails++; n++; }
  for (const s of spans) {
    reached.add(s.agent);
    if (s.kind === "tool" || s.kind === "vector") usedTools.add(String(s.label).replace(/ · as .*/, ""));
  }
  f._spans = spans; f._rt = rt;
}

console.log("\nthe five use cases");
const WANT = ["investigate", "writeup", "fixrepo", "wakeup", "remember"];
ok(WANT.every(id => FLOW[id]), "all five flows exist", WANT.filter(id => !FLOW[id]).join(", "));
for (const f of FLOWS) ok(f._spans.length > 5, `${f.id}: ${f._spans.length} spans · ${f._rt.calls} tools · ${f._spans.filter(s => s.kind === "db").length} db`);
ok(FLOWS.every(f => f.proves && f.why && f.impl), "every flow states what it proves and how real it is");

console.log("\nnothing in the registry is unreachable or invented");
const unreachable = [...ids].filter(i => !reached.has(i));
ok(unreachable.every(i => AGENT[i].noFlow),
   "every unreachable agent explains why no flow exercises it",
   unreachable.filter(i => !AGENT[i].noFlow).join(", "));
ok(unreachable.every(i => AGENT[i].stage === "later"),
   `no core agent is unreachable (unreachable: ${unreachable.join(", ") || "none"})`);
// `queue` is the runs table, not an agent — db spans are emitted by the
// runtime itself and have no registry entry by design.
const ghosts = [...reached].filter(a => !ids.has(a) && a !== "queue");
ok(ghosts.length === 0, "no flow emits an agent that is not in the registry", ghosts.join(", "));
const cold = TOOLS.map(t => `${t.server}.${t.name}`).filter(x => !usedTools.has(x));
ok(cold.length === 0, "every catalogued tool is exercised by some flow", cold.join(", "));

console.log("\nthe five use cases each show what they claim to");
{
  const inv = FLOW.investigate._spans;
  const q = inv.find(s => s.label === "grafana.query_datasource");
  const dep = inv.find(s => s.label === "github.list_deploys");
  ok(q && dep && inv.indexOf(q) < inv.indexOf(dep) && /14:01:40/.test(dep.because),
     "investigate: the deploy query's window comes from where the metric stepped");
  ok(inv.some(s => s.label === "pagerduty.page_oncall" && s.needsApproval === "two_person"),
     "investigate: paging is refused as two_person");

  const w = FLOW.writeup._spans;
  const refused = w.filter(s => s.kind === "tool" && s.needsApproval === "always_ask");
  ok(refused.length >= 1 && w.some(s => s.approval), "writeup: the write is refused, then approved");
  ok(w.some(s => s.label === "calendar.find_slot" && s.ok), "writeup: the slot is derived from free/busy");
  ok(w.some(s => s.label === "email.send_summary" && s.ok), "writeup: the mail goes out only after the gate");

  const fx = FLOW.fixrepo._spans;
  ok(fx.some(s => s.label === "github.create_branch" && s.ok), "fixrepo: a reversible write runs without asking");
  ok(fx.some(s => s.label === "github.commit_file" && s.needsApproval === "always_ask"),
     "fixrepo: the commit is not reversible, so it asks");
  ok(fx.some(s => s.label === "debate control"), "fixrepo: the write escalated to debate BEFORE the human");
  ok(fx.some(s => s.label === "github.create_pull_request" && s.ok), "fixrepo: the PR opens on a validated base");

  const wk = FLOW.wakeup._spans;
  ok(wk.some(s => s.label === "scheduler.schedule_wakeup" && s.ok), "wakeup: a durable timer is written");
  ok(wk.filter(s => s.kind === "db").length >= 5, "wakeup: the run parks and is re-claimed as rows");
  ok(wk.some(s => s.kind === "a2a" && s.state === "input-required"),
     "wakeup: the specialist asks US something — an MCP call has no state to return to");
  ok(wk.filter(s => s.kind === "verify").length === 2, "wakeup: it answers twice, an hour apart");

  const rm = FLOW.remember._spans;
  const writes = rm.filter(s => s.kind === "memwrite");
  ok(writes.length >= 2, "remember: memories are written");
  ok(writes.every(s => s.rows.every(r => r.provenance)), "remember: every row carries provenance");
  ok(writes.every(s => s.badProv.length === 0),
     "remember: every provenance resolves to a tool that ran or a human who spoke",
     writes.flatMap(s => s.badProv).map(b => b.cite).join(", "));
  ok(writes.some(s => s.clashes.length > 0), "remember: a contradiction on the same subject is flagged, not merged");
  const mine = rm.find(s => s.kind === "vector" && !/as /.test(s.label) && s.hits.length);
  const theirs = rm.find(s => /as sales-claude/.test(s.label));
  ok(mine && theirs && theirs.hits.length === 0,
     `remember: the identical query returns ${mine ? mine.hits.length : "?"} here and ${theirs ? theirs.hits.length : "?"} from the other channel's binding`);
  ok(theirs && theirs.excluded > 0, "remember: the excluded rows are absent from the result set, not filtered from it");
}

console.log("\nthe fixtures must survive their own verifier");
for (const f of FLOWS) {
  const checks = f._spans.filter(s => s.kind === "verify");
  const failed = checks.filter(c => !c.ok);
  ok(failed.length === 0, `${f.id}: ${checks.length} verifier run(s), all pass`,
     failed.map(c => c.head).join(" | "));
}

console.log("\njudgement on a model, rules and facts in code");
{
  // find_slot returns options and local times; it does not choose. "First
  // available" is a judgement, and the old version made it silently — and
  // wrongly, proposing 17:00 to someone for whom that is 21:30.
  const cx2 = { agent: "executor", scope: "eng-claude", channel: "incidents", thread: [], approved: new Set() };
  const fs = callTool("calendar.find_slot", { attendees: ["alice", "bob", "priya"], minutes: 30, after: "15:00", limit: 4 }, cx2);
  ok(Array.isArray(fs.data.candidates) && fs.data.candidates.length > 1,
     `find_slot returns ${fs.data.candidates.length} candidates rather than choosing one`);
  ok(fs.data.candidates.every(c => c.local && Object.keys(c.local).length === 3),
     "and every candidate carries each attendee's local time");
  ok(fs.data.candidates[0].outside_working_hours.includes("priya"),
     "21:30 for Asia/Kolkata is surfaced as outside working hours");
  const gate = FLOW.writeup._spans.find(s => s.approval);
  ok(/21:30/.test(gate.detail) && /outside working hours/.test(gate.detail),
     "the human sees the local times before approving the booking");

  // Provenance is a fact about where a claim came from, so it is verified.
  const probe = new Run(FLOW.remember, () => {});
  probe.route({ classify: '{"tier":"T1","signals":[],"servers":[],"needs_memory":false,"memory_query":"","content_flags":[],"reply_style":"answer","reason":"p"}' });
  let bad = null;
  const p2 = new Run(FLOW.remember, s => { if (s.kind === "memwrite") bad = s; });
  p2.route({ classify: '{"tier":"T1","signals":[],"servers":[],"needs_memory":false,"memory_query":"","content_flags":[],"reply_style":"answer","reason":"p"}' });
  p2.memWrite([{ subject: "x", predicate: "y", kind: "resolution", text: "t",
                 provenance: "tool:grafana.query_datasource", confirmed_by: null }], {});
  ok(bad && bad.badProv.length === 1 && /was not called/.test(bad.badProv[0].why),
     "a provenance naming a tool that never ran is caught");
}

console.log("\nthe verifier rejects, and can be shown to");
const forged = verify("The rate hit 999 req/s at 03:33 and @nobody is oncall.", ["nothing relevant"]);
ok(!forged.pass && forged.unsupported.length >= 3, "a forged draft fails against an empty corpus");
const clock = verify("The rate hit 41 req/s at 14:55.", ['{"points":[["14:10",41]],"unit":"req/s"}']);
ok(!clock.pass && clock.unsupported.some(u => u.raw === "14:55"),
   "an invented timestamp is not rescued by a numeric near-match");
ok(verify("The rate is 41 req/s.", ['{"points":[["14:10",41.2]],"unit":"req/s"}']).pass,
   "but correct rounding of a measurement still passes");
ok(!verify("p99 is 1450 s.", ['{"unit":"ms"}', "1450ms"]).pass, "evidence of 1450ms does not support 1450 s");
ok(!verify("hit ratio is 94x.", ["94%"]).pass, "94% does not support 94x");
ok(!verify("base is `main`.", ["the domain was unrelated"]).pass,
   "a backticked identifier does not match inside a longer word");
for (const p of ["The root cause is the retry config.", "The deploy is responsible for the outage.", "The deploy triggered the outage."])
  ok(!verify(p, [p.toLowerCase()]).pass, `unhedged: "${p.slice(0, 32)}…"`);

console.log("\nthe debate terminates and cannot be gamed");
{
  const probe = () => new Run(FLOWS[0], () => {});
  const P = c => `{"claim":"c","alternatives_considered":[{"h":1},{"h":2}]${c}}`;
  // Six rounds supplied, three allowed.
  const many = Array.from({ length: 6 }, () => ({ proposal: P(""),
    attack: '{"objections":[{"id":"o","target":"claim","kind":"unsupported","severity":"high","cites":"ev_1"}],"verdict":"revise"}' }));
  const out = probe().debate("q", { memories: [], entities: [] }, many);
  ok(out.rounds.length <= DEBATE.maxRounds, `six rounds supplied, ${out.rounds.length} run (ceiling ${DEBATE.maxRounds})`);
  ok(out.verdict === "no-convergence" && out.branch, "non-convergence routes to a tie-break, not a planner win");
  // An uncited objection never reaches the planner.
  const spans = [];
  const rt2 = new Run(FLOWS[0], s => spans.push(s));
  rt2.debate("q", { memories: [], entities: [] }, [{ proposal: P(""),
    attack: '{"objections":[{"id":"o","target":"claim","kind":"unsupported","severity":"high","cites":null}],"verdict":"revise"}' }]);
  const gate = spans.find(s => s.label === "debate control");
  ok(gate && gate.dropped.length === 1, "an uncited objection is discarded before the planner sees it");
  // An empty alternatives list is objected to by the runtime, not by a model.
  const spans3 = [];
  new Run(FLOWS[0], s => spans3.push(s)).debate("q", { memories: [], entities: [] },
    [{ proposal: '{"claim":"c","alternatives_considered":[]}', attack: '{"objections":[],"verdict":"accept"}' }]);
  const g3 = spans3.find(s => s.label === "debate control");
  ok(g3 && [...g3.kept, ...g3.dropped].some(o => o.kind === "alternative_unexamined"),
     "a proposal that examined no alternatives is objected to mechanically");
}

console.log("\nthe critic never sees the planner's reasoning");
{
  const fx = FLOW.fixrepo._spans.filter(s => s.agent === "critic" && s.kind === "model");
  ok(!AGENT.critic.userTemplate.includes("{critique}"), "the critic's template has no slot for it");
  ok(fx.every(s => !s.user.includes("SURVIVING OBJECTIONS")), "and no critic turn carries it in practice");
}

console.log("\na draft cannot be its own evidence");
{
  const rt = FLOW.investigate._rt;
  const outputs = FLOW.investigate._spans.filter(s => s.kind === "model").map(s => s.output);
  ok(outputs.every(o => !rt.evidence.includes(o)), "no model output is in the evidence corpus");
  ok(!rt.evidence.some(e => String(e).includes("YOUR ROLE")), "and no system prompt is either");
}

console.log("\ntools enforce their own contracts");
const cx = { agent: "executor", scope: "eng-claude", channel: "incidents", thread: [], approved: new Set() };
const E = (name, args, ctx = cx) => callTool(name, args, ctx);
ok(E("grafana.query_datasource", { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "13:00", to: "14:00" }).ok,
   "a well-formed query succeeds");
ok(E("grafana.query_datasource", { expr: "x", from: "13:00", to: "14:00", step: 5 }).stage === "schema",
   "step below the minimum is a schema failure");
ok(E("grafana.query_datasource", { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "01:00", to: "14:00" }).error.includes("clamp"),
   "a 13h window is rejected by the clamp");
ok(E("grafana.query_datasource", { expr: '{__name__=~".+"}', from: "13:00", to: "14:00" }).error.includes("full-cardinality"),
   "a bare high-cardinality matcher is rejected outright");
ok(E("github.create_pull_request", { repo: "acme/checkout-api", base: "nope", head: "revert-2.3.1", title: "x" },
     { ...cx, approved: new Set(["github.create_pull_request"]) }).error.includes("base"),
   "a PR on a base that does not exist is rejected");
ok(E("github.commit_file", { repo: "acme/checkout-api", branch: "no-such", path: "config/retry.yaml", content: "x", message: "m" },
     { ...cx, approved: new Set(["github.commit_file"]) }).error.includes("branch"),
   "a commit to a branch that does not exist is rejected");
ok(E("email.send_summary", { to: ["nobody@elsewhere.test"], subject: "s", body: "b" },
     { ...cx, approved: new Set(["email.send_summary"]) }).error.includes("directory"),
   "mail to an address outside the directory is rejected before it is sent");
ok(E("calendar.find_slot", { attendees: ["alice", "ghost"], minutes: 30 }).error.includes("unknown"),
   "a meeting with someone who does not exist is rejected");
ok(E("pagerduty.page_oncall", { team: "payments", message: "x", urgency: "high" }).needsApproval === "two_person",
   "paging requires two people");
ok(E("grafana.query_datasource", { expr: "x", from: "13:00", to: "14:00" }, { ...cx, agent: "writer" }).stage === "allowlist",
   "the writer cannot reach a tool at all");

console.log(`\n${n - fails}/${n} checks passed`);
if (fails) { console.log(`${fails} FAILED\n`); process.exit(1); }
console.log("registry, flows and fixtures are consistent\n");
