/**
 * Pi2Pi Broker
 *
 * A WebSocket message broker that enables communication between pi instances.
 * Run with: bun broker.ts [--port 7331]
 *
 * Protocol (JSON over WebSocket):
 *
 * Client → Broker:
 *   { type: "register", name: string, room: string, displayName?: string, role?: string }
 *   { type: "message",  id: string, to: string, content: string }
 *   { type: "reply",    id: string, content: string }
 *   { type: "status",   state: "active"|"idle", model: string|null,
 *                        contextTokens: number|null, contextWindow: number|null,
 *                        contextPercent: number|null }
 *   { type: "tool_call", name: string }
 *
 * Broker → Client:
 *   { type: "registered",    name: string, room: string }
 *   { type: "agent_list",    agents: string[], room: string }
 *   { type: "incoming",      id: string, from: string, content: string }
 *   { type: "reply_result",  id: string, from: string, content: string }
 *   { type: "agent_status",  room: string, name: string, state: "active"|"idle",
 *                             model: string|null, contextTokens: number|null,
 *                             contextWindow: number|null, contextPercent: number|null,
 *                             lastMessageReceivedAt: string|null, lastMessageSentAt: string|null,
 *                             lastToolCallAt: string|null, lastToolCallName: string|null,
 *                             toolCallsSinceLastMessage: number }
 *   { type: "error",         id: string | null, reason: string }
 *
 * HTTP:
 *   GET /activity/:name  → AgentActivityReport
 *
 * Rooms:
 *   Agents are scoped by room. agent_list only contains room-mates.
 *   Messages can only be sent to agents in the same room.
 *   The /agents HTTP endpoint shows all rooms and their members.
 */

import type { ServerWebSocket } from "bun";
import { renderBrokerScreen, type BrokerRoomEntry } from "./broker-ui";

const DEFAULT_PORT = 7331;
const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? parseInt(process.argv[portArg + 1] ?? String(DEFAULT_PORT)) : DEFAULT_PORT;

type AgentData = {
	name: string | null;
	displayName: string | null;
	role: string | null;
	room: string | null;
	state: "active" | "idle" | null;
	model: string | null;
	contextTokens: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
	lastMessageReceivedAt: string | null;
	lastMessageSentAt: string | null;
	lastToolCallAt: string | null;
	lastToolCallName: string | null;
	toolCallsSinceLastMessage: number;
};

// Keyed by "room/name"
const agents = new Map<string, ServerWebSocket<AgentData>>();

// Keyed by message id → { originatorName, originatorRoom, targetName }
// Stored by name rather than WebSocket reference so that replies are still
// routable if the originator disconnects and reconnects before the target replies.
const pendingReplies = new Map<string, { originatorName: string; originatorRoom: string; targetName: string }>();

function agentKey(room: string, name: string) {
	return `${room}/${name}`;
}

function roomMembers(room: string): string[] {
	const out: string[] = [];
	for (const ws of agents.values()) {
		if (ws.data.room === room && ws.data.name) out.push(ws.data.name);
	}
	return out;
}

function roomRoster(room: string): Array<{ name: string; displayName: string; role: string | null }> {
	const out: Array<{ name: string; displayName: string; role: string | null }> = [];
	for (const ws of agents.values()) {
		if (ws.data.room === room && ws.data.name) {
			out.push({
				name: ws.data.name,
				displayName: ws.data.displayName ?? ws.data.name,
				role: ws.data.role,
				lastMessageReceivedAt: ws.data.lastMessageReceivedAt,
				lastMessageSentAt: ws.data.lastMessageSentAt,
				lastToolCallAt: ws.data.lastToolCallAt,
				lastToolCallName: ws.data.lastToolCallName,
				toolCallsSinceLastMessage: ws.data.toolCallsSinceLastMessage,
			});
		}
	}
	return out;
}

function broadcastRoomList(room: string) {
	const members = roomMembers(room);
	const roster = roomRoster(room);
	for (const ws of agents.values()) {
		if (ws.data.room === room) {
			send(ws, { type: "agent_list", agents: members, roster, room });
		}
	}
}

function broadcastAgentStatus(ws: ServerWebSocket<AgentData>) {
	const { name, displayName, role, room, state, model, contextTokens, contextWindow, contextPercent,
	        lastMessageReceivedAt, lastMessageSentAt, lastToolCallAt, lastToolCallName, toolCallsSinceLastMessage } = ws.data;
	if (!name || !room) return;
	const msg = { type: "agent_status", room, name, displayName, role, state, model,
	              contextTokens, contextWindow, contextPercent,
	              lastMessageReceivedAt, lastMessageSentAt, lastToolCallAt, lastToolCallName, toolCallsSinceLastMessage };
	for (const peer of agents.values()) {
		if (peer.data.room === room) send(peer, msg);
	}
}

function send(ws: ServerWebSocket<AgentData>, msg: Record<string, unknown>) {
	try { ws.send(JSON.stringify(msg)); } catch { /* already closed */ }
}

const isTTY = process.stdout.isTTY;
const logBuffer: string[] = [];
const MAX_LOGS = 500;

function cleanup() {
	if (isTTY) {
		// Show cursor, clear screen, disable alternate screen buffer
		process.stdout.write("\u001B[?25h\u001B[?1049l");
	}
	process.exit(0);
}

if (isTTY) {
	// Enter alternate screen buffer and hide cursor
	process.stdout.write("\u001B[?1049h\u001B[?25l");

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	process.on("exit", () => {
		process.stdout.write("\u001B[?25h\u001B[?1049l");
	});

	process.stdout.on("resize", () => {
		draw();
	});

	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (key: string) => {
		if (key === "\u0003" || key === "q" || key === "Q") {
			cleanup();
		}
	});
}

function draw() {
	if (!isTTY) return;

	const width = process.stdout.columns || 80;
	const height = process.stdout.rows || 24;
	const rooms: Record<string, BrokerRoomEntry[]> = {};
	let totalAgents = 0;

	for (const ws of agents.values()) {
		if (ws.data.name && ws.data.room) {
			const r = ws.data.room;
			(rooms[r] ??= []).push({
				name: ws.data.name,
				displayName: ws.data.displayName ?? ws.data.name,
				role: ws.data.role,
				state: ws.data.state,
				model: ws.data.model,
				contextTokens: ws.data.contextTokens,
				contextWindow: ws.data.contextWindow,
				contextPercent: ws.data.contextPercent,
			});
			totalAgents++;
		}
	}

	process.stdout.write(renderBrokerScreen({
		width,
		height,
		rooms,
		logs: logBuffer,
		totalAgents,
	}));
}

function log(msg: string) {
	const timestamp = new Date().toLocaleTimeString();
	// Collapse any newlines in the message so a multi-line LLM response
	// doesn't inject real line breaks into the fixed-height log pane.
	const sanitised = msg.replace(/\r\n|\r|\n/g, " ");
	const formatted = `[\u001B[90m${timestamp}\u001B[0m] ${sanitised}`;
	if (isTTY) {
		logBuffer.push(formatted);
		if (logBuffer.length > MAX_LOGS) {
			logBuffer.shift();
		}
		draw();
	} else {
		console.log(`[${new Date().toISOString()}] ${msg}`);
	}
}

Bun.serve<AgentData>({
	port,
	fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/agents") {
			const rooms: Record<string, unknown[]> = {};
			for (const ws of agents.values()) {
				const r = ws.data.room ?? "(unknown)";
				(rooms[r] ??= []).push({
					name: ws.data.name ?? "(unknown)",
					displayName: ws.data.displayName ?? ws.data.name ?? "(unknown)",
					role: ws.data.role,
					state: ws.data.state,
					model: ws.data.model,
					contextTokens: ws.data.contextTokens,
					contextWindow: ws.data.contextWindow,
					contextPercent: ws.data.contextPercent,
				});
			}
			return Response.json({ rooms });
		}
		const activityMatch = url.pathname.match(new RegExp("^/activity/([^/]+)$"));
		if (activityMatch) {
			const agentName = decodeURIComponent(activityMatch[1]);
			let found: ServerWebSocket<AgentData> | null = null;
			for (const ws of agents.values()) {
				if (ws.data.name === agentName) { found = ws; break; }
			}
			if (!found) {
				return Response.json({
					agent: agentName,
					state: "idle",
					lastMessageReceivedAt: null,
					lastMessageSentAt: null,
					lastToolCallAt: null,
					lastToolCallName: null,
					toolCallsSinceLastMessage: 0,
					warning: "Agent not connected",
				});
			}
			const d = found.data;
			return Response.json({
				agent: agentName,
				state: d.state === "active" ? "busy" : "idle",
				lastMessageReceivedAt: d.lastMessageReceivedAt,
				lastMessageSentAt: d.lastMessageSentAt,
				lastToolCallAt: d.lastToolCallAt,
				lastToolCallName: d.lastToolCallName,
				toolCallsSinceLastMessage: d.toolCallsSinceLastMessage,
			});
		}
		if (server.upgrade(req, {
			data: {
				name: null, displayName: null, role: null, room: null,
				state: null, model: null,
				contextTokens: null, contextWindow: null, contextPercent: null,
				lastMessageReceivedAt: null, lastMessageSentAt: null,
				lastToolCallAt: null, lastToolCallName: null,
				toolCallsSinceLastMessage: 0,
			},
		})) return undefined;
		return new Response("Pi2Pi Broker — connect via WebSocket", { status: 200 });
	},
	websocket: {
		open(ws) {
			log("New connection (unregistered)");
		},

		message(ws, rawData) {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(String(rawData));
			} catch {
				send(ws, { type: "error", id: null, reason: "Invalid JSON" });
				return;
			}

			const { type, id, name, room, to, content, displayName, role } = msg as {
				type?: string; id?: string; name?: string; room?: string;
				to?: string; content?: string; displayName?: string; role?: string;
			};

			switch (type) {

				// ── REGISTER ──────────────────────────────────────────────────────────
				case "register": {
					const n = name?.trim();
					const r = room?.trim();
					if (!n) { send(ws, { type: "error", id: null, reason: "register requires a non-empty name" }); return; }
					if (!r) { send(ws, { type: "error", id: null, reason: "register requires a non-empty room" }); return; }

					const key = agentKey(r, n);

					// Evict previous connection with same name+room
					const existing = agents.get(key);
					if (existing && existing !== ws) {
						send(existing, { type: "error", id: null, reason: `Replaced by a new connection for "${n}" in room "${r}"` });
						try { existing.close(); } catch { /* ignore */ }
					}

					ws.data.name = n;
					ws.data.displayName = displayName?.trim() || n;
					ws.data.role = role?.trim() || null;
					ws.data.room = r;
					agents.set(key, ws);

					send(ws, { type: "registered", name: n, room: r });
					log(`"${n}" joined room "${r}". Members: [${roomMembers(r).join(", ")}]`);
					broadcastRoomList(r);
					if (isTTY) draw();
					break;
				}

				// ── STATUS ────────────────────────────────────────────────────────────
				case "status": {
					if (!ws.data.name || !ws.data.room) {
						send(ws, { type: "error", id: null, reason: "Must register before sending status" });
						return;
					}
					const { state, model, contextTokens, contextWindow, contextPercent } = msg as {
						state?: string;
						model?: unknown;
						contextTokens?: unknown;
						contextWindow?: unknown;
						contextPercent?: unknown;
					};
					if (state !== "active" && state !== "idle") {
						send(ws, { type: "error", id: null, reason: 'status requires state "active" or "idle"' });
						return;
					}
					ws.data.state = state;
					ws.data.model = typeof model === "string" ? model : null;
					ws.data.contextTokens = typeof contextTokens === "number" ? contextTokens : null;
					ws.data.contextWindow = typeof contextWindow === "number" ? contextWindow : null;
					ws.data.contextPercent = typeof contextPercent === "number" ? contextPercent : null;
					broadcastAgentStatus(ws);
					if (isTTY) draw();
					break;
				}

				// ── SEND MESSAGE ──────────────────────────────────────────────────────
				case "message": {
					const fromName = ws.data.name;
					const fromRoom = ws.data.room;
					if (!fromName || !fromRoom) {
						send(ws, { type: "error", id: id ?? null, reason: "Must register before sending messages" });
						return;
					}
					if (!id || !to || !content) {
						send(ws, { type: "error", id: id ?? null, reason: "message requires id, to, and content" });
						return;
					}

					const target = agents.get(agentKey(fromRoom, to));
					if (!target) {
						send(ws, { type: "error", id, reason: `Agent "${to}" is not in room "${fromRoom}"` });
						return;
					}

					pendingReplies.set(id, { originatorName: fromName, originatorRoom: fromRoom, targetName: to });
					target.data.lastMessageReceivedAt = new Date().toISOString();
					target.data.toolCallsSinceLastMessage = 0;
					send(target, { type: "incoming", id, from: fromName, content });
					log(`[${fromRoom}] "${fromName}" → "${to}" [${id}]: ${String(content).slice(0, 80)}`);
					break;
				}

				// ── REPLY ─────────────────────────────────────────────────────────────
				case "reply": {
					const fromName = ws.data.name;
					if (!fromName) {
						send(ws, { type: "error", id: id ?? null, reason: "Must register before sending replies" });
						return;
					}
					if (!id || content === undefined) {
						send(ws, { type: "error", id: id ?? null, reason: "reply requires id and content" });
						return;
					}

					const pending = pendingReplies.get(id);
					if (!pending) {
						send(ws, { type: "error", id, reason: `No pending message with id "${id}"` });
						return;
					}

					// Look up the originator's *current* WebSocket — they may have reconnected
					// since the message was sent, so we route by name rather than a cached socket.
					const originatorWs = agents.get(agentKey(pending.originatorRoom, pending.originatorName));
					if (!originatorWs) {
						send(ws, { type: "error", id, reason: `Originator "${pending.originatorName}" is no longer connected` });
						pendingReplies.delete(id);
						return;
					}

					pendingReplies.delete(id);
					ws.data.lastMessageSentAt = new Date().toISOString();
					send(originatorWs, { type: "reply_result", id, from: fromName, content });
					log(`[${ws.data.room}] "${fromName}" → "${pending.originatorName}" reply [${id}]: ${String(content).slice(0, 80)}`);
					break;
				}

				case "tool_call": {
					if (!ws.data.name || !ws.data.room) {
						send(ws, { type: "error", id: null, reason: "Must register before sending tool_call" });
						return;
					}
					const toolName = typeof msg.name === "string" ? msg.name.trim() : "";
					if (!toolName) {
						send(ws, { type: "error", id: null, reason: "tool_call requires a non-empty name" });
						return;
					}
					ws.data.lastToolCallAt = new Date().toISOString();
					ws.data.lastToolCallName = toolName;
					ws.data.toolCallsSinceLastMessage++;
					broadcastAgentStatus(ws);
					break;
				}

				default: {
					send(ws, { type: "error", id: id ?? null, reason: `Unknown message type: "${type}"` });
				}
			}
		},

		close(ws) {
			const { name, room } = ws.data;
			if (name && room) {
				agents.delete(agentKey(room, name));

				// Clean up pending replies involving this agent.
				// If this agent was the target: notify the originator (if still online) and drop the entry.
				// If this agent was the originator: keep the entry — they may reconnect and the
				// reply will be routed to their new socket when it arrives.
				for (const [msgId, { originatorName, originatorRoom, targetName }] of pendingReplies) {
					if (targetName === name && originatorRoom === room) {
						const originatorWs = agents.get(agentKey(originatorRoom, originatorName));
						if (originatorWs) {
							send(originatorWs, { type: "error", id: msgId, reason: `Agent "${name}" disconnected before replying` });
						}
						pendingReplies.delete(msgId);
					}
				}

				log(`"${name}" left room "${room}". Members: [${roomMembers(room).join(", ")}]`);
				broadcastRoomList(room);
			} else {
				log("Unregistered connection closed");
			}
			if (isTTY) draw();
		},
	},
});

log(`Pi2Pi broker listening on ws://localhost:${port}`);
log(`HTTP status: http://localhost:${port}/agents`);

if (isTTY) {
	draw();
}
