# Experiment Plan

## Smallest Useful Test
Run one lightweight real feature-delivery scenario with a minimal long-lived agent team:

1. A human gives one feature request at a high level.
2. A manager agent interprets the request and delegates work to 2–3 specialist agents.
3. Specialist agents return role-specific outputs.
4. The manager synthesizes the outputs into a concise summary, outcome view, and recommended next steps for the human.

## Suggested minimal roles
- **Manager agent** — owns task interpretation, delegation, and final synthesis.
- **Planner / product-thinking agent** — clarifies intent, scope, and acceptance shape.
- **Implementation agent** — proposes or performs technical work.
- **Reviewer / QA agent** — checks risk, gaps, or quality concerns.

The exact specialist set can be reduced to 2 roles if that keeps the trial smaller.

## What must be real
- A genuine small software feature-delivery task.
- A real delegation flow between manager and specialists.
- A real final synthesis presented back to the human.

## What can be lightweight, mocked, or minimal
- Specialist sophistication.
- Persistence and memory infrastructure.
- Reliability plumbing beyond what is needed to run the experiment.
- Metrics collection, as long as observations are captured clearly.

## Why this is the smallest useful test
This test directly exercises the core claim:
- the human can stay abstracted from low-level coordination
- specialist delegation adds differentiated value
- manager synthesis reduces cognitive load

It avoids premature productization around generalized orchestration or platform features.

## Success Criteria
The PoC is successful if:

1. **High-level human interaction is preserved**
   - The human provides the task and at most limited clarification.
   - The manager handles most low-level coordination internally.

2. **Delegation produces distinct specialist value**
   - Specialist outputs are role-specific and meaningfully different.
   - Delegation is not just superficial message passing.

3. **The manager synthesis is useful**
   - It gives a concise, digestible view of what happened.
   - It reduces the need for the human to inspect raw exchanges.
   - It identifies outcome, open questions, and recommended next steps.

4. **The structure appears worth deeper investigation**
   - The result feels at least plausibly better than simply prompting one agent directly.
   - The user's team or collaborators can see enough promise to justify a follow-on PoC.

## Failure Criteria
Treat the PoC as failed or not yet persuasive if:

1. The human still has to micromanage specialist steps.
2. Delegation adds little value and a single agent would likely suffice.
3. The manager summary is confusing, lossy, or not decision-useful.
4. Plumbing and framework complexity become the main work.
5. The result is too weak to justify a later comparative PoC.

## Stop Condition
Stop when any of these is true:

1. One credible end-to-end demonstration has been completed and there is enough evidence to judge merit.
2. The manager-led structure does not materially reduce low-level human involvement or improve synthesized outcomes.
3. Work starts drifting into generalized platform building rather than answering the PoC question.

## Evidence to Capture
- The exact feature request used.
- Roles used in the agent team.
- Delegation flow or transcript summary.
- Final manager synthesis.
- Observations on human abstraction level.
- Observations on specialist usefulness.
- Observations on cognitive load and clarity.
- Recommendation: proceed, iterate, or stop.

## Recommended execution sequence
1. Pick one small real feature-delivery task.
2. Define the manager and specialist roles.
3. Run one end-to-end trial.
4. Record outputs and observations.
5. Decide whether to proceed to a stronger comparison PoC.
