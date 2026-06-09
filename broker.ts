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

function truncateAnsi(str: string, limit: number): string {
	let visibleCount = 0;
	let result = "";
	let inAnsi = false;

	for (let i = 0; i < str.length; i++) {
		const char = str[i];
		if (char === "\u001B") {
			inAnsi = true;
		}

		if (inAnsi) {
			result += char;
			if (char === "m") {
				inAnsi = false;
			}
		} else {
			if (visibleCount < limit) {
				result += char;
				visibleCount++;
			} else {
				result += "\u001B[0m"; // Ensure style reset
				break;
			}
		}
	}
	return result;
}

function getVisibleLength(str: string): number {
	return str.replace(/\u001B\[\d+(;\d+)*m/g, "").length;
}

/** Format a token count compactly: 52000 → "52k", 1500000 → "1.5M", null → "—" */
function fmtTokens(n: number | null): string {
	if (n === null) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function draw() {
	if (!isTTY) return;

	const width = process.stdout.columns || 80;
	const height = process.stdout.rows || 24;

	// 40% top pane, 60% bottom pane
	const topHeight = Math.max(5, Math.floor(height * 0.4));
	const dividerRow = topHeight + 1;
	const bottomHeight = height - dividerRow;

	let output = "\u001B[H"; // Move to home (1,1)

	// --- Top Pane: Title ---
	const title = " Pi2Pi Broker — Rooms & Agents ";
	const titleBar = "─".repeat(3) + title + "─".repeat(Math.max(0, width - title.length - 3));
	output += `\u001B[1;36m${titleBar}\u001B[0m\n`;

	// Gather rooms with full agent status data
	type RoomEntry = {
		name: string;
		displayName: string;
		state: "active" | "idle" | null;
		model: string | null;
		contextTokens: number | null;
		contextWindow: number | null;
		contextPercent: number | null;
	};
	const rooms: Record<string, RoomEntry[]> = {};
	let totalAgents = 0;
	for (const ws of agents.values()) {
		if (ws.data.name && ws.data.room) {
			const r = ws.data.room;
			(rooms[r] ??= []).push({
				name: ws.data.name,
				displayName: ws.data.displayName ?? ws.data.name,
				state: ws.data.state,
				model: ws.data.model,
				contextTokens: ws.data.contextTokens,
				contextWindow: ws.data.contextWindow,
				contextPercent: ws.data.contextPercent,
			});
			totalAgents++;
		}
	}

	const roomList = Object.entries(rooms);
	let currentLine = 2; // Line 1 is the titleBar

	for (let i = 0; i < roomList.length && currentLine < topHeight; i++) {
		const [roomName, entries] = roomList[i];
		const roomLine = `  \u001B[1;33m🏠 ${roomName}\u001B[0m`;
		const truncatedRoom = truncateAnsi(roomLine, width - 2);
		output += truncatedRoom + " ".repeat(Math.max(0, width - getVisibleLength(truncatedRoom))) + "\n";
		currentLine++;

		// ── Compute per-room column widths for alignment ─────────────────────
		// name column: widest agent name
		const nameWidth = Math.max(...entries.map(e => e.displayName.length));
		// model column: widest model string (or "—" placeholder)
		const modelWidth = Math.max(...entries.map(e => (e.model ?? "—").length));
		// token column: widest "tokens/window" string e.g. "52k/128k"
		const tokWidth = Math.max(...entries.map(e =>
			`${fmtTokens(e.contextTokens)}/${fmtTokens(e.contextWindow)}`.length
		));

		for (let j = 0; j < entries.length && currentLine < topHeight; j++) {
			const e = entries[j];
			const isLast = j === entries.length - 1;
			const branch = isLast ? "└─" : "├─";

			// State column — fixed width: "● active" (8) / "○ idle  " (8)
			const isActive = e.state === "active";
			const hasState = e.state !== null;
			const stateDot   = isActive ? "●" : "○";
			const stateLabel = isActive ? "active" : (hasState ? "idle  " : "?     ");
			const stateColor = isActive ? "\u001B[32m" : "\u001B[90m";

			// Model column — padded to widest
			const model = (e.model ?? "—").padEnd(modelWidth);

			// Context bar — 8 blocks, colour by fill level
			const pct = e.contextPercent;
			const barColor = pct === null
				? "\u001B[90m"
				: pct >= 80 ? "\u001B[31m"
				: pct >= 50 ? "\u001B[33m"
				: "\u001B[32m";
			const filled = pct === null ? 0 : Math.min(8, Math.round((pct / 100) * 8));
			const bar = "█".repeat(filled) + "░".repeat(8 - filled);

			// Percentage column — right-aligned in 4 chars ("100%" / " 42%" / "  —%")
			const pctStr = pct === null ? "  —%" : `${Math.round(pct)}%`.padStart(4);

			// Token counts column — padded to widest
			const tokStr = `${fmtTokens(e.contextTokens)}/${fmtTokens(e.contextWindow)}`.padEnd(tokWidth);

			// Name column — padded to widest
			const namePad = e.displayName.padEnd(nameWidth);

			const agentLine =
				`    \u001B[90m${branch}\u001B[0m ` +
				`\u001B[32m${namePad}\u001B[0m  ` +
				`${stateColor}${stateDot} ${stateLabel}\u001B[0m  ` +
				`\u001B[90m${model}\u001B[0m  ` +
				`${barColor}[${bar}]\u001B[0m ` +
				`${pctStr}  ` +
				`\u001B[90m(${tokStr})\u001B[0m`;

			const truncatedAgent = truncateAnsi(agentLine, width - 1);
			output += truncatedAgent + " ".repeat(Math.max(0, width - getVisibleLength(truncatedAgent))) + "\n";
			currentLine++;
		}
	}

	if (roomList.length === 0 && currentLine < topHeight) {
		const line = "  (No registered agents)";
		output += line + " ".repeat(Math.max(0, width - line.length)) + "\n";
		currentLine++;
	}

	while (currentLine < topHeight) {
		output += " ".repeat(width) + "\n";
		currentLine++;
	}

	// --- Divider Line ---
	const divTitle = ` Logs (Total active agents: \u001B[1;32m${totalAgents}\u001B[1;36m) `;
	const visualDivTitle = divTitle.replace(/\u001B\[\d+(;\d+)*m/g, "");
	const divider = "─".repeat(3) + divTitle + "─".repeat(Math.max(0, width - visualDivTitle.length - 3));
	output += `\u001B[1;36m${divider}\u001B[0m\n`;

	// --- Bottom Pane: Logs ---
	const visibleLogsCount = bottomHeight;
	const startIndex = Math.max(0, logBuffer.length - visibleLogsCount);
	const visibleLogs = logBuffer.slice(startIndex, startIndex + visibleLogsCount);

	let logLineCount = 0;
	for (const logLine of visibleLogs) {
		// Strip any newlines that may have survived (defensive) and truncate
		// to terminal width so no line can wrap onto a second row.
		const singleLine = logLine.replace(/\r\n|\r|\n/g, " ");
		const truncated = truncateAnsi(singleLine, width - 1);
		const padding = " ".repeat(Math.max(0, width - getVisibleLength(truncated)));
		output += truncated + padding + "\n";
		logLineCount++;
	}

	while (logLineCount < bottomHeight) {
		output += " ".repeat(width) + "\n";
		logLineCount++;
	}

	process.stdout.write(output);
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
