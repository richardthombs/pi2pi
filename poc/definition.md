# POC Definition

## 1. Context
- **Idea:** Explore whether a **long-lived collaborating agent team with distinct specialist roles** is more effective than relying on a **single agent that assumes different skills over time via instruction/skill files**.
- **Problem worth solving:** In complex software-development workflows, a single agent may lose focus as it mixes orchestration, tool-heavy execution, and multiple specialist perspectives in one context window. It is unclear whether separating those concerns across persistent agents produces better outcomes.
- **Who experiences the problem:** Humans coordinating complex software-delivery work, and agent systems that must balance planning, implementation, review, and synthesis.
- **Why this matters now:** If distinct long-lived agents work better than a single skill-switching agent, humans may be able to stay at a higher level while the lead agent remains focused on the overall goal and specialist agents accumulate useful context over repeated delegation.

## 2. What this POC is for
- **Main question to answer:** In a lightweight real software feature-delivery task, is a long-lived team of distinct specialist agents better than a single agent using role/skill instructions, and does contextful repeated delegation outperform contextless delegation?
- **Decision this will inform:** Whether to invest further in a team-of-agents model, persistent specialist delegation, and leader/specialist separation instead of leaning primarily on a single-agent-plus-skills approach.
- **Hypotheses:**
  1. A team of agents with distinct roles and skills will produce better outcomes than a single agent that tries to assume those skills over time via `SKILL.md`-style instructions.
  2. Separating orchestration from specialist execution will let the team lead stay focused on the overall goal without losing as much context to tool calls and implementation detail.
  3. Contextful delegation to the same long-lived specialist will outperform contextless delegation to fresh sub-agents because useful working context is retained across repeated tasks.
- **Primary outcomes to watch:**
  - higher quality result
  - lower token usage
  - clearer orchestration / less human micromanagement

## 3. Stakeholder
- **Primary stakeholder:** The user's team or collaborators, who may adopt or build on the approach.

## 4. Scope
### In scope
- A real small software feature-delivery task.
- At least one run using a **team lead + specialists** structure.
- Comparison against a **single-agent with layered skills/instructions** approach, even if lightweight.
- Observation of whether repeated delegation to the same specialist appears to improve output quality or efficiency.
- Capturing quality, coordination, and token-usage observations.

### Out of scope / non-goals
- Building a production-ready communication or memory platform.
- Solving reliability in the general distributed-systems sense.
- Testing a full software team lifecycle end-to-end.
- Producing benchmark-grade statistical proof.
- Optimizing UX, scalability, security, or reusable architecture beyond what is needed for the experiment.

## 5. Primary value being tested
1. Distinct specialist agents can outperform a single skill-switching agent on practical delivery work.
2. A dedicated lead can preserve strategic focus while specialists handle detailed execution and review.
3. Persistent, contextful delegation can improve quality and efficiency relative to fresh/contextless delegation.
4. The human can stay at a higher level and avoid low-level coordination.

## 6. Constraints
- Keep scope tight and evidence-driven.
- Use a lightweight real software-development task rather than a fully scripted simulation.
- Avoid turning the PoC into a full platform build.
- Treat quality and token usage as directional evidence unless a cleaner measurement setup is introduced.

## 7. Assumptions
- Software development is the initial target workflow, though the concept may generalize.
- Feature delivery is the first scenario because it naturally exercises planning, implementation, review, and synthesis.
- Role separation matters: lead, implementation, review, and planning/UX/product perspectives may not be equally well served by a single active context.

## 8. Honest boundary of this POC
This PoC is no longer just asking whether long-lived collaboration is interesting in the abstract. It is now asking a more comparative question:

> Does a long-lived team of distinct agents, with persistent specialist context and a focused lead, produce better practical software-delivery outcomes than a single skill-switching agent or contextless delegation?

The expected evidence is directional rather than definitive: enough to judge whether the team-based model is worth deeper investment and more rigorous comparison.
