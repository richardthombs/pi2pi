# POC Artifact Set

This directory contains the canonical artifacts for a single proof of concept.

## Current POC
**Distinct long-lived specialist agents vs a single skill-switching agent**

This PoC is now testing whether a **long-lived, manager-led team of distinct specialist agents** is better than a **single agent that assumes multiple skills over time via instruction/skill files**, and whether **contextful repeated delegation** beats **contextless delegation**.

## Status
- Stage: Definition updated, experiment not yet run
- Mode: Planning/setup with revised comparative hypothesis
- Current recommendation: Run the smallest useful comparative test before building broader framework capabilities
- Latest review outcome: The PoC is better targeted, but still has no execution evidence

## Artifacts
- [`definition.md`](./definition.md) — problem, stakeholder, hypothesis, decision, scope, constraints, non-goals
- [`experiment-plan.md`](./experiment-plan.md) — smallest useful test, success/failure criteria, stop condition, evidence plan
- [`progress-review.md`](./progress-review.md) — current status, what is known, what remains uncertain
- [`decision-log.md`](./decision-log.md) — key decisions made so far and why
- [`session-handoff.md`](./session-handoff.md) — context for the next session
- [`evidence/evidence-log.md`](./evidence/evidence-log.md) — evidence captured during execution
- [`final-report.md`](./final-report.md) — closure report stub for when the PoC is complete

## Snapshot
- **Problem:** A single agent may lose focus and context when it tries to combine orchestration, specialist thinking, and tool-heavy execution in one thread.
- **Question:** Does a team of distinct long-lived agents produce better software-delivery outcomes than a single skill-switching agent, and does persistent delegation help?
- **Primary value being tested:**
  1. distinct specialists outperform one skill-switching agent
  2. a focused lead preserves the overall goal better during execution
  3. contextful delegation improves quality and/or efficiency
  4. the human can stay at a higher level of abstraction
- **Primary outcomes:** result quality and token usage
- **Smallest useful test:** One lightweight real feature-delivery task run in comparative form, with at least a single-agent-skills baseline and a lead-plus-specialists team run.

## Immediate next steps
1. Choose one small real feature-delivery task.
2. Define the minimal comparison setup.
3. Run at least one single-agent baseline and one multi-agent team run.
4. Record quality and token-usage observations.

## Current review summary
- **Satisfied so far:** clearer comparative hypothesis, bounded scope, and explicit guardrails against drift
- **Not yet satisfied:** any execution-based evidence
- **What to avoid next:** generalized framework work, memory systems, reliability/productization work before the first comparative run
