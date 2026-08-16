/* claude-tag-poc — the run engine.
 *
 * WHAT IS COMPUTED HERE (not scripted):
 *   · prompt assembly — the strings shown are the strings built, char for char
 *   · token accounting — measured from those strings, not typed in
 *   · retrieval ranking — a real TF-IDF cosine over the in-scope corpus
 *   · the scope predicate — one filter, applied before ranking
 *   · every tool call — schema-validated, clamped, computed from WORLD
 *   · the verifier — a real set-difference over tokens in the draft
 *   · budget and round ceilings — enforced, not narrated
 *
 * WHAT IS A FIXTURE (it has to be — a static page holds no API key):
 *   · what a model would emit. Each flow supplies the model's output text.
 *     Everything downstream of that output is then computed from it.
 *
 * The distinction is surfaced in the UI on every span, so a reader can audit
 * this claim instead of taking it.
 */
"use strict";

/* ═══════════════ token + embedding instrumentation ═══════════════ */

// Same rule of thumb the worker uses when it sizes a transcript: ~4 chars/token.
const tok = s => Math.ceil((s || "").length / 4);

// Illustrative vector preview. Deterministic so the same query always shows the
// same numbers — a preview that changed every run would be obvious noise.
function vecPreview(text, n = 8) {
  let h = 2166136261;
  const out = [];
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  for (let i = 0; i < n; i++) { h = Math.imul(h ^ (h >>> 15), 2246822507); out.push(((h >>> 8) / 8388608 - 1).toFixed(4)); }
  return out;
}

const words = s => (s || "").toLowerCase().match(/[a-z][a-z0-9_.]{2,}/g) || [];

/* A real ranking, so the scores in the UI are derived rather than decorative.
   TF-IDF cosine over the in-scope corpus — small, explainable, and it genuinely
   reorders when the query changes. */
function rank(query, docs) {
  const N = docs.length || 1;
  const df = {};
  const bags = docs.map(d => {
    const b = {};
    for (const w of new Set(words(d.text + " " + d.subject))) { b[w] = 1; df[w] = (df[w] || 0) + 1; }
    return b;
  });
  const idf = w => Math.log(1 + N / (1 + (df[w] || 0)));
  const q = {};
  for (const w of words(query)) q[w] = (q[w] || 0) + 1;
  const qn = Math.hypot(...Object.entries(q).map(([w, c]) => c * idf(w))) || 1;
  return docs.map((d, i) => {
    const b = bags[i];
    const dot = Object.entries(q).reduce((s, [w, c]) => s + (b[w] ? c * idf(w) * idf(w) : 0), 0);
    const dn = Math.hypot(...Object.keys(b).map(idf)) || 1;
    return { doc: d, score: +(dot / (qn * dn)).toFixed(3), matched: Object.keys(q).filter(w => b[w]) };
  }).sort((a, b) => b.score - a.score);
}

/* ═══════════════ the verifier — real, ~30 lines ═══════════════ */

const CLASSES = [
  ["time",    /\b\d{1,2}:\d{2}(?::\d{2})?\b/g],                        // 14:01:40
  ["version", /\bv?\d+\.\d+\.\d+\b/g],                                 // v2.3.1
  ["num",     /\b\d+(?:\.\d+)?\s?(?:%|x|×|ms|s|m|h|GB|MB|\/s|rps|k)\b|\b\d{2,}(?:\.\d+)?\b|\b\d+\.\d+\b/g],
  // An identifier is a backticked span, or a word containing a dot or an
  // underscore. Hyphen-only words are NOT checked: "week-over-week" and
  // "tier-1" are prose, and treating them as identifiers made the verifier
  // reject correct English. Documented false negative: a bare hyphenated
  // service name in prose is unchecked — which is why the Writer's prompt
  // requires identifiers to be in `code`.
  ["ident",   /`[^`]+`|\b[a-z][a-z0-9-]*[._][a-z0-9._-]+\b/gi],
  ["handle",  /@[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*/gi],
];

// A bare integer under 10 with no unit is deliberately UNCHECKED — "two
// services", "three attempts" would otherwise fail every draft. Documented
// false negative: an invented small count survives.
const norm = s => String(s).toLowerCase().trim()
  .replace(/^`|`$/g, "").replace(/^v(?=\d)/, "").replace(/,/g, "").replace(/\s+/g, "");

function tokensOf(s) {
  const out = [];
  for (const [cls, re] of CLASSES)
    for (const m of String(s).match(re) || []) out.push({ cls, raw: m, key: norm(m), quoted: m.startsWith("`") });
  const seen = new Set();
  return out.filter(t => t.key.length > 1 && !seen.has(t.key) && seen.add(t.key));
}
const claimTokens = s => tokensOf(s).map(t => t.key);

// The one mechanically-checkable property of an unverifiable claim. You cannot
// verify causation, so you constrain its FORM instead.
const CAUSAL_C = /\b(caused|because|due to|led to|result(?:ed)? (?:in|from))\b/i;
const HEDGE_C  = /\b(likely|consistent with|lines? up|suggests?|appears?|correlat|probabl|points? to)\b/i;

function verify(draft, evidence) {
  // Corpus = tool results + transcript + retrieved memories. It deliberately
  // EXCLUDES the model's own prior turns and the system prompts: a draft cannot
  // be its own evidence, and that one exclusion is what separates a verifier
  // from a rubber stamp.
  const hay = new Map();
  for (const e of evidence) for (const t of tokensOf(e)) if (!hay.has(t.key)) hay.set(t.key, String(e).slice(0, 140));
  const keys = [...hay.keys()];
  // A code span is supported if its content appears literally in the evidence.
  // Without this, `rate(http_5xx{...}[5m])` fails because the tokeniser splits
  // the JSON form of the same string differently from the backticked form.
  const flat = evidence.map(e => String(e).toLowerCase().replace(/\\"/g, '"')).join("\n");
  const bare = x => x.replace(/(%|x|×|ms|s|m|h|gb|mb|\/s|rps|k)$/, "");
  // 1-significant-figure near-match: evidence 41.2 supports a draft that says 41.
  // Without it, correct rounding is rejected and the writer learns to route
  // around the verifier, which is worse than not having one.
  // The near-match applies to MEASUREMENTS ONLY. It must never touch a
  // timestamp or a version: parseFloat("14:55") is 14, so without this
  // restriction an evidence value of 14:10 "supported" a draft that said
  // 14:55 — inventing a time, which is the single thing this verifier is
  // least allowed to miss. Found by typing a forged draft into the sandbox.
  const find = (x, cls) => keys.find(h => h === x || bare(h) === bare(x)
    || (cls === "num" && !isNaN(parseFloat(h)) && !isNaN(parseFloat(x))
        && Math.abs(parseFloat(h) - parseFloat(x)) <= Math.abs(parseFloat(h)) * 0.02
        && (bare(h) !== h) === (bare(x) !== x)));

  const rows = tokensOf(draft).map(t => {
    const h = find(t.key, t.cls);
    if (h) return { ...t, found: true, src: hay.get(h) };
    const lit = t.cls === "ident" && (t.quoted || t.key.length > 4) && flat.includes(t.key);
    return { ...t, found: lit, src: lit ? "(literal match in evidence)" : null };
  });
  const unsupported = rows.filter(r => !r.found);
  const unhedged = String(draft).split(/(?<=[.!?])\s+|\n/)
    .filter(s => CAUSAL_C.test(s) && !HEDGE_C.test(s)).map(s => s.trim());

  return { pass: !unsupported.length && !unhedged.length, rows, unsupported, unhedged,
           checked: rows.length, corpus: hay.size };
}

/* The registry says the verifier is code rather than a model. Back-fill the
   actual source so the UI shows the algorithm instead of a claim about it. */
if (typeof AGENT !== "undefined") AGENT.verifier.predicate = verify.toString();

/* One line that says what actually came back. A span headed "called a tool"
   is the abstraction this whole page exists to replace. */
function gist(out) {
  try {
    const o = JSON.parse(out);
    const v = o.summary || o.claim || o.verdict || o.act || o.tier ||
      (Array.isArray(o) ? `${o.length} item(s)` : null) ||
      (o.objections ? `${o.objections.length} objection(s) · ${o.verdict}` : null) ||
      (o.findings ? `${o.findings.length} findings, ${(o.unresolved || []).length} unresolved` : null);
    return v ? String(v).slice(0, 90) : null;
  } catch { return String(out).replace(/\s+/g, " ").slice(0, 90); }
}

function summarise(name, d) {
  if (!d) return "ok";
  if (d.points) return `${d.points.length} points · ${d.min}–${d.max} ${d.unit}` +
    (d.step_change ? ` · steps to ${d.step_change.to} at ${d.step_change.at}` : " · no step in window");
  if (d.metrics) return `${d.metrics.length} metric expressions`;
  if (d.deploys) return d.deploys.length ? `${d.deploys.length} deploy(s) · newest ${d.deploys[0].version} at ${d.deploys[0].at}` : "no deploys in window";
  if (d.config) return Object.entries(d.config).map(([k, v]) => `${k}=${v}`).join(" · ");
  if (d.handle) return `${d.handle} until ${d.until}`;
  if (d.incidents) return `${d.incidents.length} incident(s)`;
  if (d.number) return `PR #${d.number} · ${d.head} → ${d.base}`;
  if (d.files) return `${d.files.length} file(s) changed`;
  if (d.reacted) return `reacted :${d.reacted}:`;
  if (d.messages) return `${d.messages.length} messages`;
  return Object.keys(d).slice(0, 3).join(", ");
}

/* ═══════════════ the run context ═══════════════ */

class Run {
  constructor(sc, emit) {
    this.sc = sc;
    this.emit = emit;                       // (span) => void
    this.scope = sc.scope;
    this.channel = sc.channel;
    this.thread = sc.thread;
    this.results = [];                      // tool result records — the evidence corpus
    // Attribution IS evidence: who spoke is exactly what the writer is allowed
    // to cite, so the author handle belongs in the corpus alongside the body.
    // So does the channel — naming the room you are in is not a claim.
    this.evidence = [`#${sc.channel} scope=${sc.scope}`, ...sc.thread.map(m => `<@${m.user}> [${m.at}]: ${m.text}`)];
    this.approved = new Set(sc.approved || []);
    this.tokIn = 0; this.tokOut = 0; this.ms = 0;
    this.calls = 0;
  }

  /* Assemble the exact strings a model would receive, count them, and emit
     them for display. This is the span type the whole page exists for. */
  think(agentId, slots, output, opts = {}) {
    const a = AGENT[agentId];
    const user = a.userTemplate.replace(/\{(\w+)\}/g, (_, k) => (slots[k] ?? `«${k}»`));
    const tin = tok(a.system) + tok(user), tout = tok(output);
    this.tokIn += tin; this.tokOut += tout;
    const ms = opts.ms ?? Math.round(180 + tin * 0.09 + tout * 1.4);
    this.ms += ms;
    this.emit({
      kind: "model", agent: a.id, label: a.name, model: a.model, ms,
      head: opts.head || gist(output) || a.owns,
      tokIn: tin, tokOut: tout, budget: a.budget,
      over: tin + tout > a.budget,
      system: a.system, user, output,
      because: opts.because,
      fixture: "the model's output text",
    });
    return output;
  }

  /* A real dispatch: allowlist → schema → clamps → policy → handler. */
  tool(agent, name, args, opts = {}) {
    const rec = callTool(name, args, { agent, scope: this.scope, thread: this.thread, approved: this.approved });
    this.calls++;
    const ms = opts.ms ?? (rec.ok ? 90 + Math.round(JSON.stringify(rec.data || {}).length * 0.12) : 20);
    this.ms += ms;
    if (rec.ok) { this.results.push(rec); this.evidence.push(JSON.stringify(rec.data)); }
    const head = rec.ok ? summarise(name, rec.data) : `${rec.stage} — ${rec.error}`;
    this.emit({
      kind: "tool", agent, label: name, ms, head,
      ok: rec.ok, stage: rec.stage, error: rec.error, needsApproval: rec.needsApproval,
      args, result: rec.data, spec: rec.spec,
      because: opts.because, then: opts.then,
      fixture: null,
    });
    return rec;
  }

  /* Retrieval, shown end to end: the query text, the model, the predicate that
     was applied, what it excluded, and the ranked hits with real scores. */
  recall(query, opts = {}) {
    const all = WORLD.memories;
    const inScope = all.filter(m => m.scope_id === this.scope);
    const ranked = rank(query, inScope).filter(r => r.score > 0).slice(0, opts.k || 4);
    const ms = 40 + inScope.length * 3;
    this.ms += ms;
    for (const r of ranked) this.evidence.push(r.doc.text);
    this.emit({
      kind: "vector", agent: "librarian", label: "memory.mem_search", ms,
      query, model: "text-embedding-3-small", dims: 1536, preview: vecPreview(query),
      head: `${ranked.length} hit${ranked.length === 1 ? "" : "s"} of ${inScope.length} in scope` +
            (ranked.length ? ` · top ${ranked[0].score}` : " · nothing matched"),
      predicate: `scope_id = "${this.scope}"`,
      corpus: all.length, inScope: inScope.length, excluded: all.length - inScope.length,
      hits: ranked.map(r => ({ id: r.doc.id, score: r.score, matched: r.matched, kind: r.doc.kind,
                               age: r.doc.age_days, prov: r.doc.provenance, text: r.doc.text })),
      because: opts.because,
      partial: "the 1536-d vector preview is illustrative — the ranking, scores and scope filter below are computed",
    });
    return ranked.map(r => r.doc);
  }

  /* The tier decision — pure code, and the operands are shown alongside the
     rule so a reader can see WHY this run took this path. */
  tier(ctx) {
    const d = tierFor({ ...ctx, question: this.sc.question });
    const spec = TIERS.find(x => x.id === d.tier);
    this.emit({
      kind: "route", agent: "orchestrator", label: "tier predicate", ms: 1,
      head: `${d.tier} · ${spec.name}`, rule: d.rule, note: d.note,
      operands: { question: this.sc.question, incidentActive: !!ctx.incidentActive,
                  toolHints: ctx.toolHints || [], retryReason: ctx.retryReason || null,
                  "CAUSAL.test(question)": CAUSAL.test(this.sc.question) },
      path: spec.nodes, source: AGENT.orchestrator.predicate,
      fixture: null,
    });
    this.tierId = d.tier;
    return d;
  }

  /* The debate. Termination is enforced here, not requested in a prompt, and
     objections are filtered mechanically before the planner ever sees them. */
  debate(question, ctx, rounds) {
    const out = { rounds: [], verdict: null, spent: 0, t0: this.ms };
    let carried = "(round 1 — no objections yet)";

    // The ceiling is whichever comes first: the protocol's round limit, or the
    // rounds this flow supplies. Both are constants, which is what makes the
    // loop provably finite.
    const last = Math.min(DEBATE.maxRounds, rounds.length);
    for (let i = 0; i < last; i++) {
      const r = rounds[i];

      const prop = this.think("planner", {
        question, n: this.thread.length,
        transcript: fmtThread(this.thread), memories: fmtMem(ctx.memories),
        entities: ctx.entities.join(", "), evidence_ids: this.results.map((_, k) => `ev_${k + 1}`).join(", ") || "(none)",
        critique: carried,
      }, r.proposal, { head: `round ${i + 1} · proposes`, because: r.why });

      // A mechanical objection, raised by the runtime rather than by a model:
      // an empty alternatives list is a proposal that examined nothing.
      const mech = [];
      try {
        const p = JSON.parse(prop);
        if (!(p.alternatives_considered || []).length)
          mech.push({ id: "auto", kind: "alternative_unexamined", severity: "high",
                      target: "alternatives_considered", evidence_gap: "no alternative was named", cites: "runtime" });
      } catch { /* a fixture may be prose */ }

      // The critic sees the PROPOSAL OBJECT, not the planner's reasoning.
      const attack = this.think("critic", {
        question, round: i + 1, maxRounds: DEBATE.maxRounds, proposal: prop,
        n: this.thread.length, transcript: fmtThread(this.thread),
        memories: fmtMem(ctx.memories), results: fmtResults(this.results),
        criticCalls: DEBATE.criticCalls,
      }, r.attack, { head: `round ${i + 1} · attacks`, because: r.attackWhy });

      let verdict = "revise", objs = [];
      try { const a = JSON.parse(attack); verdict = a.verdict; objs = a.objections || []; } catch {}

      // Filter in code. "Cite your source" is a property of the system, not a
      // politeness the critic can decline.
      const kept = [], dropped = [];
      for (const o of [...mech, ...objs])
        (o.kind === "contradicted" && !o.cites ? dropped : kept).push(o);

      const high = kept.filter(o => o.severity === "high");
      out.rounds.push({ proposal: prop, attack, kept, dropped, verdict });
      out.spent = this.tokIn + this.tokOut;
      const wall = this.ms - out.t0;

      // Five independent bounds; each is sufficient on its own.
      const hit = verdict === "accept" ? "verdict === accept"
        : !high.length ? "no surviving high-severity objection"
        : i + 1 >= last ? `round ceiling (${last})`
        : out.spent > DEBATE.maxTokens ? `tokens ${out.spent} > ${DEBATE.maxTokens}`
        : wall > DEBATE.wallMs ? `wall ${wall}ms > ${DEBATE.wallMs}ms`
        : null;

      this.emit({
        kind: "gate", agent: "orchestrator", label: "debate control", ms: 0,
        head: hit ? `terminates — ${hit}` : `round ${i + 1} → revise`,
        detail: `round ${i + 1}/${DEBATE.maxRounds} · tokens ${out.spent}/${DEBATE.maxTokens} · wall ${wall}/${DEBATE.wallMs}ms`,
        kept, dropped, exits: DEBATE.exits, fixture: null,
      });

      if (hit) {
        out.verdict = (verdict === "accept" || !high.length) ? "accept" : "no-convergence";
        out.surviving = high;
        if (out.verdict === "no-convergence") {
          const kind = high.find(o => o.kind === "irreversible" || o.kind === "scope")?.kind;
          out.branch = kind ? DEBATE.tieBreak[kind] : DEBATE.tieBreak.other;
          // Never "the planner wins because the loop ended."
          this.emit({ kind: "gate", agent: "human_gate", label: "tie-break", ms: 0,
                      head: `no convergence · ${kind || "other"}`, detail: out.branch, fixture: null });
        }
        return out;
      }
      carried = `SURVIVING OBJECTIONS FROM ROUND ${i + 1}:\n${JSON.stringify(kept, null, 2)}`;
    }
    out.verdict = "no-convergence";
    return out;
  }

  /* A2A. A task with states, not a function call — and it must be able to
     decline, to ask us something, and to outlive this worker. */
  a2a(card, skill, input, script) {
    let ms = 0;
    for (const st of script.states) {
      ms += st.ms || 200; this.ms += st.ms || 200;
      this.emit({
        kind: "a2a", agent: "analyst", label: `${card} · ${st.state}`, ms: st.ms || 200,
        head: st.head, taskId: script.taskId, state: st.state, detail: st.detail,
        request: st.state === "submitted" ? { skill, input } : null,
        artifact: st.artifact || null,
        fixture: st.artifact ? "the specialist's artifact" : null,
      });
      // What the specialist returned or asked is evidence — it came from
      // outside our own model, which is the whole point of asking it.
      if (st.artifact) this.evidence.push(JSON.stringify(st.artifact));
      if (st.asks) this.evidence.push(st.asks);
    }
    if (script.artifact) this.evidence.push(JSON.stringify(script.artifact));
    return { ms, ...script };
  }

  /* The verifier, run for real against everything the tools returned. */
  check(draft) {
    const v = verify(draft, this.evidence);
    this.emit({
      kind: "verify", agent: "verifier", label: "mechanical check", ms: 3,
      ok: v.pass, checked: v.checked, corpus: v.corpus,
      rows: v.rows, unsupported: v.unsupported, unhedged: v.unhedged,
      head: v.pass ? `${v.checked} claim tokens, all grounded`
        : [v.unsupported.length ? `${v.unsupported.length} unsupported: ${v.unsupported.map(r => r.raw).join(", ")}` : "",
           v.unhedged.length ? `${v.unhedged.length} unhedged causal` : ""].filter(Boolean).join(" · "),
      draft, fixture: null,
    });
    return v;
  }
}

/* ═══════════════ formatters — these produce the literal prompt slots ═══════════════ */
const fmtThread = ms => ms.map(m => `  [${m.at}] <@${m.user}>: ${m.text.replace(/\n/g, " ")}`).join("\n");
const fmtMem = ms => ms.length ? ms.map(m => `  - (${m.kind}, ${m.age_days}d, prov ${m.provenance}) ${m.text}`).join("\n") : "  (none in scope)";
const fmtResults = rs => rs.length ? rs.map(r => `  ${r.name}(${JSON.stringify(r.args)})\n    → ${JSON.stringify(r.data)}`).join("\n") : "  (none yet)";

if (typeof module !== "undefined") {
  Object.assign(global, require("./tools.js"), require("./agents.js"));
  module.exports = { Run, verify, rank, tok, claimTokens, fmtThread, fmtMem, fmtResults, vecPreview };
}
