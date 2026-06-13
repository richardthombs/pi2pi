# Telemetry Extension — Implementation Plan

A standalone pi extension (`telemetry.ts`) that captures chain of thought, token
usage, and tool-call traces into SQLite. Pi2pi optionally decorates the recorded
tasks with additional context (overlord request, role, team) via `pi.events`.

---

## Overview

```
telemetry.ts            standalone extension, zero pi2pi dependency
  └─ SQLite DB          ~/.pi/agent/telemetry/telemetry.db (default)
  └─ /telemetry cmd     human-readable summaries in TUI
  └─ telemetry_query    SQL tool so LLMs can query the data directly

pi2pi.ts                emits pi.events decoration (optional, ~10 lines)
  └─ telemetry:annotate fired when a pi2pi message arrives or is sent

process-manager.ts      embeds telemetry.ts and passes -e arg to every agent
```

---

## Phase 1 — SQLite schema and extension skeleton

- [x] Create `telemetry.ts` with the extension factory boilerplate
- [x] Define the SQLite schema inline (Bun's `bun:sqlite`)
  - [x] `sessions` table — one row per pi process lifetime
  - [x] `tasks` table — one row per `agent_start`→`agent_end` cycle; decoration columns nullable
  - [x] `turns` table — one row per LLM call within a task
  - [x] `thinking_blocks` table — extracted `ThinkingContent` blocks
  - [x] `assistant_text` table — extracted non-thinking `TextContent` blocks
  - [x] `tool_calls` table — one row per completed tool execution
- [x] Register `--telemetry-db` flag (default: `~/.pi/agent/telemetry/telemetry.db`)
- [x] Register `--telemetry-agent-name` flag (fallback: `os.hostname()`)
- [x] Register `--telemetry-session-label` flag (optional human label, e.g. `"sprint-42"`)
- [x] Open (or create) the DB and apply schema on `session_start`
- [x] Close the DB cleanly on `session_shutdown`

---

## Phase 2 — Session and task lifecycle

- [x] On `session_start`: insert row into `sessions`, store `currentSessionId`
- [x] On `session_shutdown`: update `sessions.ended_at`
- [x] On `agent_start`: insert row into `tasks`, store `currentTaskId`
  - [x] Apply any pending decoration from `telemetry:annotate` that arrived before `agent_start`
- [x] On `agent_end`: update `tasks.ended_at`
- [x] On `model_select`: update `currentModel` / `currentProvider` state variables
- [x] Handle `pi.events.on("telemetry:annotate", ...)` to receive pi2pi decoration
  - [x] If a task is active, update the current task row immediately
  - [x] If no task is active yet, buffer the context and apply on next `agent_start`

---

## Phase 3 — Turn capture (tokens + chain of thought)

- [x] On `turn_start`: insert row into `turns` with `started_at`, `turn_index`, `task_id`, `session_id`, `model`, `provider`; store `currentTurnId`
- [x] On `turn_end`: update `turns` row — set `ended_at` and `stop_reason` from `event.message.stopReason`
- [x] On `message_end` (assistant messages only):
  - [x] Read `event.message.usage` → update `turns` with all token and cost fields
  - [x] Iterate `event.message.content`:
    - [x] For each `ThinkingContent` block: insert into `thinking_blocks`
    - [x] For each `TextContent` block: insert into `assistant_text`

---

## Phase 4 — Tool call capture

- [x] On `tool_execution_end`: insert row into `tool_calls`
  - [x] Capture `event.toolName`, `event.toolCallId`, `event.isError`
  - [x] Capture `event.result.args` as JSON (truncate if > 2 KB to keep DB lean)
  - [x] Link to `currentTurnId`, `currentTaskId`, `currentSessionId`

---

## Phase 5 — Query interface

- [x] Register `telemetry_query` tool
  - [x] Accepts a `sql: string` parameter (SELECT only — reject anything else)
  - [x] Runs against the open DB and returns results as JSON
  - [x] Truncate result rows to a safe limit (e.g. 200 rows, 20 KB)
  - [x] Include schema description in tool description so the LLM knows the tables
- [x] Register `/telemetry` slash command with sub-commands:
  - [x] `/telemetry` (no args) — list last 10 tasks with token totals and overlord request snippet
  - [x] `/telemetry task <id>` — full detail: CoT blocks, assistant text, tool calls, token breakdown
  - [x] `/telemetry stats` — per-session and per-role aggregate token costs
  - [x] `/telemetry sessions` — list recent sessions

---

## Phase 6 — Pi2pi decoration

- [x] In `pi2pi.ts`, emit `telemetry:annotate` when the `tell` tool delivers an incoming message
  - [x] Include: `pi2pi_message_id`, `from_agent`, `overlord_request` (message content), `role`, `team`
- [x] In `pi2pi.ts`, emit `telemetry:annotate` when the agent sends a reply
  - [x] Include: `pi2pi_message_id`, `reply_sent_at`
- [x] Verify decoration is a no-op when telemetry extension is not loaded

---

## Phase 7 — Process manager integration

- [x] Embed `telemetry.ts` source in `process-manager.ts` (same pattern as `pi2pi.ts`)
- [x] Add `ensureTelemetryExtension(loaded)` function — writes to config dir if stale
- [x] Add `--telemetry-db` path to a shared state dir (`<projectRoot>/.pi/runtime/telemetry.db`)
- [ ] Add `--telemetry-session-label` from config or session name
- [x] Add `-e <telemetryPath>` to `buildOverlordArgs`
- [x] Add `-e <telemetryPath>` to each workspace agent's args
- [x] Add `--telemetry-agent-name` mirroring `--agent-name`

---

## Phase 8 — Tests

- [x] Unit test: schema creation — DB opens cleanly and all tables exist
- [x] Unit test: session lifecycle — `session_start` / `session_shutdown` rows written correctly
- [x] Unit test: task lifecycle — `agent_start` / `agent_end` rows; decoration applied
- [x] Unit test: turn capture — token fields populated from a mock `message_end` event
- [x] Unit test: thinking blocks — `ThinkingContent` extracted and stored
- [x] Unit test: tool call capture — `tool_execution_end` rows written
- [x] Unit test: `telemetry_query` tool — SELECT allowed, non-SELECT rejected
- [x] Unit test: pi2pi decoration — `telemetry:annotate` updates task metadata
- [x] Integration test: telemetry extension loads standalone (no pi2pi) without errors

---

## Schema reference (for implementation)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  agent_name     TEXT,
  session_label  TEXT,
  model          TEXT,
  provider       TEXT,
  cwd            TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  pi2pi_message_id  TEXT,
  from_agent        TEXT,
  overlord_request  TEXT,
  role              TEXT,
  team              TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  turn_index       INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  model            TEXT,
  provider         TEXT,
  tokens_input     INTEGER,
  tokens_output    INTEGER,
  tokens_cache_rd  INTEGER,
  tokens_cache_wr  INTEGER,
  tokens_total     INTEGER,
  cost_input       REAL,
  cost_output      REAL,
  cost_total       REAL,
  stop_reason      TEXT
);

CREATE TABLE IF NOT EXISTS thinking_blocks (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL REFERENCES turns(id),
  session_id TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  content    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_text (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL REFERENCES turns(id),
  session_id TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  content    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT REFERENCES turns(id),
  session_id TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id),
  tool_name  TEXT NOT NULL,
  called_at  TEXT NOT NULL,
  args_json  TEXT,
  is_error   INTEGER NOT NULL DEFAULT 0
);
```

---

## Useful queries (examples for `telemetry_query`)

```sql
-- Total tokens to implement a given overlord request
SELECT t.overlord_request, SUM(tr.tokens_total) AS total_tokens, SUM(tr.cost_total) AS total_cost
FROM tasks t JOIN turns tr ON tr.task_id = t.id
GROUP BY t.id ORDER BY t.started_at DESC LIMIT 10;

-- Chain of thought for a specific task
SELECT tu.turn_index, tb.sequence, tb.content
FROM thinking_blocks tb JOIN turns tu ON tb.turn_id = tu.id
WHERE tu.task_id = '<task-id>' ORDER BY tu.turn_index, tb.sequence;

-- Token cost breakdown by role
SELECT t.role, t.team, COUNT(DISTINCT t.id) AS tasks,
       SUM(tr.tokens_total) AS tokens, SUM(tr.cost_total) AS cost
FROM tasks t JOIN turns tr ON tr.task_id = t.id
GROUP BY t.role, t.team;

-- Tool call frequency per agent session
SELECT s.agent_name, tc.tool_name, COUNT(*) AS calls
FROM tool_calls tc JOIN sessions s ON tc.session_id = s.id
GROUP BY s.agent_name, tc.tool_name ORDER BY calls DESC;

-- All turns for a session with per-turn cost
SELECT tu.turn_index, tu.tokens_total, tu.cost_total, tu.stop_reason, tu.started_at
FROM turns tu WHERE tu.session_id = '<session-id>' ORDER BY tu.turn_index;
```
