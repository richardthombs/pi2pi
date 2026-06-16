# Session Handoff

## Where this PoC currently stands
The PoC has been reframed around a clearer comparative hypothesis. It is ready for execution planning and first-trial setup.

## Core framing
- **POC focus:** Determine whether a long-lived, manager-led team of distinct specialist agents is better than a single skill-switching agent for software feature delivery.
- **Additional hypothesis:** A focused team lead should retain the overall goal better than an all-in-one agent, and persistent/contextful delegation should outperform fresh/contextless delegation.
- **Primary outcomes:** quality of result and token usage, with human abstraction level as an additional important outcome.
- **Immediate test shape:** One lightweight real feature-delivery task run in comparative form.

## What the next person/session should do
1. Choose a small real feature-delivery task.
2. Define the single-agent baseline:
   - same task
   - layered skill/instruction approach
3. Define the minimal team structure:
   - team lead
   - 2–3 specialists
4. Establish the interaction rule that the human works mainly through the lead in the team run.
5. Run the baseline and the team mode.
6. If cheap and informative, add a contextless-delegation variant.
7. Record evidence in `poc/evidence/evidence-log.md`.
8. Update `progress-review.md` and `decision-log.md` with results.

## Latest review outcome
The repo is now better targeted around the actual question of interest:
- distinct specialists vs one skill-switching agent
- focused orchestration vs all-in-one execution
- contextful vs contextless delegation

However, it is still entirely pre-evidence.
The next session should prioritize comparative evidence creation over any more framework shaping.

## Success lens to keep in mind
The PoC succeeds if the trial shows:
- better outcomes from distinct specialists,
- a lead that remains focused and synthesizes well,
- signs that persistent delegation helps,
- acceptable or better token usage,
- and reduced low-level human coordination.

## Guardrails
- Do not expand into full platform engineering before the first result.
- Do not turn the first trial into a large benchmark program.
- Do not add features unless they directly support the current hypothesis.

## Key open questions
- Which exact feature-delivery task should be used?
- What makes for a fair single-agent baseline?
- Which specialist roles are most informative for that task?
- How will token usage be captured in a lightweight but honest way?

## Do not spend time yet on
- production hardening or polish
- generalized framework abstractions
- durable memory implementation beyond what the experiment directly needs
- broad multi-task evaluation suites
