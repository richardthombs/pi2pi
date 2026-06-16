# TODO

1. **Restart a single agent**
   - Add a supported way to restart one crashed/stuck agent without restarting the entire room or orchestration session.
   - Ideally expose this as a CLI command for a specific workspace/member, and/or make it easy to relaunch the correct command for that agent.

2. **Improve pi status bar / UI indicators**
   - Add an improved status bar or other UI indicator showing, for each repo in the agent's workspace:
     - repo name
     - local filesystem location
     - current git branch
   - Make this easy for the agent to see while working.

3. **Improve team lead delegation behaviour**
   - Adjust the team lead behaviour/prompts so they delegate more often.
   - Ensure they consider the skills and specialties of their team members when choosing who should do what.

4. **Require broader review before lead marks work complete**
   - Add instructions for the team lead so that all relevant agents have had an opportunity to review completed work before the lead considers the item fully complete.
   - This should encourage review from the appropriate specialists, not just the original implementer.

5. **Double-check workspace folder configuration**
   - Investigate and confirm where the pi2pi workspaces folder is supposed to live.
   - Understand why it is currently running from `C:/dev/pi2pi` / `.pi/workspaces` under this repo, and whether that is intended configuration or an issue to fix.

6. **Seed agent instructions from markdown files instead of only CLI system prompts**
   - Add a way to define agent instructions in markdown files, rather than passing all system prompt content on the command line.
   - Support instruction layering at multiple levels:
     - global workspace-level instructions applied to all team members in a workspace
     - global role-level instructions applied to all agents with a given role across all workspaces
     - workspace-specific role instructions applied to agents with a given role inside one workspace
   - Explore a folder structure under `.pit/config/`, for example:
     - `.pit/config/config.yaml` for root configuration
     - `.pit/config/roles/<role-name>/ROLE.md` for global role instructions
     - `.pit/config/workspaces/<workspace-name>/WORKSPACE.md` for workspace-wide instructions
     - `.pit/config/workspaces/<workspace-name>/roles/<role-name>/ROLE.md` for workspace-specific role instructions
   - Clarify how these markdown files should merge with existing generated/default prompts and what the precedence order should be.
