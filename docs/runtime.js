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
const CAUSAL_C = /\b(caused|because|due to|led to|result(?:ed)? (?:in|from)|root cause (?:is|was)|responsible for|triggered|stems from|to blame)\b/i;
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
  // Longest-first, or "41/s" matches the `s` branch and bares to "41/".
  const UNIT = /(\/s|rps|ms|gb|mb|%|×|x|s|m|h|k)$/;
  const bare = x => x.replace(UNIT, "");
  const unit = x => (x.match(UNIT) || [""])[0];
  // One-directional. A draft may DROP a unit the evidence carried ("41/s" → "41");
  // it may never CHANGE one. Evidence of 1450ms must not support a draft that
  // says 1450s, and 94% must not support 94x.
  const unitOk = (h, x) => unit(h) === unit(x) || (unit(x) === "" && unit(h) !== "");
  // 1-significant-figure near-match: evidence 41.2 supports a draft that says 41.
  // Without it, correct rounding is rejected and the writer learns to route
  // around the verifier, which is worse than not having one.
  // The near-match applies to MEASUREMENTS ONLY. It must never touch a
  // timestamp or a version: parseFloat("14:55") is 14, so without this
  // restriction an evidence value of 14:10 "supported" a draft that said
  // 14:55 — inventing a time, which is the single thing this verifier is
  // least allowed to miss. Found by typing a forged draft into the sandbox.
  const find = (x, cls) => keys.find(h => h === x || (bare(h) === bare(x) && unitOk(h, x))
    || (cls === "num" && unitOk(h, x) && !isNaN(parseFloat(h)) && !isNaN(parseFloat(x))
        && Math.abs(parseFloat(h) - parseFloat(x)) <= Math.abs(parseFloat(h)) * 0.02
        && (bare(h) !== h) === (bare(x) !== x)));

  const rows = tokensOf(draft).map(t => {
    const h = find(t.key, t.cls);
    if (h) return { ...t, found: true, src: hay.get(h) };
    const lit = t.cls === "ident" && (t.quoted || t.key.length > 4)
      && new RegExp(`(^|[^a-z0-9_])${t.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`).test(flat);
    return { ...t, found: lit, src: lit ? "(literal match in evidence)" : null };
  });
  const unsupported = rows.filter(r => !r.found);
  const unhedged = String(draft).split(/(?<=[.!?])\s+|\n/)
    .filter(s => CAUSAL_C.test(s) && !HEDGE_C.test(s)).map(s => s.trim());

  return { pass: !unsupported.length && !unhedged.length, rows, unsupported, unhedged,
           checked: rows.length, corpus: hay.size };
}

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
    // `async` work happens after the reply is in the channel. It costs tokens
    // but it does not cost the person who asked anything, so it must not be
    // counted in the service time the capacity model is built from.
    if (opts.async) this.asyncMs = (this.asyncMs || 0) + ms; else this.ms += ms;
    this.emit({
      kind: "model", agent: a.id, label: a.name, model: a.model, ms,
      head: opts.head || gist(output) || a.owns,
      tokIn: tin, tokOut: tout, budget: a.budget,
      over: tin + tout > a.budget,
      system: a.system, user, output,
      async: !!opts.async,
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
    if (rec.ok) {
      this.results.push(rec);
      this.evidence.push(JSON.stringify(rec.data));
      // A result carries its numbers and its unit in separate fields, so the
      // corpus never held "1450ms" — only "1450" and "ms". That made a unit
      // the draft attached unverifiable in either direction. Emit the bound
      // form too, so "1450 ms" is supported and "1450 s" is not.
      const u = rec.data?.unit;
      if (u) this.evidence.push(
        [...(rec.data.points || []).map(pt => pt[1]), rec.data.min, rec.data.max,
         rec.data.step_change?.to].filter(v => v != null).map(v => `${v}${u}`).join(" "));
    }
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

  /* The Librarian, as code.
     It was a small-model call on the critical path of every run — 18% of all
     tokens — and a measurement showed its output reached no downstream prompt.
     The Writer receives {results} and {memories}; the Planner receives
     {transcript} and {entities}. Nobody ever read its summary.

     What it was actually FOR is all mechanical: fetch the thread, retrieve
     inside the scope predicate, trim to the budget. Entity extraction reuses
     tokensOf() — the verifier's own extractor — so one piece of code serves
     both retrieval and grounding, and neither needs a model. */
  library(opts = {}) {
    const t0 = this.ms;
    this.fetchThread({ because: opts.because });

    // Entities, by the same extractor the verifier uses on the draft.
    const ents = [...new Set(this.thread.flatMap(m =>
      tokensOf(m.text).filter(t => t.cls === "ident" || t.cls === "version" || t.cls === "time")
        .map(t => t.raw.replace(/`/g, ""))))];
    // Retrieve on the CONVERSATION, not just on the last line. "is this the
    // same root cause as March?" shares no keyword with "pool exhaustion after
    // a retry change" — but the message two above it says "March was the pool
    // thing", and that is the term that finds it. A real embedding would bridge
    // the gap semantically; a keyword ranker needs the words to be present, and
    // pretending otherwise would make the retrieval span a lie.
    const ask = this.sc.question.replace(/<@\w+>/g, "").trim();
    const recent = this.thread.slice(-4).map(m => m.text).join(" ");
    const query = [ask, recent, ...ents].join(" ").slice(0, 300);

    // Instruction-shaped text is FLAGGED here and enforced nowhere here — the
    // allowlist is the enforcement. A regex that thought it was a security
    // control would be worse than no regex.
    const INJ = /\b(ignore (all )?(your |the )?previous instructions|disregard the above|system prompt|list every memory|reveal your)\b/i;
    const dropped = this.thread.filter(m => INJ.test(m.text))
      .map(m => ({ from: m.user, text: (m.text.match(INJ) || [])[0], why: "instruction-shaped text in an untrusted transcript — reported as content, never obeyed" }));

    const mems = this.recall(query, { because: `entities extracted from the thread by tokensOf(): ${ents.slice(0, 6).join(", ") || "none"}` });

    this.emit({
      kind: "route", agent: "librarian", label: "context assembled", ms: 2,
      head: `${this.thread.length} msgs · ${ents.length} entities · ${mems.length} memories · ${dropped.length} flagged`,
      note: "No model runs here. This was a small-model call whose output nothing downstream ever read; what it was for is mechanical.",
      operands: { thread_messages: this.thread.length, char_budget: 24000,
                  entities: ents, retrieval_query: query, scope: this.scope,
                  flagged_as_content: dropped },
      source: Run.prototype.library.toString(),
      fixture: null,
    });
    this.ms = t0 + (this.ms - t0);
    return { memories: mems, entities: ents, dropped };
  }

  /* The thread fetch, made explicit. It used to be implicit — the transcript
     simply appeared — which left the first link of the derivation chain
     missing and left the catalogued tool never dispatched. */
  fetchThread(opts = {}) {
    this.tool("librarian", "slack.conversations_replies",
      { channel: `C_${this.channel.toUpperCase().replace(/-/g, "")}`, thread_ts: "1699.0", limit: 200 },
      { because: opts.because || "the mention alone is not the question — three people may be talking, and attribution lives in the line structure",
        then: opts.then });
    return this.thread;
  }

  /* Retrieval, shown end to end. This DISPATCHES memory.mem_search rather than
     filtering here: a review found the scope predicate implemented twice, with
     the copy this page documents never executed — deleting it outright left
     every check green. One predicate, one path, one thing to get right. */
  recall(query, opts = {}) {
    const rec = callTool("memory.mem_search", { query, k: opts.k || 4 },
      { agent: "librarian", scope: this.scope, thread: this.thread, approved: this.approved });
    const d = rec.data || { hits: [], corpus: 0, inScope: 0, excluded: 0 };
    const ms = 40 + d.inScope * 3;
    this.ms += ms;
    for (const h of d.hits) this.evidence.push(h.text);
    this.emit({
      kind: "vector", agent: "librarian", label: "memory.mem_search", ms,
      query, model: "text-embedding-3-small", dims: 1536, preview: vecPreview(query),
      head: `${d.hits.length} hit${d.hits.length === 1 ? "" : "s"} of ${d.inScope} in scope` +
            (d.hits.length ? ` · top ${d.hits[0].score}` : " · nothing matched"),
      predicate: `scope_id = "${this.scope}"`,
      corpus: d.corpus, inScope: d.inScope, excluded: d.excluded,
      spec: rec.spec, args: rec.args,
      hits: d.hits.map(h => ({ id: h.id, score: h.score, matched: h.matched, kind: h.kind,
                               age: h.age_days, prov: h.provenance, text: h.text })),
      because: opts.because,
      partial: "the 1536-d vector preview is illustrative — the scope filter, ranking and scores below are computed",
    });
    return d.hits;
  }

  /* The tier decision — pure code, and the operands are shown alongside the
     rule so a reader can see WHY this run took this path. */
  tier(ctx) {
    const d = tierFor({ ...ctx, question: this.sc.question });
    const spec = TIERS.find(x => x.id === d.tier);
    this.emit({
      kind: "route", agent: "orchestrator", label: "tier predicate", ms: 1,
      head: `${d.tier} · ${spec.name}`, rule: d.rule, note: d.note,
      operands: { question: this.sc.question,
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
      because: `every claim token in the draft is set-differenced against ${this.results.length} tool result(s) plus the transcript — the draft's own upstream turns are deliberately not in the corpus`,
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
  module.exports = { Run, verify, tok, claimTokens, fmtThread, fmtMem, fmtResults, vecPreview };
}

/* Two agents in the registry say they are code rather than a model. Back-fill
   their actual source, so the UI shows the algorithm instead of a claim about
   one. This has to run after the module block above, because that is where
   Node picks up AGENT. */
AGENT.verifier.predicate = verify.toString();
AGENT.librarian.predicate = Run.prototype.library.toString();
