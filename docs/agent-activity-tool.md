# Agent Activity Tool — Spec

## Overview

The `activity()` tool gives a team leader visibility into whether a specific agent is actively working on a task, without exposing the content of their work. It fills the gap left by `who()`, which only reports presence (connected / not connected).

## Motivation

When an agent is delegated a long-running task and does not respond within a reasonable time, the leader currently has no way to distinguish between:
- The agent is actively working (running tool calls, writing files, thinking) — **keep waiting**
- The agent received the task but has gone idle unexpectedly — **worth a nudge**
- The agent never received the task — **resend**

## Tool Signature

```
activity(agent: string) → AgentActivityReport
```

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | Yes | The name of the agent to query (e.g. `"Bob"`) |

### Return Type: `AgentActivityReport`

```ts
interface AgentActivityReport {
  agent: string;
  state: "busy" | "idle";
  lastMessageReceivedAt: string | null;   // UTC ISO 8601, or null if no message yet
  lastMessageSentAt: string | null;       // UTC ISO 8601, or null if never replied
  lastToolCallAt: string | null;          // UTC ISO 8601, or null if no tool calls made
  lastToolCallName: string | null;        // Name of the most recent tool called (e.g. "write", "bash")
  toolCallsSinceLastMessage: number;      // Count of tool calls since the last received message
  warning?: string;                       // Present if agent is not connected
}
```

### State definitions

- **`busy`** — the agent is currently generating a response or executing a tool call (maps from broker's `"active"` state)
- **`idle`** — the agent is not currently processing anything (may have finished, may be waiting for input, or may be stalled)

## Example Response

```json
{
  "agent": "Bob",
  "state": "busy",
  "lastMessageReceivedAt": "2026-06-09T14:32:01Z",
  "lastMessageSentAt": null,
  "lastToolCallAt": "2026-06-09T14:33:47Z",
  "lastToolCallName": "write",
  "toolCallsSinceLastMessage": 9
}
```

## Usage Guidelines

- If `state` is `"busy"` and `lastToolCallAt` is recent — **keep waiting**, the agent is actively working.
- If `state` is `"idle"` and `lastMessageReceivedAt` is set but `toolCallsSinceLastMessage` is `0` — the agent likely received the task but did not begin work; consider resending.
- If `state` is `"idle"` and `toolCallsSinceLastMessage` is non-zero but no reply has been sent (`lastMessageSentAt` is null) — the agent may have finished work without replying, or may be stuck; send a check-in.
- Do **not** use this tool to micromanage agents. Use it only when a reply is overdue and the reason is unclear.

## What this tool does NOT expose

- The content of the agent's tool calls or outputs
- The agent's internal reasoning or generation state
- Any ability to interrupt, cancel, or redirect the agent

## Implementation: Broker Protocol Extension

### New client → broker message type: `tool_call`

Agents send this message to the broker each time they begin executing a tool call:

```json
{ "type": "tool_call", "name": "<tool-name>" }
```

The broker increments `toolCallsSinceLastMessage`, records `lastToolCallAt` (UTC ISO 8601) and `lastToolCallName`.

### Existing message side-effects

- When the broker delivers an **`incoming`** message to a target agent, it records `lastMessageReceivedAt` on that agent and resets `toolCallsSinceLastMessage` to `0`.
- When the broker delivers a **`reply_result`** back to an originator, it records `lastMessageSentAt` on the replying agent.

### New HTTP endpoint: `GET /activity/:name`

Returns an `AgentActivityReport` JSON object for the named agent.

- Looks up the agent across all rooms by name.
- If the agent is not connected, returns `state: "idle"` with all timestamps `null`, `toolCallsSinceLastMessage: 0`, and `warning: "Agent not connected"`.
- Returns immediately without blocking.

## Implementation Notes

- The broker is the natural place to maintain this state, as it already tracks connected agents and message routing.
- `state: "busy"` maps from the existing broker `state: "active"` field; `"idle"` maps from `"idle"` or `null`.
- All timestamps must be UTC ISO 8601 strings (e.g. `"2026-06-09T14:33:47Z"`).
- `toolCallsSinceLastMessage` resets to `0` each time a new `incoming` message is delivered to the agent.

## Agent-Side Emission (pi2pi.ts)

Agent-side `tool_call` emission is **now live** via the `tool_execution_start` hook in `pi2pi.ts`.

The handler is registered after `agent_end` and fires before every tool execution:

```ts
pi.on("tool_execution_start", async (event) => {
    for (const connection of orderedConnections()) {
        if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN || !agentName) continue;
        connection.ws.send(JSON.stringify({ type: "tool_call", name: event.toolName }));
    }
});
```

This sends a `{ type: "tool_call", name: event.toolName }` message to the broker on every connected room WebSocket before each tool runs. The broker updates `lastToolCallAt`, `lastToolCallName`, and `toolCallsSinceLastMessage` on the agent's record.

### Manual integration test

1. Start the broker: `bun broker.ts`
2. Launch pi with: `--agent-name Alice --room test`
3. Execute any tool (e.g. `read`, `bash`)
4. Verify: `GET /activity/Alice` returns `lastToolCallAt` (ISO string), `lastToolCallName` (tool name), and `toolCallsSinceLastMessage > 0`
