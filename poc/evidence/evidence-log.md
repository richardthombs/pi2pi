# Evidence Log

## Purpose
Capture concrete evidence from the PoC as it is run. Prefer observations tied to the hypothesis over general implementation notes.

## Evidence to collect
- Feature request used
- Comparison mode(s) used
- Agent roles used
- Delegation flow summary
- Final outputs from each mode
- Human interaction count / intervention notes
- Observations about specialist value
- Observations about lead focus and synthesis quality
- Token-usage observations
- Observations about whether repeated delegation helped
- Notable surprises, breakdowns, or limitations
- Recommendation: proceed, iterate, or stop

---

## Entry 0 — Pre-experiment baseline
- **Date:** 2026-06-06
- **Status:** No experiment run yet
- **What we have:** PoC definition and experiment plan only
- **Current hypothesis:**
  1. A long-lived team of distinct specialists will outperform a single agent that assumes multiple skills via instruction files.
  2. A dedicated lead will stay more focused on the overall goal than an all-in-one agent.
  3. Persistent/contextful delegation will outperform fresh/contextless delegation.
- **Primary desired outcomes:** higher quality result and lower token usage
- **What remains to collect:** All execution evidence

## Entry 1 — Direction review against updated definition
- **Date:** 2026-06-12
- **Status:** Review complete, still pre-experiment
- **What criterion has been satisfied:** The PoC is now more sharply framed around the comparison the user actually cares about.
- **Evidence:**
  - `definition.md` specifies the updated problem, decision, comparative hypotheses, scope, and non-goals.
  - `experiment-plan.md` defines the smallest useful comparative test and explicit success/failure criteria.
  - `decision-log.md` records the shift away from a purely single-arm framing.
- **What has not yet been satisfied:** No execution-based success criteria have evidence yet.
- **Interpretation:** This is still learning in the form of clearer framing, but not yet proof of the concept.
- **Recommended next evidence:** One comparative run on a small real feature-delivery task.
