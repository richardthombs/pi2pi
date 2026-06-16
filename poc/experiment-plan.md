# Experiment Plan

## Smallest Useful Test
Run one lightweight real feature-delivery scenario in comparative form:

1. A human gives one feature request at a high level.
2. The task is run in a **single-agent-with-skills** mode.
3. The same or closely equivalent task is run in a **team lead + specialists** mode.
4. Where possible, observe whether repeated delegation to the same specialist improves outcomes relative to fresh/contextless delegation.
5. Compare the outputs with a focus on quality, clarity, and token usage.

## Suggested minimal roles for the team run
- **Team lead** — owns task interpretation, delegation, coordination, and final synthesis.
- **Planner / product-thinking agent** — clarifies intent, scope, and acceptance shape.
- **Implementation agent** — proposes or performs technical work.
- **Reviewer / QA agent** — checks risk, gaps, and quality concerns.

The exact specialist set can be reduced if needed, but there should be enough distinction to test role separation meaningfully.

## Comparison modes
### Mode A: Single-agent with layered skills
- One agent performs planning, implementation, review, and synthesis.
- It may use `SKILL.md`-style instructions or equivalent prompt layering to assume different roles over time.

### Mode B: Long-lived team of distinct agents
- One lead delegates to specialists.
- Specialists perform their own part of the work and return focused outputs.
- The lead synthesizes the overall result.

### Optional Mode C: Contextless delegation baseline
- Fresh sub-agents or otherwise non-persistent delegates are used for specialist work.
- This is useful if it can be added cheaply without distracting from the main comparison.

## What must be real
- A genuine small software feature-delivery task.
- A real delegation flow in the team mode.
- A real single-agent baseline.
- A real final output that can be judged for usefulness and quality.

## What can be lightweight, mocked, or minimal
- Specialist sophistication.
- Reliability plumbing beyond what is needed to run the comparison.
- Precise benchmark instrumentation, as long as the token and quality observations are still captured honestly.

## Why this is the smallest useful test
This directly exercises the updated claims:
- distinct specialists may outperform one skill-switching agent
- a dedicated lead may preserve strategic focus better than an all-in-one agent
- persistent/contextful delegation may outperform fresh/contextless delegation

It avoids premature productization while still making the hypothesis falsifiable.

## Success Criteria
The PoC is successful if:

1. **The multi-agent team produces meaningfully better outcomes**
   - The final result is higher quality, more complete, or more robust than the single-agent baseline.
   - Specialist outputs are genuinely differentiated rather than decorative.

2. **The team lead remains usefully focused**
   - The lead's synthesis stays coherent and goal-oriented.
   - The lead does not appear to lose track of the overall objective while specialists do detailed work.

3. **Contextful delegation shows value**
   - Repeated delegation to the same specialist appears to improve efficiency, relevance, or quality.
   - There is at least directional evidence that retained context helps.

4. **Token usage is competitive or better**
   - The multi-agent approach does not obviously waste tokens relative to the value gained.
   - Ideally it shows lower total token use for equal or better quality, or a clearly favorable tradeoff.

5. **High-level human interaction is preserved**
   - The human provides the task and limited clarification.
   - The lead handles most low-level coordination internally.

## Failure Criteria
Treat the PoC as failed or not yet persuasive if:

1. The single-agent-with-skills approach performs just as well or better with less complexity.
2. Delegation is superficial and specialist outputs are not meaningfully distinct.
3. The lead still loses context or fails to provide a useful synthesis.
4. Persistent delegation shows no clear benefit over fresh/contextless delegation.
5. Token usage is materially worse without a corresponding quality gain.
6. Plumbing and framework complexity become the main work.

## Stop Condition
Stop when any of these is true:

1. One credible comparative run has been completed and there is enough evidence to judge whether the new hypothesis is promising.
2. The team-based structure shows no meaningful advantage over the single-agent baseline.
3. Work starts drifting into generalized platform building rather than answering the PoC question.

## Evidence to Capture
- The exact feature request used.
- Comparison mode(s) used.
- Roles used in the team run.
- Delegation flow or transcript summary.
- Final outputs from each mode.
- Token-usage observations.
- Observations on lead focus and synthesis quality.
- Observations on whether repeated delegation improved outcomes.
- Recommendation: proceed, iterate, or stop.

## Recommended execution sequence
1. Pick one small real feature-delivery task.
2. Define the single-agent baseline setup.
3. Define the minimal team setup.
4. Run the baseline.
5. Run the team mode.
6. Optionally run a cheap contextless-delegation variant.
7. Record outputs and observations.
8. Decide whether to proceed to a stronger comparison PoC.
