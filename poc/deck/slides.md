# Long-Lived Collaborating Agents
### Pre-experiment framing deck

- **POC:** Reliable agent-to-agent collaboration via long-lived agents
- **Current stage:** Definition complete, experiment not yet run
- **Decision this deck supports:** Is this POC well-shaped enough to run now, and what evidence must the first trial produce?

Note:
- Frame this as a decision-support deck, not a product pitch.
- We are deciding whether to run and how to evaluate the first trial.

---

## Problem and stakeholder

**Problem**
- Humans may have to manage too much low-level coordination in complex software-delivery work.

**Primary stakeholder**
- Team or collaborators deciding whether this long-lived collaboration model is worth deeper investment.

**Why it matters**
- If a manager-led agent team works, the human can stay at a higher level of abstraction.

Note:
- Keep the audience focused on coordination burden, not infrastructure novelty.

---

## Hypothesis and boundary

**Hypothesis**
- In a lightweight real feature-delivery task, a long-lived manager agent coordinating specialists will let the human stay high-level while still producing useful delegated work and a digestible synthesis.

**This POC is not trying to prove**
- that long-lived agents beat ephemeral sub-agents
- that the framework is production-ready
- that broad reliability, memory, or scale concerns are solved

Note:
- The honest boundary matters: this is a single-arm merit test first.

---

## Smallest useful test

**Workflow**
1. Human gives one feature request at a high level
2. Manager agent delegates to 2–3 specialists
3. Specialists return role-specific outputs
4. Manager synthesizes outcome, open questions, and next steps

**What must be real**
- small real software feature-delivery task
- real delegation flow
- real final synthesis

**What can stay lightweight**
- infrastructure
- persistence/memory
- reliability plumbing beyond the minimum needed to run

Note:
- This slide is the core experiment design.
- Keep implementation detail subordinate to what we need to learn.

---

## What has been achieved so far

### Satisfied already ###
- clear problem and decision framing
- bounded experiment plan
- success/failure criteria defined
- drift guardrails documented

**What this means**
- the POC has clarity
- the POC does not yet have proof

**Evidence source**
- definition, experiment plan, decision log, progress review

Note:
- This is genuine learning because it narrowed the question and reduced ambiguity.

---

## Evidence the first run must produce

**The first trial only needs evidence for 3 things**
1. The human stayed mostly high-level
2. Specialists added differentiated value
3. The manager summary reduced cognitive load

**Capture**
- feature request used
- specialist outputs
- final synthesis
- human intervention notes

**Useful future screenshot/demo**
- manager-to-specialist flow or transcript excerpt

Note:
- Do not add extra metrics unless they change the decision.

---

## Gaps and risks right now

**Open gaps**
- exact feature-delivery task not chosen
- exact specialist roles not chosen
- no end-to-end trial run yet

**Main drift risks**
- generalized framework design
- durable memory/context systems
- reliability/productization work
- broad SDLC simulation

**Interpretation**
- the next risk is polishing the system before creating evidence

Note:
- This is the anti-productization slide.

---

## Recommendation for this stage

**Recommendation**
- Run one end-to-end trial now.

**Park for later**
- A/B comparison against ephemeral sub-agents
- generalized framework abstractions
- durable memory implementation
- production hardening, scale, security, UX polish

**Best next move**
- choose one small real feature task
- define manager + 2–3 specialist roles
- capture evidence from one complete run

Note:
- If the first run is positive, the next step is stronger evidence, not broader scope.
