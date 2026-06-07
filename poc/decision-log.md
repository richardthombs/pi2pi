# Decision Log

## Decision 1: Evaluate merit, not full platform reliability
- **What we decided:** Frame the PoC around the merit of long-lived collaborating agents in software-team-like work, not around building a full reliable messaging platform.
- **Why:** The user's decision is whether there is merit in long-lived collaboration versus ephemeral sub-agents.
- **Evidence / assumption:** The user emphasized a managing agent controlling its own team, summarizing detailed work for the human, and preserving useful continuity.
- **What it tells us:** The experiment should test human abstraction and collaboration value, not generalized infrastructure.
- **Next move:** Keep framework work minimal and in service of the experiment.

## Decision 2: Start with software feature delivery
- **What we decided:** Use a software-development feature-delivery workflow as the first scenario.
- **Why:** It naturally contains multiple roles, handoffs, and synthesis needs.
- **Evidence / assumption:** The user identified software development teams as the primary target context.
- **What it tells us:** The test should involve realistic specialist roles and a real small feature task.
- **Next move:** Pick one lightweight feature-delivery task.

## Decision 3: Prioritize continuity benefit via higher-level human interaction
- **What we decided:** Focus first on whether the human can work at a higher level while the manager delegates and synthesizes specialist work.
- **Why:** This is the clearest value signal the user wants to test first.
- **Evidence / assumption:** The user chose continuity/shared context as the starting point and described wanting the human to remain at a higher level of abstraction.
- **What it tells us:** Success should depend on reduced micromanagement and useful synthesis.
- **Next move:** Design the first trial around delegation plus synthesis.

## Decision 4: Use a single-arm PoC first
- **What we decided:** Do not compare directly against ephemeral sub-agents yet.
- **Why:** The user wants to test whether the long-lived model is workable and promising before doing an A/B comparison.
- **Evidence / assumption:** The user selected 'long-lived only for now.'
- **What it tells us:** The first decision is whether the model merits further investment, not whether it wins a benchmark.
- **Next move:** Run one credible end-to-end demonstration.

## Decision 5: Keep the first trial minimal
- **What we decided:** Test delegation and synthesis only, using a lightweight real task.
- **Why:** This is the smallest useful test that still exercises the core hypothesis.
- **Evidence / assumption:** The user selected 'delegation and synthesis only' and 'lightweight real task.'
- **What it tells us:** Memory retrieval, generalized persistence, and broad workflow support are explicitly deferred.
- **Next move:** Define manager and specialist roles and run the trial.

## Decision 6: Treat the current state as framing complete but evidence incomplete
- **What we decided:** Conclude that the POC has achieved clarity of purpose and scope, but has not yet satisfied any execution-based success criterion.
- **Why:** The repo now contains a coherent definition and experiment plan, but no recorded trial outputs.
- **Evidence / assumption:** `definition.md`, `experiment-plan.md`, and `progress-review.md` align on the question, hypothesis, and smallest useful test; `evidence/evidence-log.md` shows no experiment run yet.
- **What it tells us:** Further value now comes from running the first trial, not refining the concept further.
- **Next move:** Select one concrete feature-delivery task and execute one end-to-end run.
