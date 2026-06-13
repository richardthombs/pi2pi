/**
 * Pi2Pi Extension
 *
 * Enables peer-to-peer messaging between pi instances via a shared broker.
 * Supports either a single room (`--room`) or multiple named room bindings
 * (`--rooms team=engineering,leadership=leadership`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

const BROKER_DEFAULT = "ws://localhost:7331";
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 20;

type AgentState = "active" | "idle";

type RoomMember = {
	name: string;
	displayName: string;
	role: string | null;
	state: "active" | "idle" | null;
	lastMessageReceivedAt: string | null;
	lastMessageSentAt: string | null;
	lastToolCallAt: string | null;
	lastToolCallName: string | null;
	toolCallsSinceLastMessage: number;
	contextPercent: number | null;
};

type RoomConnection = {
	alias: string;
	room: string;
	ws: WebSocket | null;
	onlineAgents: string[];
	roster: RoomMember[];
	reconnectAttempts: number;
};

type ReplyEntry = {
	id: string;
	from: string;
	content: string;
	receivedAt: Date;
	claimed: boolean;
	roomAlias: string;
};

type PendingIncoming = {
	id: string;
	from: string;
	roomAlias: string;
};

type SentEntry = {
	id: string;
	to: string;
	message: string;
	roomAlias: string;
	sentAt: Date;
	repliedAt?: Date;
};

export default function (pi: ExtensionAPI) {
	// ── Flags ────────────────────────────────────────────────────────────────
	pi.registerFlag("agent-name", {
		description: "Name for this pi instance (used by other agents to address you)",
		type: "string",
	});
	pi.registerFlag("room", {
		description: "Single room to join (backwards-compatible alias for --rooms <room>)",
		type: "string",
	});
	pi.registerFlag("display-name", {
		description: "Optional human-friendly display name shown in broker UIs",
		type: "string",
	});
	pi.registerFlag("room-display-names", {
		description: "Optional per-room display names, e.g. team=Alice,leadership=blackbird team",
		type: "string",
	});
	pi.registerFlag("agent-role", {
		description: "Optional role label shown in broker UIs and room membership summaries",
		type: "string",
	});
	pi.registerFlag("rooms", {
		description: "Comma-separated room bindings, e.g. team=engineering,leadership=leadership",
		type: "string",
	});
	pi.registerFlag("default-room", {
		description: "Default room alias to use when tell/who omit a room",
		type: "string",
	});
	pi.registerFlag("broker", {
		description: `Broker WebSocket URL (default: ${BROKER_DEFAULT})`,
		type: "string",
	});

	// ── State ────────────────────────────────────────────────────────────────
	let agentName: string | null = null;
	let brokerUrl: string = BROKER_DEFAULT;
	let defaultRoomAlias: string | null = null;
	let displayName: string | null = null;
	let agentRole: string | null = null;
	const roomDisplayNames = new Map<string, string>();
	let shutdownRequested = false;

	const roomConnections = new Map<string, RoomConnection>();

	let uiNotify: ((msg: string, level?: "info" | "warning" | "error") => void) | null = null;
	let uiSetStatus: ((id: string, text: string | undefined) => void) | null = null;

	let agentModel: string | null = null;
	let agentState: AgentState = "idle";
	let getContextUsage: (() => { tokens: number | null; contextWindow: number; percent: number | null } | undefined) | null = null;

	const incomingQueue = new Map<string, PendingIncoming>();
	const pendingOutgoing = new Map<string, { to: string; message: string; sentAt: Date; roomAlias: string }>();
	const pendingDelivery = new Map<string, { reject: (reason: string) => void; resolve: () => void }>();
	const sentHistory = new Map<string, SentEntry>();
	const replyBuffer = new Map<string, ReplyEntry>();
	const replyWaiters = new Map<string, () => void>();
	const readReplyMeta = new Map<string, { from: string; roomAlias: string }>();
	let agentTurnActive = false;

	const MAX_SENT_HISTORY = 100;

	function orderedConnections(): RoomConnection[] {
		return [...roomConnections.values()];
	}

	function roomLabel(connection: RoomConnection): string {
		return roomConnections.size === 1 ? `#${connection.room}` : `${connection.alias}(#${connection.room})`;
	}

	function addToHistory(id: string, to: string, message: string, roomAlias: string) {
		sentHistory.set(id, { id, to, message, roomAlias, sentAt: new Date() });
		if (sentHistory.size > MAX_SENT_HISTORY) {
			sentHistory.delete(sentHistory.keys().next().value!);
		}
	}

	function notify(msg: string, level: "info" | "warning" | "error" | "success" = "info") {
		// pi's notify API does not include "success"; map it to "info"
		uiNotify?.(msg, level === "success" ? "info" : level);
	}

	function setStatus(text: string | undefined) {
		uiSetStatus?.("pi2pi", text);
	}

	function normalizeRoomInput(input: string): string {
		return input.trim().replace(/^#/, "");
	}

	function tryResolveRoom(input: string): RoomConnection | null {
		const normalized = normalizeRoomInput(input);
		const byAlias = roomConnections.get(normalized);
		if (byAlias) return byAlias;
		return orderedConnections().find(connection => connection.room === normalized) ?? null;
	}

	function resolveRoom(input?: string): RoomConnection {
		if (input?.trim()) {
			const resolved = tryResolveRoom(input.trim());
			if (!resolved) throw new Error(`Pi2Pi: unknown room alias or room name \"${input}\"`);
			return resolved;
		}
		if (!defaultRoomAlias) throw new Error("Pi2Pi: no default room configured");
		const resolved = roomConnections.get(defaultRoomAlias);
		if (!resolved) throw new Error(`Pi2Pi: default room alias \"${defaultRoomAlias}\" is not connected`);
		return resolved;
	}

	function parseRoomBindings(): { bindings: Array<{ alias: string; room: string }>; defaultAlias: string } {
		const roomsFlag = (pi.getFlag("rooms") as string | undefined)?.trim();
		const roomFlag = (pi.getFlag("room") as string | undefined)?.trim();
		const spec = roomsFlag || roomFlag;
		if (!spec) throw new Error("Pi2Pi: restart with --room <room> or --rooms <alias=room,...>");

		const bindings = spec
			.split(",")
			.map(item => item.trim())
			.filter(Boolean)
			.map(item => {
				const eq = item.indexOf("=");
				if (eq === -1) return { alias: item, room: item };
				return {
					alias: item.slice(0, eq).trim(),
					room: item.slice(eq + 1).trim(),
				};
			});

		if (bindings.length === 0) throw new Error("Pi2Pi: no valid room bindings were parsed");
		for (const binding of bindings) {
			if (!binding.alias || !binding.room) throw new Error(`Pi2Pi: invalid room binding \"${binding.alias}=${binding.room}\"`);
		}
		const aliases = new Set<string>();
		for (const binding of bindings) {
			if (aliases.has(binding.alias)) throw new Error(`Pi2Pi: duplicate room alias \"${binding.alias}\"`);
			aliases.add(binding.alias);
		}

		const explicitDefault = (pi.getFlag("default-room") as string | undefined)?.trim();
		if (explicitDefault) {
			const resolved = bindings.find(binding => binding.alias === explicitDefault || binding.room === explicitDefault);
			if (!resolved) throw new Error(`Pi2Pi: default room \"${explicitDefault}\" is not one of the configured room bindings`);
			return { bindings, defaultAlias: resolved.alias };
		}

		return { bindings, defaultAlias: bindings[0].alias };
	}

	function configureRooms(bindings: Array<{ alias: string; room: string }>, defaultAlias: string) {
		roomConnections.clear();
		for (const binding of bindings) {
			roomConnections.set(binding.alias, {
				alias: binding.alias,
				room: binding.room,
				ws: null,
				onlineAgents: [],
				roster: [],
				reconnectAttempts: 0,
			});
		}
		defaultRoomAlias = defaultAlias;
	}

	function configureRoomDisplayNames(bindings: Array<{ alias: string; room: string }>) {
		roomDisplayNames.clear();
		const raw = (pi.getFlag("room-display-names") as string | undefined)?.trim();
		if (!raw) return;

		for (const item of raw.split(",").map(part => part.trim()).filter(Boolean)) {
			const eq = item.indexOf("=");
			if (eq === -1) throw new Error(`Pi2Pi: invalid room display name binding "${item}"`);
			const target = item.slice(0, eq).trim();
			const value = item.slice(eq + 1).trim();
			if (!target || !value) throw new Error(`Pi2Pi: invalid room display name binding "${item}"`);
			const binding = bindings.find(candidate => candidate.alias === target || candidate.room === target);
			if (!binding) throw new Error(`Pi2Pi: room display name target "${target}" is not one of the configured room bindings`);
			roomDisplayNames.set(binding.alias, value);
		}
	}

	function displayNameForConnection(connection: RoomConnection): string {
		return roomDisplayNames.get(connection.alias) ?? displayName ?? agentName ?? connection.alias;
	}

	function friendlyName(connection: RoomConnection, name: string): string {
		if (name === "everyone") return name;
		return connection.roster.find(member => member.name === name)?.displayName ?? name;
	}

	function formatMember(member: RoomMember): string {
		return member.role ? `${member.displayName} (${member.role})` : member.displayName;
	}

	function resolveTargetName(connection: RoomConnection, requested: string): string {
		const trimmed = requested.trim();
		if (!trimmed) throw new Error("Pi2Pi: target name cannot be empty");
		if (trimmed === "everyone") return trimmed;
		if (connection.onlineAgents.includes(trimmed)) return trimmed;

		const normalized = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
		const matches = connection.roster.filter(member => {
			const display = member.displayName.trim().toLowerCase();
			const withRole = formatMember(member).trim().toLowerCase();
			return display === normalized || withRole === trimmed.toLowerCase() || display === trimmed.toLowerCase();
		});

		if (matches.length === 1) return matches[0].name;
		if (matches.length > 1) {
			throw new Error(`Pi2Pi: target \"${requested}\" is ambiguous in ${roomLabel(connection)}; matches: ${matches.map(formatMember).join(", ")}`);
		}
		return trimmed;
	}

	function refreshStatus() {
		if (!agentName) return;
		const identity = `${displayName ?? agentName}${agentRole ? ` (${agentRole})` : ""}`;
		const roomSummary = orderedConnections().map(connection => {
			const others = connection.roster.filter(member => member.name !== agentName);
			const membersText = others.length > 0
				? others.map(formatMember).join(", ")
				: "";
			return `${connection.room}: [${membersText}]`;
		}).join(" | ");
		const waiting = pendingOutgoing.size ? ` | waiting: ${pendingOutgoing.size}` : "";
		setStatus(`● ${identity}${roomSummary ? ` | ${roomSummary}` : ""}${waiting}`);
	}

	function sendStatus() {
		const usage = getContextUsage?.();
		for (const connection of orderedConnections()) {
			if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN || !agentName) continue;
			connection.ws.send(JSON.stringify({
				type: "status",
				state: agentState,
				model: agentModel,
				contextTokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? null,
				contextPercent: usage?.percent ?? null,
			}));
		}
	}

	function scheduleReconnect(connection: RoomConnection) {
		if (shutdownRequested) return;
		connection.reconnectAttempts++;
		if (connection.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
			setStatus(`✖ ${agentName} — broker unreachable (${connection.alias})`);
			return;
		}
		const delay = Math.min(RECONNECT_DELAY_MS * connection.reconnectAttempts, 30_000);
		setTimeout(() => {
			if (!shutdownRequested) connectToBroker(connection);
		}, delay);
	}

	function handleBrokerMessage(roomAlias: string, rawData: string) {
		const connection = roomConnections.get(roomAlias);
		if (!connection) return;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(rawData);
		} catch {
			return;
		}

		const { type, id, name, from, content, agents, roster, reason } = msg as {
			type?: string;
			id?: string;
			name?: string;
			from?: string;
			content?: string;
			agents?: string[];
			roster?: Array<{ name?: string; displayName?: string; role?: string | null; state?: string | null; lastMessageReceivedAt?: string | null; lastMessageSentAt?: string | null; lastToolCallAt?: string | null; lastToolCallName?: string | null; toolCallsSinceLastMessage?: number }>;
			reason?: string;
		};

		switch (type) {
			case "registered": {
				connection.reconnectAttempts = 0;
				notify(`Registered as \"${name}\" in ${roomLabel(connection)} on ${brokerUrl}`, "success");
				refreshStatus();
				sendStatus();
				break;
			}

			case "agent_list": {
				connection.onlineAgents = agents ?? [];
				connection.roster = (roster ?? []).flatMap(member => {
					if (!member.name) return [];
					return [{
						name: member.name,
						displayName: member.displayName?.trim() || member.name,
						role: member.role ?? null,
						state: (member.state === "active" || member.state === "idle") ? member.state : null,
						lastMessageReceivedAt: member.lastMessageReceivedAt ?? null,
						lastMessageSentAt: member.lastMessageSentAt ?? null,
						lastToolCallAt: member.lastToolCallAt ?? null,
						lastToolCallName: member.lastToolCallName ?? null,
						toolCallsSinceLastMessage: member.toolCallsSinceLastMessage ?? 0,
						contextPercent: (member as Record<string, unknown>).contextPercent as number | null ?? null,
					}];
				});
				if (connection.roster.length === 0) {
					connection.roster = connection.onlineAgents.map(memberName => ({
						name: memberName,
						displayName: memberName,
						role: null,
						state: null,
						lastMessageReceivedAt: null,
						lastMessageSentAt: null,
						lastToolCallAt: null,
						lastToolCallName: null,
						toolCallsSinceLastMessage: 0,
						contextPercent: null,
					}));
				}
				refreshStatus();
				break;
			}

				case "incoming": {
				if (!id || !from || content === undefined) return;
				const fromDisplay = friendlyName(connection, from);
				incomingQueue.set(id, { id, from, roomAlias });
				// Decorate telemetry with task context if the extension is loaded
				pi.events.emit("telemetry:annotate", {
					pi2pi_message_id: id,
					from_agent: from,
					overlord_request: content,
					role: agentRole ?? "",
					team: roomLabel(connection),
				});
				pi.sendMessage({
					customType: "pi2pi-incoming",
					content: `Message from ${fromDisplay} in ${roomLabel(connection)} [id: ${id}]: ${content}\n\nUse the reply tool with id=\"${id}\" to send your response.`,
					display: true,
					details: { from: fromDisplay, message: content, roomLabel: roomLabel(connection) },
				}, { triggerTurn: true, deliverAs: "followUp" });
				break;
			}

			case "reply_result": {
				if (!id || !from || content === undefined) return;
				pendingOutgoing.delete(id);
				const histEntry = sentHistory.get(id);
				if (histEntry) histEntry.repliedAt = new Date();
				refreshStatus();

				const entry: ReplyEntry = {
					id,
					from,
					content,
					receivedAt: new Date(),
					claimed: false,
					roomAlias,
				};

				const waiter = replyWaiters.get(id);
				if (waiter) {
					replyWaiters.delete(id);
					replyBuffer.set(id, entry);
					waiter();
				} else if (!agentTurnActive) {
					entry.claimed = true;
					const fromDisplay = friendlyName(connection, from);
					pi.sendMessage({
						customType: "pi2pi-reply",
						content: `[Incoming message received from ${fromDisplay} in ${roomLabel(connection)}, id: ${id}]\n${fromDisplay}: ${content}`,
						display: true,
						details: { from: fromDisplay, full: content, roomLabel: roomLabel(connection) },
					}, { triggerTurn: true, deliverAs: "followUp" });
				} else {
					replyBuffer.set(id, entry);
				}
				break;
			}

			case "agent_status": {
				const statusMsg = msg as { name?: string; state?: string; lastToolCallAt?: string; lastToolCallName?: string; toolCallsSinceLastMessage?: number; lastMessageReceivedAt?: string; lastMessageSentAt?: string; contextPercent?: number | null };
				if (statusMsg.name) {
					const entry = connection.roster.find(m => m.name === statusMsg.name);
					if (entry) {
						entry.state = (statusMsg.state === "active" || statusMsg.state === "idle") ? statusMsg.state : entry.state;
						if (statusMsg.lastToolCallAt !== undefined) entry.lastToolCallAt = statusMsg.lastToolCallAt ?? null;
						if (statusMsg.lastToolCallName !== undefined) entry.lastToolCallName = statusMsg.lastToolCallName ?? null;
						if (statusMsg.toolCallsSinceLastMessage !== undefined) entry.toolCallsSinceLastMessage = statusMsg.toolCallsSinceLastMessage ?? 0;
						if (statusMsg.lastMessageReceivedAt !== undefined) entry.lastMessageReceivedAt = statusMsg.lastMessageReceivedAt ?? null;
						if (statusMsg.lastMessageSentAt !== undefined) entry.lastMessageSentAt = statusMsg.lastMessageSentAt ?? null;
					if (statusMsg.contextPercent !== undefined) entry.contextPercent = statusMsg.contextPercent ?? null;
					}
				}
				break;
			}

			case "error": {
				const forId = id ? ` (id ${id})` : "";
				notify(`Broker error in ${roomLabel(connection)}${forId}: ${reason ?? "unknown"}`, "error");
				if (id) {
					pendingDelivery.get(id)?.reject(reason ?? "unknown error");
					pendingDelivery.delete(id);
					pendingOutgoing.delete(id);
					refreshStatus();
				}
				break;
			}
		}
	}

	function connectToBroker(connection: RoomConnection) {
		if (shutdownRequested || !agentName) return;

		let ws: WebSocket;
		try {
			ws = new WebSocket(brokerUrl);
		} catch {
			scheduleReconnect(connection);
			return;
		}

		connection.ws = ws;
		ws.addEventListener("open", () => {
			connection.reconnectAttempts = 0;
			ws.send(JSON.stringify({ type: "register", name: agentName, room: connection.room, displayName: displayNameForConnection(connection), role: agentRole }));
		});
		ws.addEventListener("message", event => {
			handleBrokerMessage(connection.alias, String((event as { data?: unknown }).data));
		});
		ws.addEventListener("close", () => {
			connection.ws = null;
			connection.onlineAgents = [];
			connection.roster = [];
			refreshStatus();
			if (!shutdownRequested) {
				setStatus(`⚠ ${agentName} — disconnected from ${connection.alias}`);
				scheduleReconnect(connection);
			}
		});
	}

	// ── Custom message renderers ─────────────────────────────────────────────

	pi.registerMessageRenderer("pi2pi-sent", (message, _options, theme) => {
		const details = message.details as { to: string; broadcast?: boolean; roomLabel?: string } | undefined;
		const to = details?.to ?? "?";
		const roomText = details?.roomLabel ? theme.fg("muted", ` ${details.roomLabel}`) : "";
		const isBroadcast = details?.broadcast ?? false;
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		const toLabel = isBroadcast ? theme.fg("warning", "everyone") : theme.fg("accent", to);
		const label = theme.fg("muted", "Asked ") + toLabel + roomText + theme.fg("muted", ": ");
		box.addChild(new Text(label + theme.fg("dim", message.content as string), 0, 0));
		return box;
	});

	pi.registerMessageRenderer("pi2pi-reply", (message, { expanded }, theme) => {
		const details = message.details as { from: string; full: string; roomLabel?: string } | undefined;
		const from = details?.from ?? "?";
		const full = details?.full ?? message.content;
		const roomText = details?.roomLabel ? theme.fg("muted", ` ${details.roomLabel}`) : "";
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		const label = theme.fg("accent", `${from}`) + roomText + theme.fg("muted", " replied: ");
		const preview = full.length > 300 && !expanded ? full.slice(0, 300) + "…" : full;
		box.addChild(new Text(label + preview, 0, 0));
		return box;
	});

	pi.registerMessageRenderer("pi2pi-incoming", (message, { expanded }, theme) => {
		const details = message.details as { from: string; message: string; roomLabel?: string } | undefined;
		const from = details?.from ?? "?";
		const full = details?.message ?? message.content;
		const roomText = details?.roomLabel ? theme.fg("muted", ` ${details.roomLabel}`) : "";
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		const label = theme.fg("accent", `${from}`) + roomText + theme.fg("muted", ": ");
		const preview = full.length > 300 && !expanded ? full.slice(0, 300) + "…" : full;
		box.addChild(new Text(label + preview, 0, 0));
		return box;
	});

	pi.registerMessageRenderer("pi2pi-pending", (message, _options, theme) => {
		const details = message.details as { messages: Array<{ id: string; to: string; message: string; roomAlias: string; sentAt: string; repliedAt?: string }> } | undefined;
		const messages = details?.messages ?? [];
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		if (messages.length === 0) {
			box.addChild(new Text(theme.fg("muted", "No messages sent yet."), 0, 0));
		} else {
			const header = theme.fg("accent", `📨 Sent messages (${messages.length})`) + "\n";
			const lines = messages.map(p => {
				const status = p.repliedAt ? theme.fg("success", "✓") : theme.fg("warning", "⏳");
				const time = p.repliedAt
					? theme.fg("muted", `replied ${new Date(p.repliedAt).toLocaleTimeString()}`)
					: theme.fg("muted", `sent ${new Date(p.sentAt).toLocaleTimeString()}`);
				return status + " " +
					theme.fg("accent", p.to) +
					theme.fg("dim", ` [${p.roomAlias}, id: ${p.id}]`) +
					theme.fg("muted", ` — \"${p.message}\" (`) +
					time +
					theme.fg("muted", ")");
			});
			box.addChild(new Text(header + lines.join("\n"), 0, 0));
		}
		return box;
	});

	// ── Status helpers ──────────────────────────────────────────────────────────────────

	function relativeTime(iso: string | null): string {
		if (!iso) return "—";
		const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
		if (secs < 60) return `${secs}s ago`;
		const mins = Math.floor(secs / 60);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours <= 5) return `${hours}h ago`;
		return ">5h ago";
	}

	function activityDescriptor(member: RoomMember, now: Date): string {
		if (member.state === null) return "unknown";
		if (member.state === "idle") return "—";
		// active
		if (!member.lastToolCallAt) return "waiting";
		const ageSecs = (now.getTime() - new Date(member.lastToolCallAt).getTime()) / 1000;
		if (ageSecs <= 120) return member.lastToolCallName ?? "working";
		return "thinking";
	}

	function formatStatusLine(member: RoomMember, now: Date): string {
		const glyph = member.state === "active" ? "◉" : member.state === "idle" ? "○" : "?";
		const name = (member.displayName ?? member.name).slice(0, 12).padEnd(12);
		const role = (member.role ?? "").slice(0, 10).padEnd(10);
		const activity = activityDescriptor(member, now).slice(0, 14).padEnd(14);
		const timestamps = [member.lastToolCallAt, member.lastMessageSentAt].filter(Boolean).sort() as string[];
		const elapsed = relativeTime(timestamps.length ? timestamps[timestamps.length - 1] : null).padEnd(10);
		const pct = member.contextPercent === null || member.contextPercent === undefined
			? "[—]"
			: member.contextPercent >= 80
				? `[${Math.round(member.contextPercent)}%!]`
				: `[${Math.round(member.contextPercent)}%]`;
		return `  ${glyph}  ${name}  ${role}  ${activity}  ${elapsed}  ${pct}`;
	}

	pi.registerMessageRenderer("pi2pi-who", (message, _options, theme) => {
		const details = message.details as { self: string; roomLabel: string; members: Array<{ displayName: string; role?: string | null; self?: boolean }> } | undefined;
		const self = details?.self ?? "?";
		const roomLabelText = details?.roomLabel ?? "?";
		const members = details?.members ?? [];
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		let text = theme.fg("accent", `👥 Room: ${roomLabelText}`) + theme.fg("muted", "\n");
		if (members.length === 0) {
			text += theme.fg("muted", `  ● ${self} (you)`);
		} else {
			text += members.map(member => {
				const suffix = member.self ? " (you)" : "";
				const role = member.role ? ` — ${member.role}` : "";
				return theme.fg("success", "  ● ") + theme.fg("accent", member.displayName) + theme.fg("dim", `${role}${suffix}`);
			}).join("\n");
		}
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerMessageRenderer("pi2pi-status", (message, _options, theme) => {
		const details = message.details as { roomLabel: string; members: RoomMember[] } | undefined;
		const roomLabelText = details?.roomLabel ?? "?";
		const members = details?.members ?? [];
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		let text = theme.fg("accent", `── ${roomLabelText} ── ${members.length} agent${members.length !== 1 ? "s" : ""} `) + theme.fg("muted", "\n");
		if (members.length === 0) {
			text += theme.fg("muted", "  no agents connected");
		} else {
			const now = new Date();
			text += members.map(m => theme.fg(m.state === "active" ? "success" : "muted", formatStatusLine(m, now))).join("\n");
		}
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// ── Lifecycle events ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		shutdownRequested = false;
		uiNotify = ctx.ui.notify.bind(ctx.ui) as typeof uiNotify;
		uiSetStatus = ctx.ui.setStatus.bind(ctx.ui);
		agentModel = ctx.model ? (ctx.model.name || ctx.model.id) : null;
		getContextUsage = ctx.getContextUsage.bind(ctx);
		brokerUrl = ((pi.getFlag("broker") as string | undefined) ?? BROKER_DEFAULT).trim();

		const flagName = (pi.getFlag("agent-name") as string | undefined)?.trim();
		if (!flagName) {
			ctx.ui.setStatus("pi2pi", "✖ pi2pi — restart with --agent-name <name>");
			return;
		}
		agentName = flagName;
		displayName = ((pi.getFlag("display-name") as string | undefined)?.trim()) || agentName;
		agentRole = ((pi.getFlag("agent-role") as string | undefined)?.trim()) || null;

		try {
			const parsed = parseRoomBindings();
			configureRooms(parsed.bindings, parsed.defaultAlias);
			configureRoomDisplayNames(parsed.bindings);
		} catch (error) {
			ctx.ui.setStatus("pi2pi", `✖ ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		ctx.ui.setStatus("pi2pi", `○ ${agentName} — connecting…`);
		for (const connection of orderedConnections()) {
			connectToBroker(connection);
		}
	});

	pi.on("session_shutdown", async () => {
		shutdownRequested = true;
		uiNotify = null;
		uiSetStatus = null;
		agentModel = null;
		agentState = "idle";
		getContextUsage = null;
		agentName = null;
		displayName = null;
		agentRole = null;
		roomDisplayNames.clear();
		defaultRoomAlias = null;
		incomingQueue.clear();
		pendingOutgoing.clear();
		pendingDelivery.clear();
		sentHistory.clear();
		replyBuffer.clear();
		readReplyMeta.clear();
		for (const resolve of replyWaiters.values()) resolve();
		replyWaiters.clear();
		for (const connection of orderedConnections()) {
			connection.onlineAgents = [];
			connection.roster = [];
			if (connection.ws) {
				try {
					connection.ws.close();
				} catch {}
				connection.ws = null;
			}
		}
		roomConnections.clear();
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentTurnActive = true;
		agentState = "active";
		getContextUsage = ctx.getContextUsage.bind(ctx);
		sendStatus();
	});

	pi.on("model_select", async (event, ctx) => {
		agentModel = (event.model.name || event.model.id) ?? null;
		getContextUsage = ctx.getContextUsage.bind(ctx);
		sendStatus();
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentTurnActive = false;
		agentState = "idle";
		getContextUsage = ctx.getContextUsage.bind(ctx);
		sendStatus();
		for (const [id, entry] of replyBuffer) {
			replyBuffer.delete(id);
			if (entry.claimed) continue;
			const connection = roomConnections.get(entry.roomAlias);
			const fromDisplay = connection ? friendlyName(connection, entry.from) : entry.from;
			pi.sendMessage({
				customType: "pi2pi-reply",
				content: `[Incoming message received from ${fromDisplay} in ${connection ? roomLabel(connection) : entry.roomAlias}, id: ${entry.id}]\n${fromDisplay}: ${entry.content}`,
				display: true,
				details: { from: fromDisplay, full: entry.content, roomLabel: connection ? roomLabel(connection) : entry.roomAlias },
			}, { triggerTurn: true, deliverAs: "followUp" });
		}
	});


	// ── Tool call emission ───────────────────────────────────────────────────
	// Fires before every tool execution. Notifies the broker so leaders can
	// query GET /activity/:name to see live tool-call activity.
	//
	// Integration test: run `bun broker.ts`, launch pi with
	//   `--agent-name Alice --room test`
	// Execute any tool, then verify:
	//   GET /activity/Alice → { lastToolCallAt: <iso>, lastToolCallName: <name>, toolCallsSinceLastMessage: N }
	pi.on("tool_execution_start", async (event) => {
		for (const connection of orderedConnections()) {
			if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN || !agentName) continue;
			connection.ws.send(JSON.stringify({ type: "tool_call", name: event.toolName }));
		}
	});

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "tell",
		label: "Tell",
		description: "Send a message to another agent and return immediately. If you are in multiple rooms, specify the room alias.",
		promptSnippet: "Send a message to another pi agent (fire-and-forget; reply arrives automatically)",
		parameters: Type.Object({
			to: Type.String({ description: 'Agent name to message, or "everyone" to broadcast to all connected agents in the selected room' }),
			message: Type.String({ description: "Message to send" }),
			room: Type.Optional(Type.String({ description: "Optional room alias or room name to send into" })),
		}),
		renderCall(args, theme, context) {
			const t = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const roomText = args.room ? theme.fg("muted", ` ${args.room}`) : "";
			let content = theme.fg("muted", "Asked ") + theme.fg("accent", args.to) + roomText;
			content += context.expanded ? theme.fg("muted", ": ") + theme.fg("dim", args.message) : theme.fg("muted", "…");
			t.setText(content);
			return t;
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("muted", "✓"), 0, 0);
		},
		async execute(_toolCallId, params) {
			if (!agentName) throw new Error("Pi2Pi: --agent-name flag is required");
			const connection = resolveRoom(params.room);
			if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) {
				throw new Error(`Pi2Pi: not connected to broker for ${roomLabel(connection)}`);
			}

			const targets = params.to === "everyone"
				? connection.onlineAgents.filter(name => name !== agentName)
				: [resolveTargetName(connection, params.to)];
			if (targets.length === 0) throw new Error(`Pi2Pi: no other agents are connected in ${roomLabel(connection)}`);

			const DELIVERY_TIMEOUT_MS = 2000;
			const sent: { target: string; msgId: string }[] = [];
			const deliveryPromises: Promise<void>[] = [];

			for (const target of targets) {
				const msgId = randomUUID();
				sent.push({ target, msgId });
				pendingOutgoing.set(msgId, { to: target, message: params.message, sentAt: new Date(), roomAlias: connection.alias });
				addToHistory(msgId, target, params.message, connection.alias);
				connection.ws.send(JSON.stringify({ type: "message", id: msgId, to: target, content: params.message }));
				deliveryPromises.push(new Promise<void>((resolve, reject) => {
					pendingDelivery.set(msgId, { resolve, reject });
					setTimeout(() => {
						if (pendingDelivery.has(msgId)) {
							pendingDelivery.delete(msgId);
							resolve();
						}
					}, DELIVERY_TIMEOUT_MS);
				}));
			}
			refreshStatus();

			const results = await Promise.allSettled(deliveryPromises);
			const failures = results
				.map((result, index) => result.status === "rejected" ? `${sent[index].target}: ${result.reason}` : null)
				.filter(Boolean) as string[];
			if (failures.length > 0) throw new Error(failures.join("; "));

			const targetList = sent.map(({ target, msgId }) => `${target} [id: ${msgId}]`).join(", ");
			return { content: [{ type: "text", text: `Message sent to ${targetList} in ${roomLabel(connection)}.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "replies",
		label: "Replies",
		description: "Show all messages you have sent, with their status and room.",
		promptSnippet: "Show all sent messages and whether replies have been received",
		parameters: Type.Object({}),
		async execute() {
			if (!agentName) throw new Error("Pi2Pi: not connected");
			if (sentHistory.size === 0) {
				return { content: [{ type: "text", text: "No messages sent yet." }], details: undefined };
			}
			const lines = [...sentHistory.values()].reverse().map(p => {
				const status = p.repliedAt ? "✓" : "⏳";
				const time = p.repliedAt ? `replied ${p.repliedAt.toLocaleTimeString()}` : `sent ${p.sentAt.toLocaleTimeString()}`;
				return `${status} ${p.to} [${p.roomAlias}, id: ${p.id}] — \"${p.message}\" (${time})`;
			});
			return { content: [{ type: "text", text: `Sent messages (${sentHistory.size}):\n${lines.join("\n")}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description: "Wait for replies to arrive for one or more sent messages.",
		promptSnippet: "Wait for replies to specific sent messages before proceeding",
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { description: "Message ids to wait for" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
		}),
		async execute(_toolCallId, params) {
			const timeout = params.timeout ?? 30000;
			const promises = params.ids.map(id => {
				if (replyBuffer.has(id)) return Promise.resolve();
				return new Promise<void>((resolve, reject) => {
					replyWaiters.set(id, resolve);
					setTimeout(() => {
						if (replyWaiters.has(id)) {
							replyWaiters.delete(id);
							reject(new Error(`Timeout waiting for reply to ${id}`));
						}
					}, timeout);
				});
			});
			const results = await Promise.allSettled(promises);
			const timedOut = results.map((result, index) => result.status === "rejected" ? params.ids[index] : null).filter(Boolean) as string[];
			if (timedOut.length > 0) throw new Error(`Timed out waiting for replies to: ${timedOut.join(", ")}`);
			return { content: [{ type: "text", text: `All ${params.ids.length} ${params.ids.length === 1 ? "reply" : "replies"} received. Use the read tool to retrieve ${params.ids.length === 1 ? "it" : "them"}.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "read_reply",
		label: "Read Reply",
		description: "Read the reply for a specific sent message and remove it from the queue.",
		promptSnippet: "Read the reply for a specific sent message",
		parameters: Type.Object({
			id: Type.String({ description: "The message id to read the reply for" }),
		}),
		renderResult(result, { expanded }, theme, context) {
			const meta = readReplyMeta.get(context.toolCallId);
			const from = meta?.from ?? "?";
			const roomText = meta?.roomAlias ? theme.fg("muted", ` ${meta.roomAlias}`) : "";
			if (!expanded) {
				return new Text(theme.fg("muted", "Reply received from ") + theme.fg("accent", from) + roomText, 0, 0);
			}
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params) {
			const entry = replyBuffer.get(params.id);
			if (!entry) throw new Error(`No reply available for id ${params.id} — has it arrived yet? Use the wait tool first.`);
			entry.claimed = true;
			const connection = roomConnections.get(entry.roomAlias);
			const fromDisplay = connection ? friendlyName(connection, entry.from) : entry.from;
			if (toolCallId) readReplyMeta.set(toolCallId, { from: fromDisplay, roomAlias: entry.roomAlias });
			return {
				content: [{ type: "text", text: `[Incoming message received from ${fromDisplay} in ${connection ? roomLabel(connection) : entry.roomAlias}, id: ${entry.id}]\n${fromDisplay}: ${entry.content}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "reply",
		label: "Reply",
		description: "Send a reply to a specific agent who sent you an incoming message.",
		promptSnippet: "Reply to an incoming message from another agent",
		parameters: Type.Object({
			id: Type.String({ description: "The id of the incoming message to reply to" }),
			content: Type.String({ description: "The reply to send back" }),
		}),
		renderCall(args, theme, context) {
			const t = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const incoming = incomingQueue.get(args.id);
			const from = incoming?.from ?? args.id;
			const roomText = incoming?.roomAlias ? theme.fg("muted", ` ${incoming.roomAlias}`) : "";
			let content = theme.fg("muted", "Replied to ") + theme.fg("accent", from) + roomText;
			content += context.expanded ? theme.fg("muted", ": ") + theme.fg("dim", args.content) : theme.fg("muted", "…");
			t.setText(content);
			return t;
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("muted", "✓"), 0, 0);
		},
		async execute(_toolCallId, params) {
			if (!agentName) throw new Error("Pi2Pi: not connected");
			const incoming = incomingQueue.get(params.id);
			if (!incoming) throw new Error(`Pi2Pi: no pending message with id ${params.id}`);
			const connection = resolveRoom(incoming.roomAlias);
			if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) throw new Error(`Pi2Pi: not connected to broker for ${roomLabel(connection)}`);
			incomingQueue.delete(params.id);
			connection.ws.send(JSON.stringify({ type: "reply", id: incoming.id, content: params.content }));
			pi.events.emit("telemetry:annotate", { pi2pi_message_id: incoming.id, reply_sent_at: new Date().toISOString() });
			return { content: [{ type: "text", text: `Reply sent to ${incoming.from} in ${roomLabel(connection)}.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "who",
		label: "Who",
		description: "List the agents currently connected to a room.",
		promptSnippet: "List pi agents currently connected to a room",
		parameters: Type.Object({
			room: Type.Optional(Type.String({ description: "Optional room alias or room name" })),
		}),
		async execute(_toolCallId, params) {
			if (!agentName) throw new Error("Pi2Pi: not connected");
			const connection = resolveRoom(params.room);
			const members = connection.roster.length > 0
				? connection.roster.map(member => `${member.displayName}${member.role ? ` (${member.role})` : ""}`)
				: connection.onlineAgents;
			const text = members.length ? `Agents in ${roomLabel(connection)}: ${members.join(", ")}` : `No agents connected in ${roomLabel(connection)}`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "activity",
		label: "Activity",
		description: "Check whether a specific agent is actively working on a task. Returns state, timestamps, and tool-call count since last message received.",
		promptSnippet: "Check if an agent is still actively working (state, last tool call, tool-call count since last message)",
		parameters: Type.Object({
			agent: Type.String({ description: 'The name of the agent to query (e.g. "Bob")' }),
			room: Type.Optional(Type.String({ description: "Room alias to look in (defaults to default room)" })),
		}),
		async execute(_toolCallId, params) {
			if (!agentName) throw new Error("Pi2Pi: not connected");
			const connection = resolveRoom(params.room);
			const member = connection.roster.find(m => m.name === params.agent);
			if (!member) {
				return { content: [{ type: "text", text: JSON.stringify({
					agent: params.agent, state: "idle",
					lastMessageReceivedAt: null, lastMessageSentAt: null,
					lastToolCallAt: null, lastToolCallName: null,
					toolCallsSinceLastMessage: 0,
					warning: "Agent not connected or not in roster",
				}, null, 2) }], details: undefined };
			}
			const report = {
				agent: member.name,
				state: member.state === "active" ? "busy" : "idle",
				lastMessageReceivedAt: member.lastMessageReceivedAt,
				lastMessageSentAt: member.lastMessageSentAt,
				lastToolCallAt: member.lastToolCallAt,
				lastToolCallName: member.lastToolCallName,
				toolCallsSinceLastMessage: member.toolCallsSinceLastMessage,
			};
			return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: undefined };
		},
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	function parseTellCommandArgs(input: string): { connection: RoomConnection; targetName: string; content: string } | null {
		const parts = input.trim().split(/\s+/).filter(Boolean);
		if (parts.length < 2) return null;
		if (roomConnections.size > 1 && parts.length >= 3) {
			const maybeRoom = tryResolveRoom(parts[0]);
			if (maybeRoom) {
				return { connection: maybeRoom, targetName: parts[1], content: parts.slice(2).join(" ") };
			}
		}
		return { connection: resolveRoom(), targetName: parts[0], content: parts.slice(1).join(" ") };
	}

	pi.registerCommand("tell", {
		description: "Send a message. Usage: /tell <name|everyone> <message> or /tell <room> <name|everyone> <message>",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trim();
			if (!trimmed) {
				if (roomConnections.size > 1) {
					return orderedConnections().map(connection => ({ value: `${connection.alias} `, label: connection.alias, description: `room ${connection.room}` }));
				}
				const connection = defaultRoomAlias ? roomConnections.get(defaultRoomAlias) : null;
				if (!connection) return null;
				const candidates = [
					{ value: "everyone", label: "everyone", description: "all connected agents" },
					...connection.roster
						.filter(member => member.name !== agentName)
						.map(member => ({ value: member.displayName, label: member.displayName, description: member.role ?? "agent" })),
				];
				return candidates.map(candidate => ({ value: `${candidate.value} `, label: candidate.label, description: candidate.description }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			if (!agentName) {
				ctx.ui.notify("Pi2Pi: --agent-name flag is required", "error");
				return;
			}
			let parsed: { connection: RoomConnection; targetName: string; content: string } | null;
			try {
				parsed = parseTellCommandArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!parsed || !parsed.content) {
				ctx.ui.notify("Usage: /tell <name|everyone> <message> or /tell <room> <name|everyone> <message>", "warning");
				return;
			}
			const { connection, targetName, content } = parsed;
			if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) {
				ctx.ui.notify(`Pi2Pi: not connected to broker for ${roomLabel(connection)}`, "error");
				return;
			}

			if (targetName === "everyone") {
				const targets = connection.onlineAgents.filter(name => name !== agentName);
				if (targets.length === 0) {
					ctx.ui.notify(`Pi2Pi: no other agents are connected in ${roomLabel(connection)}`, "warning");
					return;
				}
				pi.sendMessage({
					customType: "pi2pi-sent",
					content,
					display: true,
					details: { to: "everyone", broadcast: true, roomLabel: roomLabel(connection) },
				});
				for (const target of targets) {
					const msgId = randomUUID();
					pendingOutgoing.set(msgId, { to: target, message: content, sentAt: new Date(), roomAlias: connection.alias });
					addToHistory(msgId, target, content, connection.alias);
					connection.ws.send(JSON.stringify({ type: "message", id: msgId, to: target, content }));
				}
			} else {
				let resolvedTarget: string;
				try {
					resolvedTarget = resolveTargetName(connection, targetName);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				if (resolvedTarget === agentName) {
					ctx.ui.notify("Pi2Pi: you can't message yourself", "warning");
					return;
				}
				const msgId = randomUUID();
				pendingOutgoing.set(msgId, { to: resolvedTarget, message: content, sentAt: new Date(), roomAlias: connection.alias });
				addToHistory(msgId, resolvedTarget, content, connection.alias);
				pi.sendMessage({
					customType: "pi2pi-sent",
					content,
					display: true,
					details: { to: targetName, roomLabel: roomLabel(connection) },
				});
				connection.ws.send(JSON.stringify({ type: "message", id: msgId, to: resolvedTarget, content }));
			}
			refreshStatus();
		},
	});

	pi.registerCommand("reply", {
		description: "Send a reply to a pending incoming message. Usage: /reply <id> <content>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIdx = trimmed.search(/\s+/);
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /reply <id> <content>", "warning");
				return;
			}
			const id = trimmed.slice(0, spaceIdx);
			const content = trimmed.slice(spaceIdx).trim();
			if (!content) {
				ctx.ui.notify("Usage: /reply <id> <content>", "warning");
				return;
			}
			const incoming = incomingQueue.get(id);
			if (!incoming) {
				ctx.ui.notify(`Pi2Pi: no pending message with id ${id}`, "warning");
				return;
			}
			let connection: RoomConnection;
			try {
				connection = resolveRoom(incoming.roomAlias);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) {
				ctx.ui.notify(`Pi2Pi: not connected to broker for ${roomLabel(connection)}`, "error");
				return;
			}
			incomingQueue.delete(id);
			connection.ws.send(JSON.stringify({ type: "reply", id: incoming.id, content }));
			pi.events.emit("telemetry:annotate", { pi2pi_message_id: incoming.id, reply_sent_at: new Date().toISOString() });
			ctx.ui.notify(`Reply sent to ${incoming.from} in ${roomLabel(connection)}.`);
		},
	});

	pi.registerCommand("replies", {
		description: "Show all sent messages with their status",
		handler: async () => {
			const messages = [...sentHistory.values()].reverse().map(p => ({
				id: p.id,
				to: p.to,
				message: p.message,
				roomAlias: p.roomAlias,
				sentAt: p.sentAt.toISOString(),
				repliedAt: p.repliedAt?.toISOString(),
			}));
			pi.sendMessage({
				customType: "pi2pi-pending",
				content: messages.length ? messages.map(p => `${p.repliedAt ? "✓" : "⏳"} ${p.to} [${p.roomAlias}, id: ${p.id}] — \"${p.message}\"`).join("\n") : "No messages sent yet.",
				display: true,
				details: { messages },
			});
		},
	});

	pi.registerCommand("status", {
		description: "Show the current status of all agents in a room. Usage: /status [room]",
		handler: async (args, ctx) => {
			if (!agentName) {
				ctx.ui.notify("Pi2Pi: --agent-name is required", "error");
				return;
			}
			let connection: RoomConnection;
			try {
				connection = resolveRoom(args.trim() || undefined);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const now = new Date();
			const members = connection.roster.length > 0
				? [...connection.roster].sort((a, b) => {
					if (a.state === b.state) return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
					if (a.state === "active") return -1;
					if (b.state === "active") return 1;
					return 0;
				})
				: [];
			const lines = members.length > 0
				? members.map(m => formatStatusLine(m, now))
				: ["  no agents connected"];
			const header = `── ${roomLabel(connection)} ── ${members.length} agent${members.length !== 1 ? "s" : ""} `;
			pi.sendMessage({
				customType: "pi2pi-status",
				content: [header, ...lines].join("\n"),
				display: true,
				details: { roomLabel: roomLabel(connection), members },
			});
		},
	});

	pi.registerCommand("who", {
		description: "Show which agents are currently connected. Usage: /who [room]",
		handler: async (args, ctx) => {
			if (!agentName) {
				ctx.ui.notify("Pi2Pi: --agent-name is required", "error");
				return;
			}
			let connection: RoomConnection;
			try {
				connection = resolveRoom(args.trim() || undefined);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const members = connection.roster.length > 0
				? connection.roster.map(member => ({
					displayName: member.displayName,
					role: member.role,
					self: member.name === agentName,
				}))
				: [{ displayName: displayName ?? agentName, role: agentRole, self: true }];
			pi.sendMessage({
				customType: "pi2pi-who",
				content: members.map(member => `${member.displayName}${member.role ? ` (${member.role})` : ""}${member.self ? " (you)" : ""}`).join(", "),
				display: true,
				details: { self: displayName ?? agentName, roomLabel: roomLabel(connection), members },
			});
		},
	});
}

function extractLastAssistantText(messages: unknown): string | null {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; content?: unknown };
		if (msg?.role !== "assistant") continue;
		const content = msg.content;
		if (!content) continue;
		if (typeof content === "string") return content.trim() || null;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const block of content) {
				const b = block as { type?: string; text?: string };
				if (b?.type === "text" && b.text?.trim()) parts.push(b.text.trim());
			}
			return parts.join("\n\n").trim() || null;
		}
	}
	return null;
}

void extractLastAssistantText;
