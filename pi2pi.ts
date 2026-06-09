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

type RoomConnection = {
	alias: string;
	room: string;
	ws: WebSocket | null;
	onlineAgents: string[];
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
	let shutdownRequested = false;

	const roomConnections = new Map<string, RoomConnection>();

	let uiNotify: ((msg: string, level: "info" | "warning" | "error" | "success") => void) | null = null;
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
		uiNotify?.(msg, level);
	}

	function setStatus(text: string | undefined) {
		uiSetStatus?.("pi2pi", text);
	}

	function tryResolveRoom(input: string): RoomConnection | null {
		const byAlias = roomConnections.get(input);
		if (byAlias) return byAlias;
		return orderedConnections().find(connection => connection.room === input) ?? null;
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
				reconnectAttempts: 0,
			});
		}
		defaultRoomAlias = defaultAlias;
	}

	function refreshStatus() {
		if (!agentName) return;
		const roomSummary = orderedConnections().map(connection => {
			const others = connection.onlineAgents.filter(name => name !== agentName);
			const peers = others.length ? `[${others.join(", ")}]` : "";
			return roomConnections.size === 1
				? `#${connection.room}${peers}`
				: `${connection.alias}${peers}`;
		}).join(" ");
		const waiting = pendingOutgoing.size ? ` ⏳×${pendingOutgoing.size}` : "";
		setStatus(`● ${agentName}${roomSummary ? ` ${roomSummary}` : ""}${waiting}`);
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

		const { type, id, name, from, content, agents, reason } = msg as {
			type?: string;
			id?: string;
			name?: string;
			from?: string;
			content?: string;
			agents?: string[];
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
				refreshStatus();
				break;
			}

			case "incoming": {
				if (!id || !from || content === undefined) return;
				incomingQueue.set(id, { id, from, roomAlias });
				pi.sendMessage({
					customType: "pi2pi-incoming",
					content: `Message from ${from} in ${roomLabel(connection)} [id: ${id}]: ${content}\n\nUse the reply tool with id=\"${id}\" to send your response.`,
					display: true,
					details: { from, message: content, roomLabel: roomLabel(connection) },
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
					pi.sendMessage({
						customType: "pi2pi-reply",
						content: `[Incoming message received from ${from} in ${roomLabel(connection)}, id: ${id}]\n${from}: ${content}`,
						display: true,
						details: { from, full: content, roomLabel: roomLabel(connection) },
					}, { triggerTurn: true, deliverAs: "followUp" });
				} else {
					replyBuffer.set(id, entry);
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
			ws.send(JSON.stringify({ type: "register", name: agentName, room: connection.room }));
		});
		ws.addEventListener("message", event => {
			handleBrokerMessage(connection.alias, String((event as { data?: unknown }).data));
		});
		ws.addEventListener("close", () => {
			connection.ws = null;
			connection.onlineAgents = [];
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
		box.addChild(new Text(label + theme.fg("dim", message.content), 0, 0));
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

	pi.registerMessageRenderer("pi2pi-who", (message, _options, theme) => {
		const details = message.details as { self: string; roomLabel: string; others: string[] } | undefined;
		const self = details?.self ?? "?";
		const roomLabelText = details?.roomLabel ?? "?";
		const others = details?.others ?? [];
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		let text = theme.fg("accent", `👥 Room: ${roomLabelText}`) + theme.fg("muted", "\n");
		text += theme.fg("success", "  ● ") + theme.fg("accent", self) + theme.fg("dim", " (you)\n");
		if (others.length === 0) {
			text += theme.fg("muted", "  (no other agents online)");
		} else {
			text += others.map(n => theme.fg("success", "  ● ") + n).join("\n");
		}
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// ── Lifecycle events ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		shutdownRequested = false;
		uiNotify = ctx.ui.notify.bind(ctx.ui);
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

		try {
			const parsed = parseRoomBindings();
			configureRooms(parsed.bindings, parsed.defaultAlias);
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
			pi.sendMessage({
				customType: "pi2pi-reply",
				content: `[Incoming message received from ${entry.from} in ${connection ? roomLabel(connection) : entry.roomAlias}, id: ${entry.id}]\n${entry.from}: ${entry.content}`,
				display: true,
				details: { from: entry.from, full: entry.content, roomLabel: connection ? roomLabel(connection) : entry.roomAlias },
			}, { triggerTurn: true, deliverAs: "followUp" });
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
				: [params.to];
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
			return { content: [{ type: "text", text: `Message sent to ${targetList} in ${roomLabel(connection)}.` }] };
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
				return { content: [{ type: "text", text: "No messages sent yet." }] };
			}
			const lines = [...sentHistory.values()].reverse().map(p => {
				const status = p.repliedAt ? "✓" : "⏳";
				const time = p.repliedAt ? `replied ${p.repliedAt.toLocaleTimeString()}` : `sent ${p.sentAt.toLocaleTimeString()}`;
				return `${status} ${p.to} [${p.roomAlias}, id: ${p.id}] — \"${p.message}\" (${time})`;
			});
			return { content: [{ type: "text", text: `Sent messages (${sentHistory.size}):\n${lines.join("\n")}` }] };
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
			return { content: [{ type: "text", text: `All ${params.ids.length} ${params.ids.length === 1 ? "reply" : "replies"} received. Use the read tool to retrieve ${params.ids.length === 1 ? "it" : "them"}.` }] };
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
			if (toolCallId) readReplyMeta.set(toolCallId, { from: entry.from, roomAlias: entry.roomAlias });
			const connection = roomConnections.get(entry.roomAlias);
			return {
				content: [{ type: "text", text: `[Incoming message received from ${entry.from} in ${connection ? roomLabel(connection) : entry.roomAlias}, id: ${entry.id}]\n${entry.from}: ${entry.content}` }],
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
			return { content: [{ type: "text", text: `Reply sent to ${incoming.from} in ${roomLabel(connection)}.` }] };
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
			const others = connection.onlineAgents.filter(name => name !== agentName);
			const text = others.length ? `Agents in ${roomLabel(connection)}: ${others.join(", ")}` : `No other agents connected in ${roomLabel(connection)}`;
			return { content: [{ type: "text", text }] };
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
				return ["everyone", ...connection.onlineAgents.filter(name => name !== agentName)].map(value => ({ value: `${value} `, label: value, description: value === "everyone" ? "all connected agents" : "agent" }));
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
				if (targetName === agentName) {
					ctx.ui.notify("Pi2Pi: you can't message yourself", "warning");
					return;
				}
				const msgId = randomUUID();
				pendingOutgoing.set(msgId, { to: targetName, message: content, sentAt: new Date(), roomAlias: connection.alias });
				addToHistory(msgId, targetName, content, connection.alias);
				pi.sendMessage({
					customType: "pi2pi-sent",
					content,
					display: true,
					details: { to: targetName, roomLabel: roomLabel(connection) },
				});
				connection.ws.send(JSON.stringify({ type: "message", id: msgId, to: targetName, content }));
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
			ctx.ui.notify(`Reply sent to ${incoming.from} in ${roomLabel(connection)}.`, "success");
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
			const others = connection.onlineAgents.filter(name => name !== agentName);
			pi.sendMessage({
				customType: "pi2pi-who",
				content: others.length ? `${roomLabel(connection)}: you (${agentName}) + ${others.join(", ")}` : `${roomLabel(connection)}: you (${agentName}), no others connected`,
				display: true,
				details: { self: agentName, roomLabel: roomLabel(connection), others },
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
