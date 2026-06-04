/**
 * Pi2Pi Broker
 *
 * A WebSocket message broker that enables communication between pi instances.
 * Run with: bun broker.ts [--port 7331]
 *
 * Protocol (JSON over WebSocket):
 *
 * Client → Broker:
 *   { type: "register", name: string, room: string }
 *   { type: "message",  id: string, to: string, content: string }
 *   { type: "reply",    id: string, content: string }
 *
 * Broker → Client:
 *   { type: "registered",  name: string, room: string }
 *   { type: "agent_list",  agents: string[], room: string }
 *   { type: "incoming",    id: string, from: string, content: string }
 *   { type: "reply_result",id: string, from: string, content: string }
 *   { type: "error",       id: string | null, reason: string }
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

type AgentData = { name: string | null; room: string | null };

// Keyed by "room/name"
const agents = new Map<string, ServerWebSocket<AgentData>>();

// Keyed by message id → { originator ws, targetName }
const pendingReplies = new Map<string, { originator: ServerWebSocket<AgentData>; targetName: string }>();

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

function broadcastRoomList(room: string) {
	const members = roomMembers(room);
	for (const ws of agents.values()) {
		if (ws.data.room === room) {
			send(ws, { type: "agent_list", agents: members, room });
		}
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

	// Gather rooms
	const rooms: Record<string, string[]> = {};
	let totalAgents = 0;
	for (const ws of agents.values()) {
		if (ws.data.name && ws.data.room) {
			const r = ws.data.room;
			const n = ws.data.name;
			(rooms[r] ??= []).push(n);
			totalAgents++;
		}
	}

	const roomList = Object.entries(rooms);
	let currentLine = 2; // Line 1 is the titleBar

	for (let i = 0; i < roomList.length && currentLine < topHeight; i++) {
		const [roomName, members] = roomList[i];
		const roomLine = `  [1;33m🏠 ${roomName}[0m`;
		const truncatedRoom = truncateAnsi(roomLine, width - 2);
		output += truncatedRoom + " ".repeat(Math.max(0, width - getVisibleLength(truncatedRoom))) + "\n";
		currentLine++;

		for (let j = 0; j < members.length && currentLine < topHeight; j++) {
			const isLast = j === members.length - 1;
			const branch = isLast ? "└─" : "├─";
			const agentLine = `    [90m${branch}[0m [32m${members[j]}[0m`;
			const truncatedAgent = truncateAnsi(agentLine, width - 2);
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
		const truncated = truncateAnsi(logLine, width - 2);
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
	const formatted = `[\u001B[90m${timestamp}\u001B[0m] ${msg}`;
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
			const rooms: Record<string, string[]> = {};
			for (const ws of agents.values()) {
				const r = ws.data.room ?? "(unknown)";
				const n = ws.data.name ?? "(unknown)";
				(rooms[r] ??= []).push(n);
			}
			return Response.json({ rooms });
		}
		if (server.upgrade(req, { data: { name: null, room: null } })) return undefined;
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

			const { type, id, name, room, to, content } = msg as {
				type?: string; id?: string; name?: string; room?: string;
				to?: string; content?: string;
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
					ws.data.room = r;
					agents.set(key, ws);

					send(ws, { type: "registered", name: n, room: r });
					log(`"${n}" joined room "${r}". Members: [${roomMembers(r).join(", ")}]`);
					broadcastRoomList(r);
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

					pendingReplies.set(id, { originator: ws, targetName: to });
					send(target, { type: "incoming", id, from: fromName, content });
					log(`[${fromRoom}] "${fromName}" → "${to}": ${String(content).slice(0, 80)}`);
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

					pendingReplies.delete(id);
					send(pending.originator, { type: "reply_result", id, from: fromName, content });
					log(`[${ws.data.room}] "${fromName}" replied to ${id}: ${String(content).slice(0, 80)}`);
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
				// If this agent was the target: notify the originator it will never reply.
				// If this agent was the originator: remove the entry to avoid a memory leak
				// (the eventual reply_result send would silently fail anyway).
				for (const [msgId, { originator, targetName }] of pendingReplies) {
					if (targetName === name) {
						send(originator, { type: "error", id: msgId, reason: `Agent "${name}" disconnected before replying` });
						pendingReplies.delete(msgId);
					} else if (originator === ws) {
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

