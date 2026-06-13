# pi2pi — Peer-to-peer messaging between pi instances

A proof-of-concept that lets two (or more) pi instances exchange messages via a shared broker.

## Architecture

```
┌──────────────────────┐         ┌──────────────┐         ┌──────────────────────┐
│  pi --name Alice      │◄───────►│   broker.ts  │◄───────►│  pi --name Bob       │
│  (pi2pi.ts extension) │  WS     │  (Bun HTTP)  │  WS     │  (pi2pi.ts extension)│
└──────────────────────┘         └──────────────┘         └──────────────────────┘
```

- **`broker.ts`** — A tiny Bun WebSocket server. It keeps a registry of named agents and routes messages between them.
- **`pi2pi.ts`** — A pi extension that registers `--name` / `--broker` flags, intercepts `@name message` input, and exchanges messages via the broker.

## Prerequisites

- [Bun](https://bun.sh) runtime for the broker: `curl -fsSL https://bun.sh/install | bash`
- [pi](https://github.com/badlogic/pi-mono) coding agent

## Quick start

### 1. Start the broker

```bash
bun broker.ts
# or on a custom port:
bun broker.ts --port 8080
```

### 2. Launch two pi instances (separate terminals)

```bash
# Terminal 1
pi -e ./pi2pi.ts --agent-name Alice --room engineering

# Terminal 2
pi -e ./pi2pi.ts --agent-name Bob --room engineering
```

Each instance shows a status indicator in the footer (e.g. `● Alice [Bob]`).

### 3. Use the commands

| Command | Description |
|---------|-------------|
| `/tell Bob what is the capital of France?` | Send a message to Bob's LLM (fire-and-forget) |
| `/tell everyone introduce yourself briefly` | Broadcast to all connected agents |
| `/replies` | Show all replies received since you last checked |
| `/who` | Show who is currently connected |

Tab-completion works on the first argument of `/tell` — it offers `everyone` plus the names of online agents.

In Alice's session:
```
/tell Bob what is 2 + 2?
```
- Alice's conversation shows the sent message and returns immediately
- Bob's LLM receives the message and answers it in the background
- Alice sees a notification when the reply arrives
- Alice runs `/replies` (or the `replies` tool) to read it

Bob's session shows the message as a user turn so he can see what was asked.

## Workspace CLI (experimental)

The repo now includes a workspace-oriented CLI for managing shared repositories, shared role definitions, mixed-specialty team workspaces, leadership-room coordination, and multiplexer-backed orchestration sessions.

### Config model

Use a shared config file (default: `.pi/config.yaml`) with top-level:

- `orchestration` — shared broker / leadership-room / session settings for the overlord + team leads, including the overlord prompt template
- `roles` — shared across all workspaces
- `repositories` — cloned once into `.pi/repos/`
- `workspaces` — each workspace gets its own worktree per required repo under `.pi/workspaces/<workspace>/`

Each workspace should define:
- `room` — the team room name
- `leader` — the member who joins both the team room and the shared leadership room
- `members` — a mixed-specialty team (for example lead, devs, QA, UX, planner)

An example lives at [`example-workspaces.yaml`](./example-workspaces.yaml).

The overlord prompt is now configurable in `orchestration.overlordPrompt` and supports `{{name}}` and `{{leadershipRoom}}` interpolation.

### Common commands

```bash
# Add a repository to the shared catalog
bun cli.ts repos add https://github.com/richardthombs/pi2pi.git

# Configure orchestration-wide settings
bun cli.ts orchestration set leadership-room leadership
bun cli.ts orchestration set broker ws://localhost:7331
bun cli.ts orchestration set session-name pi2pi

# Create a workspace / team
bun cli.ts workspace create engineering

# Attach a shared repo to that workspace
bun cli.ts workspace engineering add repo pi2pi

# Roles are shared globally; create or list them once
bun cli.ts roles add manager github-copilot/claude-sonnet-4.6 "Project Manager"
bun cli.ts roles list

# Add members to the team using shared role definitions
bun cli.ts workspace engineering add member Alice manager
bun cli.ts workspace engineering add member Bob engineer
bun cli.ts workspace engineering add member Charlie qa

# Mark the team leader (this member joins both team + leadership rooms)
bun cli.ts workspace engineering set leader Alice

# Optional: override the team room or broker per workspace
bun cli.ts workspace engineering set room engineering
bun cli.ts workspace engineering set broker ws://localhost:7331

# Materialize the workspace worktrees
bun cli.ts workspace engineering init

# Inspect how a workspace will be launched
bun cli.ts workspace engineering status

# Launch the full organisation session:
# - leadership window with the overlord
# - one team window per workspace
bun cli.ts orchestration start

# Reattach / restart / stop the session later
bun cli.ts orchestration attach
bun cli.ts orchestration restart
bun cli.ts orchestration stop
```

When orchestration starts, each team member is launched with a working directory inside that team's workspace: if the workspace has exactly one repository, the agent starts inside that repository's worktree; otherwise it starts at the workspace root so the repository worktrees are available as sibling directories. Workspace launches also set `GIT_CEILING_DIRECTORIES` to the workspace root so running `git` from the workspace root will not accidentally target the parent project clone.

Leaders are launched into two rooms:
- `team` → their own workspace room
- `leadership` → the shared room containing the overlord plus every team lead

The leader handle is `<workspace>.lead`, so the overlord can discover active teams by running `who` in the leadership room.

Multiplexer backend policy:
- **Windows** → `psmux` only, otherwise error
- **macOS** → prefer `cmux`, fallback to `tmux`, otherwise error
- **Linux** → `tmux` only, otherwise error

Layout policy:
- **tmux / psmux** → one session, one `leadership` window, one window per team
- **cmux** → one top-level cmux window per logical window/workspace created by the launcher
- each team window/workspace puts the leader on the left and stacks the remaining specialists on the right

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--agent-name <name>` | **Required**. Name for this pi instance. | — |
| `--room <room>` | Join a single room. Backwards-compatible shortcut for `--rooms <room>`. | — |
| `--rooms <bindings>` | Join one or more rooms, e.g. `team=engineering,leadership=leadership`. | — |
| `--default-room <alias>` | Default room alias used when `tell` / `who` omit a room. | first configured room |
| `--broker <url>` | WebSocket URL of the broker. | `ws://localhost:7331` |

## Broker HTTP endpoint

`GET http://localhost:7331/agents` returns the list of currently connected agents:

```json
{ "rooms": { "engineering": ["Alice", "Bob"] } }
```

## Message flow

```
Alice types:  /tell Bob tell me a joke
     │
     ▼
/tell command handler
     │  sends  { type:"message", id:"uuid", to:"Bob", content:"tell me a joke" }
     ▼
broker.ts forwards  { type:"incoming", id:"uuid", from:"Alice", content:"tell me a joke" }
     │
     ▼
Bob's pi2pi.ts calls pi.sendUserMessage("[Message from @Alice]: tell me a joke")
     │
     ▼
Bob's LLM turns respond → agent_end fires
     │  sends  { type:"reply", id:"uuid", content:"<joke>" }
     ▼
broker.ts routes  { type:"reply_result", id:"uuid", from:"Bob", content:"<joke>" }
     │
     ▼
Alice's pi2pi.ts calls pi.sendMessage({ customType:"pi2pi-reply", ... })
Alice sees: 💬 @Bob: <joke>
```

For `/tell everyone`, the extension fans out one individual message per online agent.

## Checking replies

Replies from other agents are accumulated in a background list. Retrieve them with:

- **`/replies`** — displays all pending replies in the TUI and clears them
- **`replies` tool** — the LLM can call this to read and clear pending replies

A notification is shown whenever a new reply arrives.

## Contributing / Development

### Keeping the `pit` binary up to date

The `pit` binary at `~/.bun/bin/pit` is installed via `bun link` and is **not** recompiled automatically when source files change. If you modify `cli.ts` or any module it imports, re-run:

```bash
bun link
# or use the package.json shortcut:
bun run link
```

Failure to do this means the installed `pit` binary will silently run stale code, which can cause confusing behaviour (e.g. new flags or fixes appearing in source but not taking effect).

> **Tip:** if `pit` is behaving unexpectedly after a pull or source edit, `bun link` is the first thing to try.

## Notes

- The broker evicts old connections if the same name reconnects (e.g. after a reload).
- The extension auto-reconnects with exponential back-off if the broker drops.
- Replies are correlated with the original message by UUID so multiple in-flight messages work correctly.
- If the target agent isn't connected, the broker returns an error that is shown as a notification.
