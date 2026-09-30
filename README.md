# Ilsa: workflow assessment

A working prototype of an AI-assisted workflow discovery and assessment tool. A business owner describes a process in ordinary language. Ilsa asks one targeted question at a time, maps how the work actually moves, flags friction only where the owner's own words support it, and produces an assessment. The assessment keeps current state, observed friction, unknowns and recommendations separate. Every claim traces back to a quote, a human can correct anything, and recommendations stay locked until the process is understood.

**No API key is needed.** The app, the sample, the tests and the evaluation all run on a deterministic, no-key interpreter. Claude is an optional add-on.

## 90-second demo

**Watch the demo:** https://youtu.be/ykFrvLkGzrQ

To run it yourself: `npm install && npm start`, then open http://localhost:3100.

1. **Try the sample (guided).**
   - The first question is "Walk me through what happens…", with a *Why this matters* line.
   - Click **Use sample answer**, then **Answer**. The workflow map fills in, provisional findings appear, and Readiness shows what still blocks: *Recommendations are locked*.
2. **Load finished sample.** The same pipeline has run on the full set of sample answers. A green **Current assessment** appears with four sections.
3. In **Findings**, open F8 *Information loss (S3 → S4)* → **Show evidence**: the owner texts the technician the customer's name.
4. In the map, next to step 4 **How it arrives**, click **Correct**. Enter "The owner assigns it in the spreadsheet and the technician works from there."
   - **What changed** reports: F8 removed · recommendation now traces to F7 only (was F7, F8) · assessment regenerated.
   - The field shows *User changed*, with *Ilsa had: …* underneath.
5. The tentative F9 (*Needs confirmation*) → **Accurate**. It becomes *User confirmed*, and its "Confirm first" recommendation is replaced by an actionable one.
6. **Recommendations:** each has an intervention type, the findings it traces to, and why AI is or is not needed.

Full script: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## The problem

Owners often know something is going wrong ("we keep losing inquiries") without knowing where the process actually fails. Jumping straight to "buy a CRM" or "add an AI agent" skips the part that matters: who owns each step, how work is handed over, what "done" means, and what happens when the normal path breaks.

## What it does

**Discover → Clarify → Map → Diagnose → Review → Assess → Recommend**

- **Discover:** asks the question that removes the most uncertainty (weight × uncertainty), never "tell me more" about something already settled.
- **Map:** turns answers into a structured workflow. Every fact has one of four certainty states:
  - `known`: stated plainly
  - `inferred`: stated with a hedge like "usually" or "I think"
  - `absent`: the user said it doesn't exist
  - `unknown`: not established

  Every fact carries the exact quote it rests on.
- **Diagnose:** friction from a fixed taxonomy of 16 categories. A finding must cite real quotes linked to the cited steps, and the model must actually show that problem. Findings built on inferred facts are *tentative*.
- **Review:** correct step text, owners and tools; reorder or add steps; mark fields unknown; accept or dispute findings; add context. Every change is a new revision, the evidence log is append-only, and a disputed finding stays disputed unless new evidence supports it.
- **Assess:** locked until every foundational dimension (steps, trigger, ownership, handoffs, exceptions, completion) is established or explicitly unknown.
  - Each recommendation traces to a validated finding.
  - Tentative findings only produce "confirm first" recommendations.
  - AI is recommended only where input genuinely needs interpretation, and only with a stated reason.

## Architecture

```mermaid
flowchart LR
    U[User's words] --> E[(Evidence<br/>append-only)]
    E --> I["Interpreter<br/>no-key rules, or Claude"]
    I -- proposals --> M["Merge rules<br/>(deterministic)"]
    M --> W[("Workflow model<br/>revisions")]
    W --> F["Friction gate<br/>(deterministic)"]
    F --> G{"Readiness gate"}
    G -- ready --> A["Assessment builder<br/>+ validator"]
    H[Human review] --> E
    H --> W
```

**Where AI ends:** an interpreter, whether the no-key rules or Claude, only **proposes**. It reads text and suggests steps, owners, certainty and possible friction. Ordinary code decides everything else:

| Control | Where |
| --- | --- |
| Quotes must be the user's exact words; "known" backed only by hedged words becomes "inferred" | `src/merge.ts`, `src/validate.ts` |
| The opening complaint can't establish facts (capped at inferred) | `src/merge.ts` |
| User corrections can't be overwritten by any interpreter | `src/merge.ts` |
| Next question selection | `src/gaps.ts` |
| Friction must pass taxonomy, quote, linkage and per-category support checks | `src/friction.ts` |
| Readiness gate: no assessment until the process is understood | `src/readiness.ts` |
| Recommendations: fixed catalog, traced to findings, AI only with a reason | `src/recommend.ts`, `src/report.ts` |
| Revisions, append-only evidence, sticky disputes | `src/store.ts`, `src/review.ts` |

Recommendations are never written by a model.

## Run it

Requires **Node.js 24.2 or later**. There's no build step.

```bash
git clone https://github.com/bVan566/ilsa-workflow-assessment.git
cd ilsa-workflow-assessment
npm install
npm start        # http://localhost:3100
```

Data is stored in `data/ilsa.db` (local SQLite, unencrypted). Settings:
- `PORT`, `HOST` (default `127.0.0.1`)
- `ILSA_DATA_DIR`: on Windows, keep the full path under 260 characters

## No key vs. Claude

| | |
| --- | --- |
| **Works with no key** | Everything: discovery, the map, findings, review, assessment, the guided and finished samples, all tests, the evaluation. The header says "No AI service is being called." |
| **What Claude optionally adds** | With `ANTHROPIC_API_KEY` in `.env` (see `.env.example`; model `claude-opus-5-5`, override with `ILSA_MODEL`): better reading of unusual phrasing, and suggested findings the rules can't detect (bottlenecks, duplicate work, inconsistent decisions, customers chasing). Every suggestion passes the same checks. Any failure falls back to the no-key interpreter, and the log says why. |
| **Tested offline** | How Ilsa *handles* Claude's output, using a fake client: request shape, grounding, hedge downgrade, invented quotes dropped, user corrections protected, six failure types falling back, and unsupported suggested findings rejected. |
| **Unmeasured without a live key** | Whether Claude actually reads answers better than the no-key rules, how often its quotes fail the exact-match check, and whether the live API accepts the JSON schema. **No Claude performance is claimed.** |
| **Data sent to Anthropic if enabled** | For every answer or piece of context: that text, the question it answers, and a summary of the current workflow model (steps, owners, tools, facts). For finding suggestions: the model summary plus the quoted evidence linked to each step. Nothing is sent without a key. Don't use real customer data. |

**Cost with a key:** about 2 API calls per answer (interpret + suggest findings), so a full guided session is roughly 25–30 calls. **Load finished sample** always uses the no-key interpreter and costs nothing.

## Tests

```bash
npm test         # 108 tests, offline, no key
npm run typecheck
```

The tests cover:
- schema and evidence validation, persistence, revisions
- discovery: the four certainty states, question selection, termination
- merge rules against fabricating and overconfident interpreters
- friction rules and the gate, including the unsupported-diagnosis failure from five angles
- the readiness gate, the four-section report, the recommendation rules and the report validator
- human review: corrections, sticky disputes, lineage, stale reports
- the Claude interpreter and proposer with a fake client
- the HTTP API and both samples
- one test per post-review fix

## Evaluation

Protocol, limits and the full comparison: [`eval/README.md`](eval/README.md).

- **Cases:** 20 hand-written workflows from 20 different businesses (16 with friction, 4 healthy), separate from the development examples.
- **What's measured:** the **no-key interpreter and deterministic controls only.**
- **Two runs, kept apart:**
  - **Run 1, held-out.** Rules frozen before the cases were seen. This is the honest measurement: [`run1-heldout.md`](eval/results/run1-heldout.md).
  - **Run 2, post-review, not held-out.** The same cases after five fixes made because of Run 1. It shows what the fixes changed, and is likely optimistic: [`run2-post-review.md`](eval/results/run2-post-review.md). Reproduce with `npm run eval`.

| Metric | **Run 1: held-out** | Run 2: post-review, not held-out |
| --- | --- | --- |
| Step extraction recall / precision | 88% / 72% | 88% / 95% |
| Owner accuracy (where the walk-through names the owner) | 67% | 67% |
| Steps invented from the problem statement ↓ / customer actions as steps ↓ | 6 / 7 | 0 / 0 |
| **Redundant questions ↓** (stated, but not extracted) | 62% | 38% |
| **Premature assessments ↓** *(guaranteed by the gate)* | 0 of 40 | 0 of 40 |
| Cases assessable after the scripted interview | 19/20 | 17/20 *(see below)* |
| Friction recall: rule-detectable categories / Claude-only categories | 61% / 0 of 8 | 64% / 0 of 8 |
| **Unlabeled-finding rate ↓** | 48% (28 of 41 rest on the scripted "I don't know") | 41% (22 of 30) |
| **Findings on healthy workflows ↓** | 9 (5 scripted) | 6 (all scripted) |
| **Overclaiming ↓** (expected tentative, reported confirmed) | 0 of 6 | 0 of 6 |
| **AI recommended where not warranted ↓** / missed where warranted | 1 of 13 / 2 of 6 | 1 of 11 / 1 of 6 |
| **Correction invariant violations ↓** *(guaranteed by design)* | 0 of 2050 | 0 of 1802 |

**What this shows:**
- **The controls hold.** There are no premature assessments, no stale or invalid reports, and no disputed or tentative-only findings behind an action.
- **The no-key interpreter is the weak part.** On unseen cases (Run 1) it missed much of what users stated plainly and produced some false findings. The fixes removed specific false positives (invented steps, customer actions as steps, handled waits, double-counted tools), but owner extraction is unchanged.
- **Cases assessable fell from 19 to 17 in Run 2.** In two cases, Run 1 had counted a customer action as a second step; with that fixed, only one real step is understood. Ilsa doesn't ask the walk-through twice, so those assessments stay blocked until steps are added in review.
- **Where "scripted" comes from:** many unlabeled findings follow from the evaluation's scripted interviewee answering "I don't know" to owner questions the interpreter shouldn't have needed to ask.
- **Caveats:** the rules' author wrote the cases and labels, and 20 cases is a small sample.

## Designed failure cases

| Failure | What happens |
| --- | --- |
| Premature recommendation | A vague complaint, or "just tell me which CRM to buy", gets a discovery question. The assessment stays locked, with explicit blockers. |
| Unsupported diagnosis | A finding with an invented quote, a real but unlinked quote, or a linked quote that doesn't show the problem is rejected. It's kept only in the audit view. |
| Contradictory correction | The user corrects what Ilsa extracted. Findings that lose support disappear, recommendations lose that lineage or disappear, and the assessment regenerates. An outdated report is never shown as current. |
| Model/API unavailable | Any Claude failure falls back to the no-key interpreter. Saved assessments and the sample keep working. |

## Key engineering decisions

- **Interpreters propose; code decides.** The no-key rules and Claude go through the same merge rules and friction gate, so the controls don't depend on which one ran.
- **Evidence is the unit of truth.** Every fact and finding cites exact quotes, and evidence is append-only.
- **Four certainty states, never collapsed.** Hedges become *inferred*, "doesn't exist" is *absent*, "I don't know" is recorded as explicitly unknown, and nothing is assumed.
- **A readiness gate, not a confidence score.** Recommendations unlock on explicit criteria, and the blockers are listed.
- **Recommendations come from a fixed catalog that prefers the smallest fix,** and every entry says why AI isn't needed. AI is offered only for free-form intake, with a stated reason.
- **Small stack:** Node's built-in `node:sqlite`, `node:http` and `node:test`, and a no-framework UI. The only runtime dependency is the Anthropic SDK, used only when a key is set.

## Known issues

Found in the evaluation and the skeptical review ([`eval/README.md`](eval/README.md)). Fixes 1–5 from that review are in; everything below is still open.

**Issues with the no-key interpreter:**
- **It still often misses stated triggers, completion conditions and owners,** so Ilsa asks again (38% redundant questions after the fixes; 62% on the held-out run).
- **A few verbs are missing** ("inspects", "counts", "moves", "delivers", "listens"), and owners after an opening phrase are missed ("After the tour, Nora…").
- **Long free-text owner answers aren't understood** ("Nobody, the helpdesk system does it automatically."), which blocks that case.
- **The walk-through question is asked only once.** If fewer than two steps are understood, the assessment stays blocked until steps are added in review (2 of 20 cases after the fixes).
- **Passive sentences that start with the customer are skipped** ("Customers are then emailed a quote by Dana"), a side effect of fix 2.
- **A wait described with a reminder or alert is trusted as handled** (fix 3), even if nobody acts on the alert.

**False positives and restraint:**
- **"we" as a step owner counts as unclear ownership.** That's debatable.
- **Paper or email intake is sometimes called unstructured intake.** That's debatable.
- **The AI-or-not decision is a word check on the trigger.** It still misses "call the front desk", and over-fires on phone bookings.
- **Support checks show a problem is consistent with what was said,** not that it's the cause.

**Privacy and cost:**
- Data is local, unencrypted SQLite. The append-only evidence log and the lack of a delete function mean nothing is ever removed.
- With a key, answers are sent to Anthropic (see above), at about 2 calls per answer.

**Scope limits of the prototype:**
- no login (it binds to localhost)
- edits use browser prompt dialogs
- the UI has no automated browser tests (it was verified by hand)
- Claude has not been run live

## Author

**Billy VanVorst**
Applied AI Systems & Automation
Founder, bVan! Systems

MIT licensed. See [LICENSE](LICENSE).
