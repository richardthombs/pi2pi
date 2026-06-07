# POC Artifact Set

This directory contains the canonical artifacts for a single proof of concept.

## Current POC
**Reliable agent-to-agent collaboration via long-lived agents**

This PoC is testing whether there is enough merit in a **long-lived, manager-led collaborating agent team** to justify further investment and a later comparison against traditional **ephemeral sub-agent workflows**.

## Status
- Stage: Definition complete, experiment not yet run
- Mode: Planning/setup with direction review complete
- Current recommendation: Run the smallest useful test before building broader framework capabilities
- Latest review outcome: The POC is well-framed and bounded, but still has no execution evidence

## Artifacts
- [`definition.md`](./definition.md) — problem, stakeholder, hypothesis, decision, scope, constraints, non-goals
- [`experiment-plan.md`](./experiment-plan.md) — smallest useful test, success/failure criteria, stop condition, evidence plan
- [`progress-review.md`](./progress-review.md) — current status, what is known, what remains uncertain
- [`decision-log.md`](./decision-log.md) — key decisions made so far and why
- [`session-handoff.md`](./session-handoff.md) — context for the next session
- [`evidence/evidence-log.md`](./evidence/evidence-log.md) — evidence captured during execution
- [`deck/slides.md`](./deck/slides.md) — living reveal.js deck plan for the current POC stage
- [`final-report.md`](./final-report.md) — closure report stub for when the PoC is complete

## Snapshot
- **Problem:** Humans may be forced to manage too much low-level coordination in complex software-delivery work.
- **Question:** Does a long-lived collaborating agent team show enough practical merit to justify deeper investment?
- **Primary value being tested:**
  1. The human can stay at a higher level of abstraction.
  2. Delegation plus synthesis produces useful practical outcomes.
- **Smallest useful test:** One lightweight real feature-delivery task with a manager agent delegating to 2–3 specialist agents and returning a synthesized summary to the human.

## Immediate next steps
1. Choose one small real feature-delivery task.
2. Define the minimal team structure and interaction rules.
3. Run one end-to-end trial and record evidence.

## Current review summary
- **Satisfied so far:** clear definition, bounded experiment plan, and explicit guardrails against drift
- **Not yet satisfied:** any execution-based success criterion
- **What to avoid next:** generalized framework work, memory systems, reliability/productization work before the first trial
