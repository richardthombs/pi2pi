# Decision Log

## Decision 1: Evaluate workflow merit, not full platform reliability
- **What we decided:** Keep the PoC focused on workflow merit rather than building a full reliable messaging platform.
- **Why:** The key decision is about whether the multi-agent working model is better, not whether the infrastructure is production-ready.
- **Evidence / assumption:** The user's interest is in delivery quality, delegation quality, lead focus, and efficiency.
- **What it tells us:** Framework work should stay minimal and serve the experiment only.
- **Next move:** Prefer lightweight implementation choices that enable credible comparison.

## Decision 2: Start with software feature delivery
- **What we decided:** Use a software-development feature-delivery workflow as the first scenario.
- **Why:** It naturally contains planning, implementation, review, synthesis, and tool use.
- **Evidence / assumption:** The user identified software teams as the primary target context.
- **What it tells us:** The test should exercise meaningful specialist differences.
- **Next move:** Pick one lightweight but real feature-delivery task.

## Decision 3: Reframe the PoC around distinct-agent teams vs skill-switching single agents
- **What we decided:** Update the hypothesis so the main comparison is now between:
  - a long-lived team of distinct specialist agents, and
  - a single agent that assumes different skills over time via `SKILL.md`-style instructions.
- **Why:** This is now the sharper product/workflow question.
- **Evidence / assumption:** The user believes distinct agents may outperform role-switching inside one agent context.
- **What it tells us:** The experiment should include at least a lightweight baseline for the single-agent-with-skills approach.
- **Next move:** Define a comparable task and evaluation lens across both modes.

## Decision 4: Test whether lead/specialist separation preserves focus
- **What we decided:** Explicitly test the claim that a dedicated team lead can stay focused on the overall goal while specialist agents absorb tool-heavy and detail-heavy work.
- **Why:** The user expects a lead agent to lose less context than a single agent doing everything itself.
- **Evidence / assumption:** Tool calls and implementation detail can crowd out orchestration context in a single-threaded agent workflow.
- **What it tells us:** We should observe whether the lead's synthesis stays cleaner and more coherent.
- **Next move:** Capture examples where specialists handle detail while the lead coordinates and synthesizes.

## Decision 5: Test contextful delegation vs contextless delegation
- **What we decided:** Include the hypothesis that repeated delegation to the same long-lived specialist is beneficial because useful context accumulates.
- **Why:** Fresh sub-agents may discard working context between delegations.
- **Evidence / assumption:** The user expects persistent specialists to improve over repeated interaction within the same task or workspace.
- **What it tells us:** We should note whether the same specialist becomes more effective on follow-up work.
- **Next move:** Capture evidence from repeated delegation where possible, even if initially qualitative.

## Decision 6: Use quality and token usage as primary directional outcomes
- **What we decided:** Judge the experiment mainly on result quality and token usage, with human abstraction level as an additional important outcome.
- **Why:** These are the outcomes the user most wants to improve.
- **Evidence / assumption:** Higher quality and lower token usage are the target benefits named by the user.
- **What it tells us:** The experiment needs at least lightweight evidence on both.
- **Next move:** Record comparative observations, even if exact measurement remains imperfect.

## Decision 7: Keep the first comparative trial minimal
- **What we decided:** Run the smallest useful comparison rather than broadening into a large benchmark suite.
- **Why:** The aim is to learn whether the updated hypothesis is promising, not to produce publishable proof.
- **Evidence / assumption:** The repo still has no execution evidence, so the highest-value next step is a small real run.
- **What it tells us:** Further conceptual refinement has diminishing returns.
- **Next move:** Execute one credible comparative trial and log the evidence.
