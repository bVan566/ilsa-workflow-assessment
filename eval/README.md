# Evaluation

## Protocol (fixed before the first run)

- **Cases:** [`cases.json`](cases.json), 20 hand-written, sanitized workflow descriptions from 20 different small businesses: 16 with friction and 4 healthy workflows where the correct result is "no problems found". Each case has a problem statement, a walk-through, a scripted interviewee's answers to follow-up questions, and labels: expected steps (and owners where the walk-through names one), phrases that must not become steps, dimensions the walk-through states, expected friction categories with confirmed/tentative status, and whether an AI recommendation is warranted.
- **Separation:** none of these cases, businesses or sentences were used while building the rules. The examples used during development are the plumbing sample (`src/sample.ts`) and the test scenarios in `test/`.
- **Author:** the cases and labels were written by the same author as the rules. That is a real limitation (see below), which is why Run 1 was made against frozen rules. Any later change is reported as a separate run, clearly marked as not held-out. Bugs in the evaluation harness itself may be fixed and are listed in the run log.
- **What is measured:** the no-key interpreter and the deterministic controls. **Claude is not evaluated** (no live API run).
- **Reproduce:** `npm run eval`. Deterministic: no network, no randomness except the seeded correction simulation.

Two runs, kept separate:

| Run | What it is | Results |
| --- | --- | --- |
| **Run 1: held-out** | Rules frozen before the cases were seen. **This is the honest measurement of generalization.** | [`results/run1-heldout.md`](results/run1-heldout.md) (reproduce: `git checkout c0260a7 && npm run eval`) |
| **Run 2: post-review, NOT held-out** | The same cases, after five fixes made *because of* Run 1. It shows the effect of those fixes on known cases, and is likely optimistic. | [`results/run2-post-review.md`](results/run2-post-review.md) (reproduce: `npm run eval`) |

## Run log

- **Run 1 (2026-09-30):** single run against the frozen rules, cases committed beforehand.
  - Afterwards, two analysis breakdowns were added to the report, clearly marked, with no metric changed: friction recall split by whether the no-key rules can detect the category, and how many unlabeled findings rest on the scripted default answer "I don't know."
  - Re-running produced identical numbers; the evaluation is deterministic.
- **Review:** the skeptical review of Run 1 proposed six fixes. Fixes 1–5 were approved and made (commit `45ea72c`); fix 6 (missing verbs and owner phrasing) was not.
  1. Steps are never created from the opening problem statement. This applies to every interpreter, in `src/merge.ts`.
  2. A sentence whose subject is the customer ("Clients call…") is not a step. It's offered as the trigger instead (no-key interpreter).
  3. A wait described as already handled (reminder, alert, automatic tracking) is not flagged as friction.
  4. Compound tool names ("paper calendar") count as one tool.
  5. Handoffs next to a step whose owner is unknown are now explored. Only the same known owner on both sides rules a handoff out.
- **Run 2 (2026-09-30):** the same cases and harness, after the fixes. The harness now writes `run2-post-review.*`; Run 1's file is unchanged apart from a banner.

## Run 1 vs Run 2

| Metric | Run 1: held-out | Run 2: post-review, not held-out |
| --- | --- | --- |
| Step extraction recall ↑ | 52/59 (88%) | 52/59 (88%) |
| Step extraction precision ↑ | 52/72 (72%) | 52/55 (95%) |
| Owner accuracy ↑ | 18/27 (67%) | 18/27 (67%) |
| Customer actions extracted as steps ↓ | 7 | 0 |
| Steps invented from the problem statement ↓ | 6 | 0 |
| **Redundant questions ↓** | 23/37 (62%) | 14/37 (38%) |
| Missing foundational dimensions asked about ↑ | 104/110 (95%) | 98/101 (97%) |
| **Premature assessments ↓** | 0 of 40 | 0 of 40 |
| Cases assessable after the scripted interview | 19/20 (95%) | 17/20 (85%) |
| Friction recall, rule-detectable categories ↑ | 37/61 (61%) | 39/61 (64%) |
| Friction recall, Claude-only categories | 0/8 | 0/8 |
| **Unlabeled-finding rate ↓** | 41/85 (48%), 28 on the scripted "I don't know" | 30/73 (41%), 22 on the scripted "I don't know" |
| **Findings on healthy workflows ↓** | 9 (5 on the scripted "I don't know") | 6 (all 6 on the scripted "I don't know") |
| **Overclaiming ↓** | 0 of 6 | 0 of 6 |
| **AI where not warranted ↓** | 1 of 13 | 1 of 11 |
| AI missed where warranted | 2 of 6 | 1 of 6 |
| **Correction invariant violations ↓** | 0 of 2050 | 0 of 1802 |

**One regression.** Cases assessable fell from 19 to 17. In ev-10 and ev-13, Run 1 counted a customer action as a second workflow step. With fix 2, the no-key interpreter finds only one real step, and Ilsa does not ask the walk-through question twice. The assessment therefore stays blocked at "describe at least two steps" until steps are added in review. Run 1's assessability in those two cases rested on a misparse. Nothing incorrect is produced; the gap is that Ilsa does not re-ask.

## What the scripted interviewee does, and why it matters

Ilsa asks questions; a scripted interviewee answers from each case's `answers`. Anything the case did not script is answered **"I don't know."**, the most conservative choice: it never invents facts. The side effect is that when the interpreter misses a fact the walk-through did state (for example an owner), the interviewee then claims not to know it, and Ilsa correctly treats that as "the user does not know who owns this step". The results report how many findings rest on that answer.

## Limitations

- Same author for rules, cases and labels; 20 cases; one person's labels.
- Labels are at category level: a finding counts if its category matches, regardless of which steps it cites.
- Scripted answers are cleaner than real conversation.
- Nothing here measures Claude.
