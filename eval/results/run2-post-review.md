# Evaluation results: Run 2 (post-review, NOT held-out)

> Same 20 cases as Run 1, after five fixes made in response to Run 1 (see eval/README.md). The cases had already been seen, so this is **not** a held-out result: it shows the effect of the fixes on known cases, and is likely optimistic. The original held-out result is [run1-heldout.md](run1-heldout.md).

20 hand-written cases (16 with friction, 4 healthy), no-key interpreter and deterministic controls. **Claude is not evaluated.** ↑ higher is better, ↓ lower is better.

## Summary

| Area | Metric | Result |
| --- | --- | --- |
| Step extraction (walk-through only) | Recall ↑ (labeled steps found) | 52/59 (88%) |
| | Precision ↑ (extracted steps that are labeled steps) | 52/55 (95%) |
| | Owner accuracy ↑ (where the walk-through names the owner) | 18/27 (67%) |
| | Customer actions wrongly extracted as steps ↓ | 0 |
| Clarification | First response is a discovery question, not a solution ↑ | 20/20 (100%) (steps invented from the problem statement: 0) |
| | Missing foundational dimensions asked about or established ↑ | 98/101 (97%) |
| | **Redundant questions ↓** (stated in the walk-through, but not extracted, so asked again) | 14/37 (38%) |
| Restraint | **Premature assessments ↓** (generated from the problem statement or walk-through alone) | 0 of 40 attempts |
| | Cases assessable after the scripted interview | 17/20 (85%) |
| Friction | Recall ↑ (labeled findings detected, by category) | 39/69 (57%) |
| | **Unlabeled-finding rate ↓** (live findings in a category the labels do not include) | 30/73 (41%) |
| | **Findings on healthy workflows ↓** | 6 across 4 healthy cases |
| | Findings whose evidence still passes the gate when re-checked ↑ | 73/73 (100%) |
| Confirmed vs tentative | Expected confirmed → reported confirmed ↑ | 27/33 (82%) |
| | **Overclaiming ↓** (expected tentative → reported confirmed) | 0 of 6 matched tentative labels |
| Recommendation restraint | **AI recommended where not warranted ↓** | 1 of 11 assessed cases |
| | AI not recommended where warranted | 1 of 6 assessed cases |
| | Recommendations rejected by the report validator ↓ | 0 |
| | "Act" recommendations citing a tentative finding ↓ | 0 |
| Correction / regeneration | **Invariant violations ↓** (8 seeded review actions × 3 seeds per assessable case) | 0 of 1802 checks |

### Breakdowns added after the run (analysis only; no metric above was changed)

- Friction recall on categories the no-key rules can detect: 39/61 (64%). On categories only Claude could propose (bottleneck, duplicate work, inconsistent decisions, customers chasing): 0/8 (0%), as expected with no key.
- Unlabeled findings that rest on the scripted interviewee's default answer "I don't know." (given to any question the case did not script, typically "who owns this step?" after the interpreter missed an owner the walk-through named): 22 of 30. Ilsa handled that answer as designed ("the user did not know" supports unclear ownership), but a real user would usually have named the owner. The remaining 8 are listed per case and include genuine false positives.
- Findings on healthy workflows that rest on the scripted "I don't know.": 6 of 6.

## How to read these numbers

- Premature assessments, "act on tentative", validator rejections and invariant violations are **guaranteed by design** (the gate and validator are code). The evaluation confirms the design holds on these inputs; it is not evidence of intelligence.
- Step extraction, redundant questions and friction recall measure the **no-key interpreter**, which is a set of word lists. These are the numbers a better interpreter (for example Claude) would need to beat; that comparison has not been run.
- "Unlabeled findings" are findings in categories the labels did not include. Each one is listed below. Some may be defensible, so this is a candidate false-positive rate, not a verified one.
- Friction recall is measured by category: a finding counts if its category matches, regardless of which steps it cites.

## Per case

| Case | Steps found | Extra / not-steps | Redundant Qs | Questions | Assessable | Findings found | Unlabeled | AI rec (warranted?) | Correction violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ev-01 Dental clinic, appointment requests | 2/3 | 0 / 0 | exceptions | 10 | yes | 2/4 | 0 | yes (yes) | 0 |
| ev-02 Landscaping, quote requests | 3/4 | 0 / 0 | — | 11 | yes | 5/6 | 0 | no (no) | 0 |
| ev-03 Bakery, custom cake orders | 2/2 | 0 / 0 | completion | 10 | yes | 3/5 | 1 | yes (yes) | 0 |
| ev-04 Accounting firm, new client onboarding | 3/3 | 0 / 0 | waiting | 12 | yes | 1/2 | 2 | no (no) | 0 |
| ev-05 Small office IT helpdesk (healthy) | 3/3 | 0 / 0 | completion, ownership | 13 | **no** | 0/0 | 1 | — | — |
| ev-06 Auto repair shop, estimates | 2/3 | 0 / 0 | — | 10 | yes | 2/5 | 3 | no (no) | 0 |
| ev-07 Property management, maintenance requests | 3/3 | 0 / 0 | completion | 13 | yes | 4/5 | 2 | yes (yes) | 0 |
| ev-08 Catering, event inquiries | 2/2 | 1 / 0 | waiting, completion | 10 | yes | 3/5 | 2 | yes (yes) | 0 |
| ev-09 Law firm, potential client intake | 4/4 | 0 / 0 | — | 13 | yes | 5/5 | 1 | no (yes) | 0 |
| ev-10 Gym, membership cancellations | 1/2 | 0 / 0 | — | 5 | **no** | 1/4 | 1 | — | — |
| ev-11 Print shop, proof approvals | 3/3 | 1 / 0 | completion | 13 | yes | 1/1 | 5 | no (no) | 0 |
| ev-12 HVAC company, service calls (hedged answers) | 3/3 | 1 / 0 | — | 20 | yes | 3/4 | 3 | no (no) | 0 |
| ev-13 Design studio, project requests (healthy) | 1/2 | 0 / 0 | completion, ownership | 7 | **no** | 0/0 | 0 | — | — |
| ev-14 Restaurant, supplier reorders | 2/4 | 0 / 0 | trigger | 9 | yes | 2/4 | 1 | no (no) | 0 |
| ev-15 Veterinary clinic, prescription refills | 3/3 | 0 / 0 | — | 11 | yes | 2/5 | 0 | yes (yes) | 0 |
| ev-16 Cleaning company, job scheduling | 3/3 | 0 / 0 | — | 10 | yes | 1/5 | 2 | yes (no) | 0 |
| ev-17 Event venue, booking inquiries (healthy) | 4/4 | 0 / 0 | ownership | 12 | yes | 0/0 | 3 | no (no) | 0 |
| ev-18 Insurance agency, claim help | 2/2 | 0 / 0 | — | 10 | yes | 1/5 | 1 | no (no) | 0 |
| ev-19 Tutoring service, sign-ups | 3/3 | 0 / 0 | — | 12 | yes | 3/4 | 0 | no (no) | 0 |
| ev-20 Online store, returns (healthy) | 3/3 | 0 / 0 | completion | 14 | yes | 0/0 | 2 | no (no) | 0 |

## Misses and weak cases

**ev-01 Dental clinic, appointment requests**
- missed steps: "listens to the voicemails"
- stated but not extracted (asked again): exceptions
- missing dimensions never asked: handoffs
- missed findings: missing_exception_handling (confirmed), manual_reentry (confirmed)
- status mismatches: unstructured_intake expected confirmed, got tentative

**ev-02 Landscaping, quote requests**
- missed steps: "measures the yard"
- missed findings: manual_reentry (confirmed)
- status mismatches: missing_terminal_condition expected confirmed, got tentative

**ev-03 Bakery, custom cake orders**
- owner misses: "checks the order book": expected Priya, got unknown
- stated but not extracted (asked again): completion
- missed findings: manual_reentry (confirmed), missing_exception_handling (confirmed)
- unlabeled findings: unclear_ownership [confirmed] S2: asked who owns S2; the user did not know (rests on the scripted "I don't know.")

**ev-04 Accounting firm, new client onboarding**
- owner misses: "approves the file": expected partner, got unknown
- stated but not extracted (asked again): waiting
- missed findings: manual_reentry (confirmed)
- unlabeled findings: unclear_ownership [confirmed] S3: asked who owns S3; the user did not know (rests on the scripted "I don't know.") | unstructured_intake [confirmed] S1: work arrives by email and is re-keyed by hand later

**ev-05 Small office IT helpdesk (healthy)**
- owner misses: "marks the ticket resolved": expected Sam, got unknown
- stated but not extracted (asked again): completion, ownership
- not assessable; blockers: S1.owner: uninterpreted
- unlabeled findings: unclear_ownership [confirmed] S3: asked who owns S3; the user did not know (rests on the scripted "I don't know.")

**ev-06 Auto repair shop, estimates**
- missed steps: "inspects the car"
- missed findings: repeated_customer_followup (confirmed), manual_reentry (confirmed), missing_exception_handling (confirmed)
- unlabeled findings: unclear_ownership [confirmed] S1: asked who owns S1; the user did not know (rests on the scripted "I don't know.") | unclear_ownership [confirmed] S2: asked who owns S2; the user did not know (rests on the scripted "I don't know.") | unstructured_intake [confirmed] S1: work arrives by paper or whiteboard and is re-keyed by hand later

**ev-07 Property management, maintenance requests**
- owner misses: "schedules a visit": expected contractor, got unknown; "sends an invoice": expected contractor, got unknown
- stated but not extracted (asked again): completion
- missed findings: repeated_customer_followup (confirmed)
- unlabeled findings: unclear_ownership [confirmed] S2: asked who owns S2; the user did not know (rests on the scripted "I don't know.") | unclear_ownership [confirmed] S3: asked who owns S3; the user did not know (rests on the scripted "I don't know.")
- status mismatches: unstructured_intake expected confirmed, got tentative

**ev-08 Catering, event inquiries**
- unlabeled extra steps: "Nobody tracks which quotes were accepted"
- stated but not extracted (asked again): waiting, completion
- missed findings: missing_terminal_condition (confirmed), tool_switching (confirmed)
- unlabeled findings: unclear_ownership [confirmed] S3: asked who owns S3; the user did not know (rests on the scripted "I don't know.") | information_loss [tentative] S2,S3: asked how work reaches S3; the user did not know (rests on the scripted "I don't know.")
- status mismatches: unstructured_intake expected confirmed, got tentative

**ev-09 Law firm, potential client intake**
- owner misses: "checks the website inquiries": expected paralegal, got unknown
- unlabeled findings: unclear_ownership [confirmed] S2: asked who owns S2; the user did not know (rests on the scripted "I don't know.")
- status mismatches: unstructured_intake expected confirmed, got tentative
- AI warranted but not recommended

**ev-10 Gym, membership cancellations**
- missed steps: "cancels the membership"
- missing dimensions never asked: handoffs
- not assessable; blockers: sequence: too_few_steps
- missed findings: bottleneck (confirmed), repeated_customer_followup (confirmed), missing_exception_handling (confirmed)
- unlabeled findings: unstructured_intake [tentative] S1: work arrives by email

**ev-11 Print shop, proof approvals**
- unlabeled extra steps: "We wait for the customer to reply with approval"
- owner misses: "sends the job": expected Kim, got unknown
- stated but not extracted (asked again): completion
- unlabeled findings: unclear_ownership [confirmed] S2: S2 owner is "we (no specific person)" | information_loss [tentative] S1,S2: asked how work reaches S2; the user did not know (rests on the scripted "I don't know.") | unclear_ownership [confirmed] S3: asked who owns S3; the user did not know (rests on the scripted "I don't know.") | unclear_ownership [confirmed] S4: asked who owns S4; the user did not know (rests on the scripted "I don't know.") | unstructured_intake [tentative] S1: work arrives by email

**ev-12 HVAC company, service calls (hedged answers)**
- unlabeled extra steps: "I think most calls come in through the answering service"
- missed findings: missing_exception_handling (tentative)
- unlabeled findings: unclear_ownership [confirmed] S1: asked who owns S1; the user did not know (rests on the scripted "I don't know.") | unclear_ownership [confirmed] S2: asked who owns S2; the user did not know (rests on the scripted "I don't know.") | information_loss [tentative] S1,S2: asked how work reaches S2; the user did not know (rests on the scripted "I don't know.")

**ev-13 Design studio, project requests (healthy)**
- missed steps: "moves the card to Done"
- stated but not extracted (asked again): completion, ownership
- missing dimensions never asked: handoffs
- not assessable; blockers: sequence: too_few_steps

**ev-14 Restaurant, supplier reorders**
- missed steps: "counts the walk-in", "delivers on Wednesday"
- stated but not extracted (asked again): trigger
- missed findings: inconsistent_decision (confirmed), missing_exception_handling (confirmed)
- unlabeled findings: unstructured_intake [confirmed] S1: work arrives by paper or whiteboard and is re-keyed by hand later

**ev-15 Veterinary clinic, prescription refills**
- missed findings: manual_reentry (confirmed), bottleneck (confirmed), single_point_of_failure (confirmed)
- status mismatches: unstructured_intake expected confirmed, got tentative

**ev-16 Cleaning company, job scheduling**
- owner misses: "copies the online bookings": expected Rosa, got unknown
- missed findings: duplicate_work (confirmed), manual_reentry (confirmed), single_point_of_failure (tentative), manual_status_checking (confirmed)
- unlabeled findings: tool_switching [confirmed] S1: S1 uses paper or whiteboard, phone | unstructured_intake [confirmed] S1: work arrives by paper or whiteboard, phone and is re-keyed by hand later
- AI recommended but not warranted

**ev-17 Event venue, booking inquiries (healthy)**
- owner misses: "sends the contract": expected Nora, got unknown
- stated but not extracted (asked again): ownership
- unlabeled findings: unclear_ownership [confirmed] S3: asked who owns S3; the user did not know (rests on the scripted "I don't know.") | information_loss [tentative] S2,S3: asked how work reaches S3; the user did not know (rests on the scripted "I don't know.") | information_loss [tentative] S3,S4: asked how work reaches S4; the user did not know (rests on the scripted "I don't know.")

**ev-18 Insurance agency, claim help**
- missed findings: manual_reentry (confirmed), missing_terminal_condition (confirmed), repeated_customer_followup (confirmed), tool_switching (confirmed)
- unlabeled findings: unclear_ownership [confirmed] S1: asked who owns S1; the user did not know (rests on the scripted "I don't know.")

**ev-19 Tutoring service, sign-ups**
- missed findings: missing_exception_handling (confirmed)

**ev-20 Online store, returns (healthy)**
- stated but not extracted (asked again): completion
- unlabeled findings: unclear_ownership [confirmed] S3: asked who owns S3; the user did not know (rests on the scripted "I don't know.") | information_loss [tentative] S2,S3: asked how work reaches S3; the user did not know (rests on the scripted "I don't know.")

No correction/regeneration invariant was violated.

