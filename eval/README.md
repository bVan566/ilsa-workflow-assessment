# Evaluation

## Protocol (fixed before the first run)

- **Cases:** [`cases.json`](cases.json), 20 hand-written, sanitized workflow descriptions from 20 different small businesses: 16 with friction and 4 healthy workflows where the correct result is "no problems found". Each case has a problem statement, a walk-through, a scripted interviewee's answers to follow-up questions, and labels: expected steps (and owners where the walk-through names one), phrases that must not become steps, dimensions the walk-through states, expected friction categories with confirmed/tentative status, and whether an AI recommendation is warranted.
- **Separation:** none of these cases, businesses or sentences were used while building the rules. The examples used during development are the plumbing sample (`src/sample.ts`) and the test scenarios in `test/`.
- **Author:** the cases and labels were written by the same author as the rules. That is a real limitation (see below), which is why the rules are frozen: the results are reported from a single run, and the rules are not changed afterwards to improve them. Bugs in the evaluation harness itself may be fixed and are listed in the run log.
- **What is measured:** the no-key interpreter and the deterministic controls. **Claude is not evaluated** (no live API run).
- **Reproduce:** `npm run eval`. Deterministic: no network, no randomness except the seeded correction simulation.

Results and every miss: [`results/eval.md`](results/eval.md).

## Run log

(Filled in after the run.)
