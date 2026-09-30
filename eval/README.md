# Evaluation

## Protocol (fixed before the first run)

- **Cases:** [`cases.json`](cases.json), 20 hand-written, sanitized workflow descriptions from 20 different small businesses: 16 with friction and 4 healthy workflows where the correct result is "no problems found". Each case has a problem statement, a walk-through, a scripted interviewee's answers to follow-up questions, and labels: expected steps (and owners where the walk-through names one), phrases that must not become steps, dimensions the walk-through states, expected friction categories with confirmed/tentative status, and whether an AI recommendation is warranted.
- **Separation:** none of these cases, businesses or sentences were used while building the rules. The examples used during development are the plumbing sample (`src/sample.ts`) and the test scenarios in `test/`.
- **Author:** the cases and labels were written by the same author as the rules. That is a real limitation (see below), which is why the rules are frozen: the results are reported from a single run, and the rules are not changed afterwards to improve them. Bugs in the evaluation harness itself may be fixed and are listed in the run log.
- **What is measured:** the no-key interpreter and the deterministic controls. **Claude is not evaluated** (no live API run).
- **Reproduce:** `npm run eval`. Deterministic: no network, no randomness except the seeded correction simulation.

Results and every miss: [`results/eval.md`](results/eval.md).

## Run log

- **Run 1 (2026-09-30):** single run against the frozen rules, cases committed beforehand. Results in [`results/eval.md`](results/eval.md).
- **After the run,** two analysis breakdowns were added to the report. They are clearly marked, and no metric changed:
  - friction recall split by whether the no-key rules can detect the category
  - how many unlabeled findings rest on the scripted interviewee's default answer "I don't know."

  Re-running produced identical numbers; the evaluation is deterministic.
- **The rules were not changed after the run.** Weaknesses it exposed are listed in the main README under "Known issues", rather than fixed, so these numbers stay an honest measurement of the rules as they were before anyone saw the cases.

## What the scripted interviewee does, and why it matters

Ilsa asks questions; a scripted interviewee answers from each case's `answers`. Anything the case did not script is answered **"I don't know."**, the most conservative choice: it never invents facts. The side effect is that when the interpreter misses a fact the walk-through did state (for example an owner), the interviewee then claims not to know it, and Ilsa correctly treats that as "the user does not know who owns this step". The results report how many findings rest on that answer.

## Limitations

- Same author for rules, cases and labels; 20 cases; one person's labels.
- Labels are at category level: a finding counts if its category matches, regardless of which steps it cites.
- Scripted answers are cleaner than real conversation.
- Nothing here measures Claude.
