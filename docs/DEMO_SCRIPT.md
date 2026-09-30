# 60-second demo script

**Setup:**
- Run `npm start` and open http://localhost:3100 in a window at least 1280px wide.
- No API key; the header should say "No AI service is being called."
- For a clean recording, start from an empty data folder.

| Time | Do | Say (optional, short) | Viewer sees |
| --- | --- | --- | --- |
| 0:00 | Click **Try the sample (guided)** | "An owner says: we keep losing new customer inquiries." | The first question, "Walk me through what happens…", with *Why this matters*. The assessment says *Recommendations are locked*. |
| 0:07 | **Use sample answer** → **Answer** | "Ilsa maps what they said, and only what they said." | Five steps on the map, provisional findings, and Readiness listing ✕ blockers. The next question is about how an inquiry is finished. |
| 0:16 | Click **Load finished sample** | "Same pipeline, all the answers." | A green **Current assessment · based on revision 14**, with four sections. |
| 0:22 | In Findings, F8 *Information loss (S3 → S4)* → **Show evidence** | "Every finding quotes the owner." | The quoted answer, with its evidence ID: "The owner texts the technician the customer name." |
| 0:28 | Map, step 4 **How it arrives** → **Correct** → type "The owner assigns it in the spreadsheet and the technician works from there." | "They correct Ilsa." | **What changed:** F8 removed · "Hand work over…" now traces to F7 only · assessment regenerated. The field shows *User changed* with *Ilsa had: …* |
| 0:42 | F9 (*Needs confirmation*, dashed amber) → **Accurate** | "Unconfirmed findings can only say 'confirm first' until a human confirms them." | F9 becomes *User confirmed*. The "Confirm first" recommendation is replaced by an actionable one. |
| 0:50 | Scroll to **Recommendations** | "Smallest fix first. AI only where it's actually needed." | Intervention labels, *traces to F…*, and "Why not AI: …" on each. No AI recommendation, because intake is already a web form. |

**If there's time:**
- Move a step with ↑. The assessment turns **OUTDATED** (dashed and striped) until the reopened handoffs are answered or marked unknown.
- Open **Audit & details** to show the revision history and the append-only evidence log.
