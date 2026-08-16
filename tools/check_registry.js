#!/usr/bin/env node
/* The registry is now load-bearing: the simulator executes it and the
 * architecture tab documents it. This asserts the two cannot diverge.
 *
 * It exists because the previous version of this repo published TWO
 * contradictory rosters — a NODES array animating a planner/executor/reviewer
 * in the simulator, and an AGENTS array in the architecture tab explaining at
 * length why those three had been deleted. Nothing detected it, because they
 * were unrelated data that happened to share a file.
 *
 *   node tools/check_registry.js
 */
"use strict";
const path = require("path");
const d = f => path.join(__dirname, "..", "docs", f);

// Load order matters: these are plain globals, exactly as the page loads them.
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

console.log("\nregistry");
const ids = new Set(AGENTS.map(a => a.id));

ok(AGENTS.every(a => a.owns && a.fails && a.inputs && a.output),
   "every agent declares owns / inputs / output / fails");
ok(AGENTS.every(a => a.model === "none" || a.model === "external" ? true : a.system.length > 400),
   "every model-backed agent carries a real system prompt");
ok(AGENTS.filter(a => a.model === "none").every(a => a.predicate),
   "every model-less agent shows its predicate source instead");
ok(AGENTS.every(a => a.tools.every(t => TOOL[t])),
   "every tool in every allowlist exists in the catalogue",
   AGENTS.flatMap(a => a.tools.filter(t => !TOOL[t])).join(", "));
ok(TOOLS.every(t => t.callers.every(c => ids.has(c))),
   "every callers entry names a real agent",
   TOOLS.flatMap(t => t.callers.filter(c => !ids.has(c))).join(", "));
ok(TOOLS.every(t => t.params && t.kind && t.policy && t.callers && t.desc),
   "every tool declares params / kind / policy / callers / desc");

console.log("\ninvariants with teeth");
// The dangerous default. A write that cannot be undone must never be `auto`.
const badWrites = TOOLS.filter(t => t.kind === "write" && t.policy === "auto" && !t.reversible);
ok(badWrites.length === 0, "no irreversible write tool has policy:auto",
   badWrites.map(t => `${t.server}.${t.name}`).join(", "));

// Posting is a graph edge after the verifier, fenced by db.reserve_post().
// As a tool it would be a path around the verifier, and a gate that can be
// bypassed is not a gate.
ok(!TOOL["slack.post_message"], "slack.post_message is NOT a tool");

// The bidirectional check that catches roster drift in either direction.
const reached = new Set();
for (const f of FLOWS) {
  const spans = [];
  const rt = new Run({ ...f, thread: f.thread, scope: f.scope, channel: f.channel }, s => spans.push(s));
  try { f.run(rt); } catch (e) { console.log(`  FAIL  flow ${f.id} threw: ${e.message}`); fails++; n++; }
  for (const s of spans) reached.add(s.agent);
  f._spans = spans;
}
const unreachable = [...ids].filter(i => !reached.has(i));
ok(unreachable.length === 0, "every agent is reachable from at least one flow", unreachable.join(", "));
const ghosts = [...reached].filter(a => !ids.has(a));
ok(ghosts.length === 0, "no flow emits an agent that is not in the registry", ghosts.join(", "));

console.log("\nflows");
for (const f of FLOWS) ok(f._spans.length > 2, `${f.id} produced ${f._spans.length} spans`);
ok(FLOWS.every(f => f.proves && f.why && f.impl), "every flow states what it proves and how real it is");

console.log("\nthe fixtures must survive their own verifier");
// A hand-written answer that cannot pass the mechanical check is a lie about
// the system — the same failure as a test that passes against broken code,
// relocated into content. `reject` is exempt for draft 1, which exists to fail.
for (const f of FLOWS) {
  const checks = f._spans.filter(s => s.kind === "verify");
  const expectFail = f.id === "reject" ? 1 : 0;
  const failed = checks.filter(c => !c.ok);
  ok(failed.length === expectFail,
     `${f.id}: ${checks.length} verifier run(s), ${failed.length} rejected (expected ${expectFail})`,
     failed.map(c => c.head).join(" | "));
}

console.log("\nthe verifier actually rejects");
const rej = FLOW.reject._spans.filter(s => s.kind === "verify");
ok(rej[0] && !rej[0].ok, "the invented 205x ratio is caught");
ok(rej[0] && rej[0].unsupported.some(u => /205/.test(u.raw)), "and it is named in the rejection",
   JSON.stringify(rej[0] && rej[0].unsupported.map(u => u.raw)));
ok(rej[1] && rej[1].ok, "the rewrite passes");
// Falsification: the check must be capable of failing on a clean draft too.
const forged = verify("The rate hit 999 req/s at 03:33 and @nobody is oncall.", ["nothing relevant"]);
ok(!forged.pass && forged.unsupported.length >= 3, "a forged draft fails against an empty corpus");
// Regression: parseFloat("14:55") is 14, so a numeric near-match against an
// evidence value of 14:10 used to mark an invented timestamp as supported.
const clock = verify("The rate hit 41 req/s at 14:55.", ['{"points":[["14:10",41]],"unit":"req/s"}']);
ok(!clock.pass && clock.unsupported.some(u => u.raw === "14:55"),
   "an invented timestamp is not rescued by a numeric near-match",
   JSON.stringify(clock.unsupported.map(u => u.raw)));
const round = verify("The rate is 41 req/s.", ['{"points":[["14:10",41.2]],"unit":"req/s"}']);
ok(round.pass, "but correct rounding of a measurement still passes");
const hedgeless = verify("The deploy caused the outage.", ["the deploy caused the outage"]);
ok(!hedgeless.pass && hedgeless.unhedged.length === 1, "an unhedged causal claim is caught even when every token is grounded");

console.log("\nscope is a predicate, not a post-filter");
const scopeSpan = FLOW.scope._spans.find(s => s.kind === "vector");
ok(scopeSpan && scopeSpan.hits.length === 0, "0 in-scope hits for an engineering question asked in #sales-eu");
ok(scopeSpan && scopeSpan.excluded > 0, `${scopeSpan && scopeSpan.excluded} memories excluded BEFORE ranking`);
const engSpan = FLOW.fast._spans.find(s => s.kind === "vector");
ok(engSpan && engSpan.hits.length > 0, "the same store returns hits in the engineering scope");
const dump = FLOW.scope._spans.find(s => s.kind === "tool" && s.label === "memory.dump");
ok(dump && !dump.ok && dump.stage === "allowlist", "memory.dump is refused at the allowlist stage");

console.log("\ntools enforce their own contracts");
const cx = { agent: "executor", scope: "eng-claude", thread: [], approved: new Set() };
ok(callTool("grafana.query_datasource", { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "13:00", to: "14:00" }, cx).ok,
   "a well-formed query succeeds");
ok(callTool("grafana.query_datasource", { expr: "x", from: "13:00", to: "14:00", step: 5 }, cx).stage === "schema",
   "step below the minimum is a schema failure");
ok(callTool("grafana.query_datasource", { expr: 'rate(http_5xx{service="checkout-api"}[5m])', from: "01:00", to: "14:00" }, cx).error.includes("clamp"),
   "a 13h window is rejected by the clamp");
ok(callTool("grafana.query_datasource", { expr: '{__name__=~".+"}', from: "13:00", to: "14:00" }, cx).error.includes("full-cardinality"),
   "a bare high-cardinality matcher is rejected outright");
ok(callTool("github.create_pull_request", { repo: "acme/checkout-api", base: "nope", head: "revert-2.3.1", title: "x" },
            { ...cx, approved: new Set(["github.create_pull_request"]) }).error.includes("base"),
   "a PR on a base that does not exist is rejected");
ok(callTool("pagerduty.page_oncall", { team: "payments", message: "x", urgency: "high" }, cx).needsApproval === "two_person",
   "paging requires two people");
ok(callTool("grafana.query_datasource", { expr: "x", from: "13:00", to: "14:00" }, { ...cx, agent: "writer" }).stage === "allowlist",
   "the writer cannot reach a tool at all");

console.log("\nthe debate terminates");
for (const id of ["debate", "nocon", "gate"]) {
  const gates = FLOW[id]._spans.filter(s => s.kind === "gate" && s.label === "debate control");
  ok(gates.length <= DEBATE.maxRounds && gates.some(g => /terminates/.test(g.head)),
     `${id}: ${gates.length} round(s), terminated by ${gates.filter(g => /terminates/.test(g.head)).map(g => g.head.replace("terminates — ", ""))}`);
}
const dropped = FLOW.nocon._spans.filter(s => s.kind === "gate" && s.dropped?.length);
ok(dropped.length > 0, "an uncited 'contradicted' objection was discarded before the planner saw it");
ok(FLOW.nocon._spans.some(s => s.label === "tie-break"), "non-convergence routes to a tie-break, not to a planner win");

console.log("\nA2A earns its card");
const a2a = FLOW.a2a._spans.filter(s => s.kind === "a2a");
ok(a2a.some(s => s.state === "input-required"), "the specialist asks US something — an MCP call has no state to return to");
ok(a2a.some(s => /restart/i.test(s.head || "")), "the task outlives the worker");
ok(A2A_CARDS.every(c => c.skills.length && c.url && c.securitySchemes), "the card carries skills, endpoint and auth");

console.log("\ntiers");
ok(FLOW.direct._spans[0].head.startsWith("T0"), "a short factual question routes T0");
ok(FLOW.fast._spans[0].head.startsWith("T2"), "an active incident routes T2 by channel state");
ok(tierFor({ question: "why did checkout break", toolHints: [], incidentActive: false }).tier === "T2",
   "a causal question routes T2 on wording alone");
ok(tierFor({ question: "what version is checkout on", toolHints: [], incidentActive: false }).tier === "T0",
   "the same-length factual question does not");

console.log(`\n${n - fails}/${n} checks passed`);
if (fails) { console.log(`${fails} FAILED\n`); process.exit(1); }
console.log("registry, flows and fixtures are consistent\n");
