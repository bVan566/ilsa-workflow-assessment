// Ilsa UI. A thin client: every rule lives on the server; this file renders the view it returns.

let view = null;          // the current assessment view from the server
let reviewMode = false;
let change = null;        // "what changed" after the last action
let categories = {};

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const LABEL_OVERRIDES = { manual_reentry: 'Manual re-entry' };
const label = (cat) => LABEL_OVERRIDES[cat] ?? cat.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const DIM = { trigger: 'Trigger', steps: 'Steps', ownership: 'Ownership', systems: 'Tools', handoffs: 'Handoffs',
  decisions: 'Decisions', waiting: 'Waiting', exceptions: 'Exceptions', completion: 'Completion' };
const INTERVENTION = { process_change: 'Process change', existing_tool_change: 'Existing-tool change',
  simple_automation: 'Simple automation', ai_assisted: 'AI-assisted' };
const stepName = (id) => view.workflow.steps.find((s) => s.id === id)?.summary ?? id;
const ids = (refs) => [...new Set(refs.map((r) => r.evidence_id))].join(', ');

let errorTimer;
function showError(msg) {
  const el = document.getElementById('error');
  if (!el) return alert(msg);
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

// ---------------------------------------------------------------- provenance

/**
 * The badge that says where a fact came from. Values Ilsa read from your answers are the
 * default and carry no badge (their source is in the hover text); only values that need
 * attention or that you changed are marked.
 */
function badge(f) {
  if (f.by === 'user') {
    if (f.user_action === 'confirmed') return h('span', { class: 'badge b-user' }, 'User confirmed');
    if (f.user_action === 'marked_unknown') return h('span', { class: 'badge b-unknown' }, 'Unknown · marked by you');
    return h('span', { class: 'badge b-user' }, 'User changed');
  }
  if (f.status === 'inferred') return h('span', { class: 'badge b-confirm', title: 'Said with some uncertainty; not treated as fact until confirmed' }, 'Needs confirmation');
  if (f.status === 'unknown') return f.evidence.length ? h('span', { class: 'badge b-unknown' }, 'Unknown') : null;
  return null;
}

function sourceOf(f) {
  if (!f.evidence.length) return 'Not established yet';
  return f.by === 'user' ? `Set by you (${ids(f.evidence)})` : `Read by Ilsa from your answer (${ids(f.evidence)})`;
}

function factValue(f) {
  if (f.status === 'absent') return 'Does not exist';
  if (f.status === 'unknown') return f.evidence.length ? 'Nobody could say' : h('span', { class: 'muted' }, 'Not yet known');
  return f.value;
}

function wasLine(f) {
  if (f.by !== 'user' || !f.was || f.user_action === 'confirmed') return null;
  const before = f.was.status === 'unknown' ? 'nothing' : f.was.status === 'absent' ? '"does not exist"' : `"${f.was.value}"`;
  return h('div', { class: 'was' }, `Ilsa had: ${before}`);
}

/**
 * Applies a response only if the user is still looking at the assessment it belongs to.
 * Prevents a slow response from overwriting the screen after the user switched assessments.
 */
function apply(before, data, serverChange) {
  if (!data?.view) return false;
  if (!view || view.id !== data.view.id || (before && before.id !== data.view.id)) return false;
  change = serverChange === undefined ? change : describeChange(before, data.view, serverChange);
  view = data.view;
  render();
  return true;
}

// ---------------------------------------------------------------- review actions

async function review(sub, body) {
  const before = view;
  const { status, data } = await api('POST', `/assessments/${view.id}/review/${sub}`, body);
  if (status >= 400) return showError(data.error ?? `Error ${status}`);
  apply(before, data, data.change);
}

function editFact(slot, current) {
  const value = prompt(`Correct this (${slot}). Your correction is authoritative; Ilsa's version stays in the history.`, current ?? '');
  if (value != null && value.trim()) review('set-fact', { slot, value });
}
function markUnknown(slot) {
  const note = prompt('Record that nobody knows this. Optional note:', 'Nobody knows this.');
  if (note != null) review('mark-unknown', { slot, note: note || undefined });
}
function confirmFact(slot) {
  const note = prompt('Confirm this is correct. Optional note in your own words:', 'Confirmed.');
  if (note != null) review('confirm', { slot, note: note || undefined });
}

function factControls(slot, f) {
  if (!reviewMode) return null;
  return h('span', { class: 'ctl' },
    h('button', { class: 'small', onclick: () => editFact(slot, f.value) }, 'Correct'),
    (f.status === 'inferred' || (f.status === 'known' && f.by !== 'user')) &&
      h('button', { class: 'small', onclick: () => confirmFact(slot) }, 'Confirm'),
    !(f.by === 'user' && f.user_action === 'marked_unknown') && f.status !== 'known' &&
      h('button', { class: 'small', onclick: () => markUnknown(slot) }, 'Mark unknown'));
}

function factRow(name, slot, f) {
  return [h('dt', {}, name), h('dd', { 'data-slot': slot, title: sourceOf(f) }, factValue(f), badge(f), factControls(slot, f), wasLine(f))];
}

// ---------------------------------------------------------------- change summary (the correction loop)

function describeChange(before, after, serverChange) {
  if (!before || before.id !== after.id) return null;
  const lines = [];
  const bf = new Map(before.findings.map((f) => [f.id, f]));
  const af = new Map(after.findings.map((f) => [f.id, f]));
  const where = (f) => (f.step_ids.length ? ` (${f.step_ids.join(' → ')})` : '');
  const statusName = { confirmed: 'supported', tentative: 'needs confirmation', user_accepted: 'confirmed by you' };
  for (const [id, f] of bf) {
    if (af.has(id)) {
      const g = af.get(id);
      if (g.status !== f.status) lines.push({ cls: '', text: `Finding ${id} ${label(f.category)}${where(f)}: ${statusName[f.status]} → ${statusName[g.status]}` });
    } else if (after.disputed.some((d) => d.id === id)) {
      lines.push({ cls: 'removed', text: `Finding ${id} ${label(f.category)}${where(f)} disputed by you: excluded from the assessment` });
    } else {
      lines.push({ cls: 'removed', text: `Finding ${id} ${label(f.category)}${where(f)} no longer supported by the model: removed` });
    }
  }
  for (const [id, f] of af) if (!bf.has(id)) lines.push({ cls: 'added', text: `New finding ${id} ${label(f.category)}${where(f)}` });

  const recs = (v) => new Map((v.assessment.active?.recommendations ?? []).map((r) => [r.title, r]));
  const br = recs(before);
  const ar = recs(after);
  // Compare recommendations only between two current assessments; an assessment that merely
  // went out of date has not "removed" anything.
  if (before.assessment.active && after.assessment.active) {
    for (const [t, r] of br) {
      const n = ar.get(t);
      if (!n) {
        // Say why: its finding was disputed, it was superseded (findings still hold), or its findings are gone.
        const disputed = r.finding_ids.some((id) => after.disputed.some((d) => d.id === id));
        const stillHold = r.finding_ids.every((id) => after.findings.some((f) => f.id === id));
        const why = disputed ? 'you disputed its finding' : stillHold ? 'its findings now support another recommendation' : 'its findings no longer hold';
        lines.push({ cls: 'removed', text: `Recommendation removed: "${t}" (${why})` });
      }
      else if (n.finding_ids.join() !== r.finding_ids.join()) {
        lines.push({ cls: '', text: `Recommendation "${t}" now traces to ${n.finding_ids.join(', ')} (was ${r.finding_ids.join(', ')})` });
      }
    }
    for (const [t] of ar) if (!br.has(t)) lines.push({ cls: 'added', text: `New recommendation: "${t}"` });
  }
  if (before.assessment.active && !after.assessment.active) {
    lines.push({ cls: 'removed', text: 'The assessment is now outdated: the change reopened something readiness needs. See Readiness.' });
  } else if (serverChange?.regenerated) {
    lines.push({ cls: 'added', text: `Assessment regenerated from the corrected model (revision ${after.revision}).` });
  }
  return { title: serverChange ? `Your ${serverChange.action} was recorded as revision ${after.revision}` : 'Updated', lines, log: serverChange?.log ?? [] };
}

// ---------------------------------------------------------------- rendering

async function refreshList() {
  const { data } = await api('GET', '/assessments');
  const list = document.getElementById('list');
  list.replaceChildren(...(data.length ? data : []).map((a) => h('li', {},
    h('button', { class: view?.id === a.id ? 'current' : '', onclick: () => open(a.id) },
      h('span', { class: 'name' }, a.name), h('span', { class: 'pill' }, a.status), ' ', h('span', { class: 'muted' }, `${a.id} · rev ${a.revision}`)))));
  if (!data.length) list.append(h('li', { class: 'hint' }, 'No assessments yet.'));
}

function render() {
  const main = document.getElementById('main');
  if (!view) {
    main.replaceChildren(intro());
    return;
  }
  main.replaceChildren(...[
    h('div', { class: 'card titlebar' },
      h('div', {}, h('h2', {}, view.name), h('div', { class: 'hint' }, `${view.id} · status: ${view.status} · revision ${view.revision}`)),
      h('div', { class: 'row' },
        h('button', { 'aria-pressed': String(reviewMode), class: reviewMode ? 'primary' : '', onclick: () => { reviewMode = !reviewMode; render(); } },
          reviewMode ? 'Review mode: on' : 'Review & correct'))),
    h('p', { id: 'error', class: 'card error', hidden: true }),
    change && changePanel(),
    reviewMode && h('div', { class: 'card why' }, 'Review mode. Your corrections are authoritative and each one is saved as a new revision. Ilsa\'s original reading stays in the history (see Audit).'),
    h('div', { class: 'grid2' },
      h('div', { class: 'stack' }, discoveryCard(), readinessCard(), contextCard()),
      h('div', { class: 'stack' }, mapCard(), findingsCard())),
    assessmentCard(),
    auditCard(),
  ].filter(Boolean));
}

function intro() {
  return h('div', { class: 'card intro' },
    h('h3', {}, 'Ilsa turns "something is going wrong" into a map of how the work actually moves.'),
    h('ol', {},
      h('li', {}, 'Discover: Ilsa asks one question at a time, always the one that removes the most uncertainty.'),
      h('li', {}, 'Map: your answers become a structured workflow, and every fact points back to your own words.'),
      h('li', {}, 'Diagnose: friction is flagged only where your answers support it.'),
      h('li', {}, 'Review: correct anything Ilsa got wrong; findings and recommendations update.'),
      h('li', {}, 'Assess: recommendations unlock only once the process is understood.')),
    h('p', { class: 'hint' }, 'No API key is needed. Try the sample to see the whole loop in about a minute.'));
}

function changePanel() {
  return h('div', { class: 'card change flash' },
    h('div', { class: 'titlebar' }, h('strong', {}, `What changed · ${change.title}`), h('button', { class: 'small', onclick: () => { change = null; render(); } }, 'Dismiss')),
    change.lines.length
      ? h('ul', {}, change.lines.map((l) => h('li', { class: l.cls }, l.text)))
      : h('p', { class: 'hint' }, 'No findings or recommendations changed.'),
    change.log.length ? h('details', {}, h('summary', { class: 'hint' }, 'Details'), h('ul', {}, change.log.map((l) => h('li', { class: 'hint' }, l)))) : null);
}

function discoveryCard() {
  const q = view.question;
  const answer = h('textarea', { rows: 4, 'aria-label': 'Your answer', placeholder: 'Answer in your own words. "I don\'t know" is a fine answer.' });
  return h('div', { class: 'card' },
    h('h2', {}, 'Discovery'),
    h('p', { class: 'problem' }, `"${view.problem_statement}"`),
    q ? [
      h('div', {}, h('span', { class: 'pill' }, q.intent === 'confirm' ? `Confirm · ${DIM[q.dimension]}` : DIM[q.dimension])),
      h('p', { class: 'question' }, q.text),
      h('div', { class: 'why' }, h('strong', {}, 'Why this matters: '), q.why),
      h('div', { class: 'hint' }, `Asked now because ${q.reason}.`),
      answer,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          if (!answer.value.trim()) return showError('Type an answer first (or "I don\'t know").');
          const before = view;
          const { status, data } = await api('POST', `/assessments/${view.id}/answer`, { question_id: q.id, text: answer.value });
          if (status >= 400) return showError(data.error);
          apply(before, data, data.change);
          refreshList();
        } }, 'Answer'),
        q.sample_answer && h('button', { onclick: () => { answer.value = q.sample_answer; answer.focus(); } }, 'Use sample answer'),
        h('button', { onclick: async () => {
          const before = view;
          const { data } = await api('POST', `/assessments/${view.id}/skip`, { question_id: q.id });
          apply(before, data);
        } }, 'Skip')),
    ] : h('p', {}, view.discovery_complete
      ? 'Discovery is sufficient for assessment. Remaining unknowns are listed below.'
      : 'No open question.'),
    h('p', { class: 'hint' }, `${view.questions_answered} question(s) answered.`));
}

function readinessCard() {
  const r = view.readiness;
  const blocking = new Set(r.blocking.map((b) => b.dimension));
  const unknownKinds = new Map();
  for (const u of r.unknowns) unknownKinds.set(u.dimension, [...(unknownKinds.get(u.dimension) ?? []), u.kind]);
  const cov = Object.keys(view.coverage).map((d) => {
    if (blocking.has(d)) return h('span', { class: 'pill c-blocking' }, `✕ ${DIM[d]} · blocking`);
    const kinds = unknownKinds.get(d);
    if (kinds) {
      const explicit = kinds.every((k) => k === 'user_does_not_know');
      return h('span', { class: 'pill c-unknown' }, `? ${DIM[d]} · ${explicit ? 'explicitly unknown' : 'unknown, not blocking'}`);
    }
    return h('span', { class: 'pill c-established' }, `✓ ${DIM[d]}`);
  });
  return h('div', { class: 'card' },
    h('h2', {}, 'Readiness'),
    h('div', { class: 'coverage' }, cov),
    h('p', { class: 'hint' }, '✓ established · ? known to be unknown (does not block) · ✕ blocks the assessment'),
    r.ready
      ? h('p', {}, h('span', { class: 'badge b-ok' }, 'Ready'), ' Every foundational part of the process is established or explicitly unknown.')
      : [
          h('p', {}, h('span', { class: 'badge b-bad' }, 'Not ready'), ` ${r.blocking.length} item(s) block recommendations:`),
          h('ul', { class: 'blockers' }, r.blocking.map((b) => h('li', {}, h('strong', {}, `${DIM[b.dimension]}: `), b.needed,
            reviewMode && b.slot.includes('.') ? h('span', { class: 'ctl' }, h('button', { class: 'small', onclick: () => markUnknown(b.slot) }, 'Mark unknown')) : null))),
        ]);
}

function contextCard() {
  const text = h('textarea', { rows: 2, 'aria-label': 'Add context', placeholder: 'Anything Ilsa should know that the questions did not cover.' });
  return h('div', { class: 'card' },
    h('h2', {}, 'Add context'),
    text,
    h('div', { class: 'row' }, h('button', { onclick: async () => {
      if (!text.value.trim()) return;
      const before = view;
      const { status, data } = await api('POST', `/assessments/${view.id}/context`, { text: text.value });
      if (status >= 400) return showError(data.error);
      apply(before, data, data.change);
    } }, 'Add context')),
    h('p', { class: 'hint' }, 'Context is read like any answer, but it cannot override your own corrections.'));
}

function stepNode(s, i, n) {
  const provenance = s.added_by === 'user'
    ? h('span', { class: 'badge b-user' }, 'User added')
    : s.summary_was ? h('span', { class: 'badge b-user' }, 'User changed') : null;
  return h('div', { class: 'node', 'data-step': s.id },
    h('div', { class: 'head' },
      h('div', { title: s.added_by === 'user' ? 'Added by you' : `Read by Ilsa from your answer (${ids(s.evidence)})` },
        h('span', { class: 'sid' }, `${i + 1} · ${s.id}`), ' ', h('span', { class: 'summary' }, s.summary), provenance),
      reviewMode && h('span', { class: 'ctl' },
        h('button', { class: 'small', title: 'Move up', disabled: i === 0, onclick: () => review('move-step', { step_id: s.id, to_index: i - 1 }) }, '↑'),
        h('button', { class: 'small', title: 'Move down', disabled: i === n - 1, onclick: () => review('move-step', { step_id: s.id, to_index: i + 1 }) }, '↓'),
        h('button', { class: 'small', onclick: () => {
          const text = prompt('Correct the step text:', s.summary);
          if (text && text.trim()) review('edit-step', { step_id: s.id, summary: text });
        } }, 'Edit text'))),
    s.summary_was && h('div', { class: 'was' }, `Ilsa had: "${s.summary_was}"`),
    h('dl', { class: 'facts' },
      i > 0 ? factRow('How it arrives', `${s.id}.handoff_in`, s.handoff_in) : null,
      factRow('Owner', `${s.id}.owner`, s.owner),
      factRow('Tool', `${s.id}.system`, s.system),
      s.waiting_on.status !== 'unknown' ? factRow('Waits on', `${s.id}.waiting_on`, s.waiting_on) : null),
    (s.manual || s.decision) && h('div', { class: 'flags' },
      s.manual && h('span', { class: 'pill' }, 'done by hand'), s.decision && h('span', { class: 'pill' }, 'judgment call')));
}

function addStepForm() {
  const n = view.workflow.steps.length;
  const summary = h('input', { placeholder: 'What happens in this step?', 'aria-label': 'Step text' });
  const position = h('select', { 'aria-label': 'Position' }, Array.from({ length: n + 1 }, (_, i) => h('option', { value: i }, `Position ${i + 1}`)));
  position.value = String(n);
  const owner = h('input', { placeholder: 'Owner (optional)', 'aria-label': 'Owner' });
  const tool = h('input', { placeholder: 'Tool (optional)', 'aria-label': 'Tool' });
  return h('details', { class: 'node edge' }, h('summary', {}, '+ Add a step Ilsa missed'),
    summary, h('div', { class: 'row' }, position, owner, tool),
    h('div', { class: 'row' }, h('button', { onclick: () => {
      if (!summary.value.trim()) return showError('Describe the step first.');
      review('add-step', { summary: summary.value, position: Number(position.value), owner: owner.value, system: tool.value });
    } }, 'Add step')));
}

function mapCard() {
  const wf = view.workflow;
  const nodes = [
    h('div', { class: 'node edge' }, h('dl', { class: 'facts' }, factRow('Starts when', 'trigger', wf.trigger))),
  ];
  wf.steps.forEach((s, i) => nodes.push(h('div', { class: 'arrow', 'aria-hidden': 'true' }, '↓'), stepNode(s, i, wf.steps.length)));
  nodes.push(h('div', { class: 'arrow', 'aria-hidden': 'true' }, '↓'),
    h('div', { class: 'node edge' }, h('dl', { class: 'facts' },
      factRow('Finished when', 'completion', wf.completion),
      factRow('If it goes wrong', 'exceptions', wf.exceptions),
      factRow('Judgment calls', 'decisions', wf.decisions),
      factRow('Waiting', 'waiting', wf.waiting))));
  const confirmed = wf.sequence.status === 'known' && wf.sequence.value === `confirmed: ${wf.steps.length} steps`;
  return h('div', { class: 'card' },
    h('div', { class: 'titlebar' }, h('h2', {}, 'Workflow map'),
      h('span', { class: `pill ${confirmed ? 'c-established' : 'c-tentative'}` }, confirmed ? 'Step list confirmed' : 'Step list not yet confirmed')),
    wf.steps.length === 0 ? h('p', { class: 'hint' }, 'No steps yet. They appear as you describe the process.')
      : h('p', { class: 'hint' }, 'Unmarked values were read by Ilsa from your answers (hover to see which one). Badges mark what you changed or confirmed, and what still needs attention.'),
    h('div', { class: 'map' }, nodes),
    reviewMode && h('div', { class: 'row' },
      addStepForm(),
      wf.steps.length >= 2 && !confirmed && h('button', { onclick: () => review('confirm-sequence', {}) }, 'Confirm this list is complete and in order')));
}

function findingItem(f, { controls }) {
  const status = { confirmed: ['Supported by your answers', 'b-ok'], tentative: ['Needs confirmation', 'b-confirm'], user_accepted: ['User confirmed', 'b-user'] }[f.status];
  const quotes = dedupeQuotes(f.evidence);
  const tone = { confirmed: 'f-confirmed', tentative: 'f-tentative', user_accepted: 'f-user' }[f.status] ?? '';
  return h('div', { class: `finding ${tone}`, 'data-finding': f.id },
    h('div', { class: 'titlebar' },
      h('div', {}, h('span', { class: 'cat' }, `${f.id} · ${label(f.category)}`), status && h('span', { class: `badge ${status[1]}` }, status[0])),
      controls && reviewMode && f.status !== 'user_accepted' && h('span', { class: 'ctl' },
        h('button', { class: 'small', onclick: () => review('accept-finding', { finding_id: f.id }) }, 'Accurate'),
        h('button', { class: 'small', onclick: () => {
          const reason = prompt('Why is this inaccurate? (required; kept on record)');
          if (reason && reason.trim()) review('dispute-finding', { finding_id: f.id, reason });
        } }, 'Inaccurate'))),
    f.step_ids.length ? h('div', { class: 'hint' }, `Steps: ${f.step_ids.map((id) => `${id} "${stepName(id)}"`).join(' → ')}`) : null,
    h('div', {}, f.support),
    h('div', { class: 'hint' }, f.rationale),
    quotes.length ? h('details', {}, h('summary', { class: 'hint' }, `Show evidence (${quotes.length})`),
      quotes.map((r) => h('blockquote', {}, `${r.evidence_id}: "${r.quote}"`))) : null);
}

/** One entry per distinct quote: exact repeats are dropped, and a quote contained in a longer one from the same answer is folded into it. */
function dedupeQuotes(refs) {
  const norm = (t) => t.toLowerCase().replace(/s+/g, ' ').trim();
  const out = [];
  for (const r of refs) {
    const q = norm(r.quote);
    const same = out.findIndex((o) => o.evidence_id === r.evidence_id && (norm(o.quote).includes(q) || q.includes(norm(o.quote))));
    if (same === -1) out.push(r);
    else if (q.length > norm(out[same].quote).length) out[same] = r;
  }
  return out;
}

function findingsCard() {
  return h('div', { class: 'card' },
    h('h2', {}, 'Findings'),
    h('p', { class: 'provisional' }, view.assessment.active ? 'These match the current assessment.' : 'Provisional: discovery is still in progress. These are observations, not an assessment.'),
    view.findings.length ? view.findings.map((f) => findingItem(f, { controls: true })) : h('p', { class: 'hint' }, 'No friction found yet. Findings appear only where your answers support them.'),
    view.disputed.length ? h('details', {}, h('summary', { class: 'hint' }, `Disputed by you (${view.disputed.length}), excluded from the assessment`),
      view.disputed.map((f) => h('div', { class: 'finding' }, h('span', { class: 'cat' }, `${f.id} · ${label(f.category)}`), h('span', { class: 'badge b-bad' }, 'Disputed')))) : null);
}

function reportView(r) {
  const cs = r.current_state;
  const fv = (f) => (f.certainty === 'absent' ? 'does not exist' : f.certainty === 'unknown' ? 'unknown' : f.value);
  return h('div', { class: 'report sections' },
    h('div', { class: 'section' }, h('h3', {}, h('span', { class: 'num' }, '1'), 'Current state'),
      h('p', {}, h('strong', {}, 'Starts: '), fv(cs.trigger)),
      h('ol', {}, cs.steps.map((s) => h('li', {}, s.summary, h('span', { class: 'hint' }, ` · owner: ${fv(s.owner)} · tool: ${fv(s.system)}`)))),
      h('p', {}, h('strong', {}, 'Finished when: '), fv(cs.completion)),
      h('p', {}, h('strong', {}, 'When it goes wrong: '), fv(cs.exceptions))),
    h('div', { class: 'section' }, h('h3', {}, h('span', { class: 'num' }, '2'), 'Observed friction'),
      r.observed_friction.confirmed.length ? h('ul', {}, r.observed_friction.confirmed.map((f) =>
        h('li', {}, h('strong', {}, `${f.id} ${label(f.category)}`), ` ${f.support}`))) : h('p', { class: 'hint' }, 'None confirmed.'),
      r.observed_friction.needs_confirmation.length ? [h('p', {}, h('span', { class: 'badge b-confirm' }, 'Needs confirmation')),
        h('ul', {}, r.observed_friction.needs_confirmation.map((f) => h('li', {}, h('strong', {}, `${f.id} ${label(f.category)}`), ` ${f.support}`)))] : null),
    h('div', { class: 'section' }, h('h3', {}, h('span', { class: 'num' }, '3'), 'Unknowns'),
      r.unknowns.length ? h('ul', {}, r.unknowns.map((u) => h('li', {}, u.description))) : h('p', { class: 'hint' }, 'Nothing left unknown.')),
    h('div', { class: 'section' }, h('h3', {}, h('span', { class: 'num' }, '4'), 'Recommendations'),
      r.recommendations.map((rec) => h('div', { class: 'rec' },
        h('div', {}, h('strong', {}, `${rec.id} · ${rec.title}`)),
        h('div', { class: 'row' },
          h('span', { class: `badge ${rec.kind === 'act' ? 'b-ok' : 'b-confirm'}` }, rec.kind === 'act' ? 'Act' : 'Confirm first'),
          h('span', { class: 'pill' }, INTERVENTION[rec.intervention]),
          h('span', { class: 'hint' }, `traces to ${rec.finding_ids.join(', ')}`)),
        h('div', { class: 'hint' }, rec.detail),
        h('div', { class: 'why-ai' }, rec.ai_reason ? `Why AI: ${rec.ai_reason}` : `Why not AI: ${rec.why_not_ai}`)))));
}

function assessmentCard() {
  const { active, previous } = view.assessment;
  const r = view.readiness;
  const generate = async () => {
    const before = view;
    const { status, data } = await api('POST', `/assessments/${view.id}/generate`, {});
    if (status >= 400) showError(data.error);
    apply(before, data, status >= 400 ? undefined : { action: 'assessment', revision: data.view?.revision, log: [], regenerated: true });
    refreshList();
  };
  if (active) {
    return h('section', { class: 'card assessment-active', 'aria-label': 'Current assessment' },
      h('div', { class: 'stamp' }, `Current assessment · based on revision ${active.based_on_revision}, which matches the workflow model`),
      reportView(active));
  }
  if (previous) {
    return h('section', { class: 'card assessment-outdated', 'aria-label': 'Outdated assessment' },
      h('div', { class: 'stamp' }, `OUTDATED: not the current assessment. It was based on revision ${previous.based_on_revision}; the workflow model is now at revision ${view.revision}.`),
      r.ready
        ? h('div', { class: 'row' }, h('button', { class: 'primary', onclick: generate }, 'Regenerate from the corrected model'))
        : h('p', {}, `It cannot be regenerated until readiness is met again (${r.blocking.length} item(s), see Readiness).`),
      h('details', {}, h('summary', { class: 'hint' }, 'Show the outdated report, for reference only'), reportView(previous)));
  }
  return h('section', { class: 'card' },
    h('h2', {}, 'Assessment'),
    r.ready
      ? h('div', { class: 'locked' }, h('p', {}, 'Ilsa understands the process well enough to assess it.'), h('button', { class: 'primary', onclick: generate }, 'Generate assessment'))
      : h('div', { class: 'locked' }, h('p', {}, h('strong', {}, 'Recommendations are locked'), ' until Ilsa understands the process.'),
          h('p', {}, `${r.blocking.length} item(s) still block readiness. See Readiness for exactly what is missing.`)));
}

function auditCard() {
  const box = h('div', { class: 'audit' }, h('p', { class: 'hint' }, 'Loading…'));
  const details = h('details', { class: 'card' },
    h('summary', {}, `Audit & details · ${view.rejected_count} rejected proposal(s), revision history, evidence log`), box);
  details.addEventListener('toggle', async () => {
    if (!details.open) return;
    const { data } = await api('GET', `/assessments/${view.id}/audit`);
    box.replaceChildren(
      h('h3', {}, 'Rejected proposals (never shown as findings)'),
      data.rejected.length ? h('table', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Category'), h('th', {}, 'Source'), h('th', {}, 'Why rejected')),
        data.rejected.map((f) => h('tr', {}, h('td', {}, f.id), h('td', {}, f.category), h('td', {}, f.source), h('td', {}, f.rejection_reason))))
        : h('p', { class: 'hint' }, 'None.'),
      h('h3', {}, 'Revision history'),
      h('table', {}, h('tr', {}, h('th', {}, 'Rev'), h('th', {}, 'By'), h('th', {}, 'What')),
        data.revisions.map((r) => h('tr', {}, h('td', {}, r.revision), h('td', {}, r.actor),
          h('td', {}, r.reason, r.details.length ? h('details', {}, h('summary', { class: 'hint' }, `${r.details.length} detail(s)`), h('ul', {}, r.details.map((d) => h('li', {}, d)))) : null)))),
      h('h3', {}, 'Evidence log (append-only)'),
      h('table', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Kind'), h('th', {}, 'About'), h('th', {}, 'Text')),
        data.evidence.map((e) => h('tr', {}, h('td', {}, e.id), h('td', {}, e.kind), h('td', {}, e.about ?? e.question_id ?? ''), h('td', {}, e.text)))));
  });
  return details;
}

// ---------------------------------------------------------------- navigation

let navToken = 0; // the latest navigation wins; slower earlier responses are ignored

async function open(id) {
  const token = ++navToken;
  const { status, data } = await api('GET', `/assessments/${id}`);
  if (token !== navToken) return;
  if (status >= 400) { view = null; location.hash = ''; render(); return; }
  view = data.view;
  change = null;
  location.hash = id;
  render();
  refreshList();
}

async function startSample(mode) {
  const token = ++navToken;
  const { status, data } = await api('POST', '/sample', { mode });
  if (token !== navToken) return refreshList();
  if (status >= 400) return showError(data.error);
  view = data.view;
  change = null;
  reviewMode = mode === 'complete';
  location.hash = view.id;
  render();
  refreshList();
}

async function init() {
  categories = (await api('GET', '/config')).data.categories ?? {};
  const dialog = document.getElementById('new-dialog');
  document.getElementById('new-btn').addEventListener('click', () => dialog.showModal());
  document.getElementById('new-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    const name = document.getElementById('new-name').value;
    const problem = document.getElementById('new-problem').value;
    const token = ++navToken;
    const { status, data } = await api('POST', '/assessments', { name, problem });
    if (token !== navToken) return refreshList();
    if (status >= 400) return showError(data.error);
    view = data.view;
    change = null;
    location.hash = view.id;
    render();
    refreshList();
  });
  document.getElementById('sample-guided').addEventListener('click', () => startSample('guided'));
  document.getElementById('sample-complete').addEventListener('click', () => startSample('complete'));
  await refreshList();
  if (location.hash.length > 1) await open(location.hash.slice(1));
  else render();
}

init();
