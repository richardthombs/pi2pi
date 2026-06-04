/**
 * Pi2Pi Extension
 *
 * Enables peer-to-peer messaging between pi instances via a shared broker.
 *
 * Usage:
 *   pi -e ./pi2pi.ts --agent-name Alice --room engineering
 *   pi -e ./pi2pi.ts --agent-name Bob   --room engineering
 *   pi -e ./pi2pi.ts --agent-name Alice --room engineering --broker ws://localhost:7331
 *
 * Commands:
 *   /tell <name> <message>      — send a message to a specific agent
 *   /tell everyone <message>    — broadcast to all connected agents
 *   /who                        — show who is currently connected
 *
 * The message is routed to the named agent, processed by that agent's LLM,
 * and the reply is delivered back and displayed in your conversation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

const BROKER_DEFAULT = "ws://localhost:7331";
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 20;

export default function (pi: ExtensionAPI) {
	// ── Flags ────────────────────────────────────────────────────────────────
	pi.registerFlag("agent-name", {
		description: "Name for this pi instance (used by other agents to address you)",
		type: "string",
	});
	pi.registerFlag("room", {
		description: "Room to join — only agents in the same room can see and message each other",
		type: "string",
	});
	pi.registerFlag("broker", {
		description: `Broker WebSocket URL (default: ${BROKER_DEFAULT})`,
		type: "string",
	});

	// ── State ────────────────────────────────────────────────────────────────
	let ws: WebSocket | null = null;
	let agentName: string | null = null;
	let agentRoom: string | null = null;
	let brokerUrl: string = BROKER_DEFAULT;
	let reconnectAttempts = 0;
	let shutdownRequested = false;

	// ui helpers captured from the most recent ctx
	let uiNotify: ((msg: string, level: "info" | "warning" | "error" | "success") => void) | null = null;
	let uiSetStatus: ((id: string, text: string | undefined) => void) | null = null;

	// Queue of incoming inter-agent messages waiting for a reply turn.
	// Pushed when the broker delivers "incoming", shifted in agent_end after each reply turn.
	const incomingQueue: Array<{ id: string; from: string }> = [];

	// Outgoing messages we are waiting for a reply to: id → { to }
	const pendingOutgoing = new Map<string, { to: string }>();

	// Resolvers for tool-initiated messages: id → { resolve, reject }
	// When a reply arrives for one of these, the tell tool's promise resolves.
	const pendingToolReplies = new Map<string, { resolve: (content: string) => void; reject: (err: Error) => void }>();

	// Latest online agent list from the broker
	let onlineAgents: string[] = [];

	// ── Custom message renderers ─────────────────────────────────────────────

	// "📤 Sent to @Bob: ..." — shown in the sender's conversation
	pi.registerMessageRenderer("pi2pi-sent", (message, _options, theme) => {
		const details = message.details as { to: string; broadcast?: boolean } | undefined;
		const to = details?.to ?? "?";
		const isBroadcast = details?.broadcast ?? false;
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		const toLabel = isBroadcast ? theme.fg("warning", "everyone") : theme.fg("accent", to);
		const label = theme.fg("muted", "Asked ") + toLabel + theme.fg("muted", ": ");
		box.addChild(new Text(label + theme.fg("dim", message.content), 0, 0));
		return box;
	});

	// "💬 @Bob: ..." — the reply received from a remote agent
	pi.registerMessageRenderer("pi2pi-reply", (message, { expanded }, theme) => {
		const details = message.details as { from: string; full: string } | undefined;
		const from = details?.from ?? "?";
		const full = details?.full ?? message.content;
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		const label = theme.fg("accent", `${from}`) + theme.fg("muted", " replied: ");
		const preview = full.length > 300 && !expanded ? full.slice(0, 300) + "…" : full;
		box.addChild(new Text(label + preview, 0, 0));
		return box;
	});

	// "📨 @Alice: ..." — an incoming request from another agent, shown in the recipient's session
	pi.registerMessageRenderer("pi2pi-incoming", (message, { expanded }, theme) => {
		const details = message.details as { from: string; message: string } | undefined;
		const from = details?.from ?? "?";
		const full = details?.message ?? message.content;
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		const label = theme.fg("accent", `${from}`) + theme.fg("muted", ": ");
		const preview = full.length > 300 && !expanded ? full.slice(0, 300) + "…" : full;
		box.addChild(new Text(label + preview, 0, 0));
		return box;
	});

	// "/who" roster display
	pi.registerMessageRenderer("pi2pi-who", (message, _options, theme) => {
		const details = message.details as { self: string; room: string; others: string[] } | undefined;
		const self = details?.self ?? "?";
		const room = details?.room ?? "?";
		const others = details?.others ?? [];
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		let text = theme.fg("accent", `👥 Room: #${room}`) + theme.fg("muted", "\n");
		text += theme.fg("success", "  ● ") + theme.fg("accent", self) + theme.fg("dim", " (you)\n");
		if (others.length === 0) {
			text += theme.fg("muted", "  (no other agents online)");
		} else {
			text += others.map((n) => theme.fg("success", "  ● ") + n).join("\n");
		}
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// ── Status / notify helpers ───────────────────────────────────────────────

	function notify(msg: string, level: "info" | "warning" | "error" | "success" = "info") {
		uiNotify?.(msg, level);
	}

	function setStatus(text: string | undefined) {
		uiSetStatus?.("pi2pi", text);
	}

	function refreshStatus() {
		if (!agentName || !agentRoom) return;
		const others = onlineAgents.filter((n) => n !== agentName);
		const peers = others.length ? ` [${others.join(", ")}]` : "";
		const waiting = pendingOutgoing.size ? ` ⏳×${pendingOutgoing.size}` : "";
		setStatus(`● ${agentName} #${agentRoom}${peers}${waiting}`);
	}

	// ── WebSocket / broker ────────────────────────────────────────────────────

	function connectToBroker() {
		if (shutdownRequested || !agentName) return;

		try {
			ws = new WebSocket(brokerUrl);
		} catch {
			scheduleReconnect();
			return;
		}

		ws.addEventListener("open", () => {
			reconnectAttempts = 0;
			ws!.send(JSON.stringify({ type: "register", name: agentName, room: agentRoom }));
		});

		ws.addEventListener("message", (event) => {
			handleBrokerMessage(String(event.data));
		});

		ws.addEventListener("close", () => {
			ws = null;
			if (!shutdownRequested) {
				setStatus(`⚠ ${agentName} — disconnected`);
				scheduleReconnect();
			}
		});
	}

	function scheduleReconnect() {
		if (shutdownRequested) return;
		reconnectAttempts++;
		if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
			setStatus(`✖ ${agentName} — broker unreachable`);
			return;
		}
		const delay = Math.min(RECONNECT_DELAY_MS * reconnectAttempts, 30_000);
		setTimeout(() => {
			if (!shutdownRequested) connectToBroker();
		}, delay);
	}

	function handleBrokerMessage(rawData: string) {
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
			// ── Broker acknowledged our registration ─────────────────────────
			case "registered": {
				notify(`Registered as "${name}" in room "${agentRoom}" on ${brokerUrl}`, "success");
				refreshStatus();
				break;
			}

			// ── Updated roster of connected agents ───────────────────────────
			case "agent_list": {
				onlineAgents = agents ?? [];
				refreshStatus();
				break;
			}

			// ── Incoming message from another agent ──────────────────────────
			case "incoming": {
				if (!id || !from || !content) return;

				// Enqueue so agent_end can correlate each reply turn with the right message id.
				incomingQueue.push({ id, from });

				// Use sendMessage (not sendUserMessage) so the styled pi2pi-incoming renderer
				// is used. triggerTurn starts an agent turn so the LLM generates a reply.
				// deliverAs followUp ensures messages are processed in arrival order.
				pi.sendMessage({
					customType: "pi2pi-incoming",
					content: `Message from ${from}: ${content}`,
					display: true,
					details: { from, message: content },
				}, { triggerTurn: true, deliverAs: "followUp" });
				break;
			}

			// ── Reply came back for one of our outgoing messages ─────────────
			case "reply_result": {
				if (!id || !from || !content) return;
				pendingOutgoing.delete(id);
				refreshStatus();

				// If a tool is waiting for this reply, resolve its promise.
				// The reply becomes the tool result — no separate styled message needed.
				const toolReply = pendingToolReplies.get(id);
				if (toolReply) {
					pendingToolReplies.delete(id);
					toolReply.resolve(content);
					break;
				}

				// Command-initiated reply: show styled message and trigger a turn.
				pi.sendMessage({
					customType: "pi2pi-reply",
					content: `Reply from ${from}: ${content}`,
					display: true,
					details: { from, full: content },
				}, { triggerTurn: true, deliverAs: "followUp" });
				break;
			}

			// ── Error from broker ────────────────────────────────────────────
			case "error": {
				const forId = id ? ` (id ${id})` : "";
				notify(`Broker error${forId}: ${reason ?? "unknown"}`, "error");

				if (id) {
					pendingOutgoing.delete(id);
					refreshStatus();
					const toolReply = pendingToolReplies.get(id);
					if (toolReply) {
						pendingToolReplies.delete(id);
						toolReply.reject(new Error(reason ?? "Unknown broker error"));
					}
				}
				break;
			}
		}
	}

	// ── Lifecycle events ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		shutdownRequested = false;
		reconnectAttempts = 0;
		uiNotify = ctx.ui.notify.bind(ctx.ui);
		uiSetStatus = ctx.ui.setStatus.bind(ctx.ui);

		brokerUrl = ((pi.getFlag("broker") as string | undefined) ?? BROKER_DEFAULT).trim();

		// Use --agent-name flag if supplied, otherwise show a persistent error and disable
		const flagName = (pi.getFlag("agent-name") as string | undefined)?.trim();
		if (!flagName) {
			ctx.ui.setStatus("pi2pi", "✖ pi2pi — restart with --agent-name <name>");
			return;
		}
		agentName = flagName;

		const flagRoom = (pi.getFlag("room") as string | undefined)?.trim();
		if (!flagRoom) {
			ctx.ui.setStatus("pi2pi", "✖ pi2pi — restart with --room <room>");
			return;
		}
		agentRoom = flagRoom;

		ctx.ui.setStatus("pi2pi", `○ ${agentName} #${agentRoom} — connecting…`);
		connectToBroker();
	});

	pi.on("session_shutdown", async () => {
		shutdownRequested = true;
		uiNotify = null;
		uiSetStatus = null;
		agentName = null;
		agentRoom = null;
		incomingQueue.length = 0;
		pendingOutgoing.clear();
		for (const { reject } of pendingToolReplies.values()) {
			reject(new Error("Session shut down"));
		}
		pendingToolReplies.clear();
		onlineAgents = [];
		if (ws) {
			try {
				ws.close();
			} catch {}
			ws = null;
		}
	});

	pi.on("agent_end", async (event) => {
		// If this turn was a response to an incoming inter-agent message, send the reply
		const incoming = incomingQueue.shift();
		if (!incoming) return;

		const { id, from } = incoming;

		if (!ws || ws.readyState !== WebSocket.OPEN) {
			notify("Pi2Pi: lost broker connection while preparing reply", "warning");
			return;
		}

		const replyText = extractLastAssistantText(event.messages);
		ws.send(
			JSON.stringify({
				type: "reply",
				id,
				content: replyText ?? "(no response)",
			}),
		);
	});

	// ── Tools (callable by the LLM) ───────────────────────────────────────────

	pi.registerTool({
		name: "tell",
		label: "Tell",
		description: "Send a message to another agent in the same room and return their reply. Use who first if you are unsure who is available.",
		promptSnippet: "Send a message to another pi agent and get their reply",
		parameters: Type.Object({
			to: Type.String({ description: 'Agent name to message, or "everyone" to broadcast to all connected agents' }),
			message: Type.String({ description: "Message to send" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			if (!agentName) throw new Error("Pi2Pi: --agent-name flag is required");
			if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Pi2Pi: not connected to broker");

			const targets = params.to === "everyone"
				? onlineAgents.filter((n) => n !== agentName)
				: [params.to];

			if (targets.length === 0) throw new Error("Pi2Pi: no other agents are connected");

			onUpdate?.({ content: [{ type: "text", text: `Waiting for ${targets.length === 1 ? targets[0] : "all agents"} to reply…` }] });

			const replies = await Promise.allSettled(
				targets.map((target) =>
					new Promise<{ target: string; reply: string }>((resolve, reject) => {
						const msgId = randomUUID();
						pendingOutgoing.set(msgId, { to: target });
						pendingToolReplies.set(msgId, {
							resolve: (content) => resolve({ target, reply: content }),
							reject,
						});
						signal?.addEventListener("abort", () => {
							pendingOutgoing.delete(msgId);
							pendingToolReplies.delete(msgId);
							reject(new Error("Cancelled"));
						});
						ws!.send(JSON.stringify({ type: "message", id: msgId, to: target, content: params.message }));
						refreshStatus();
					})
				)
			);

			const lines: string[] = [];
			for (const result of replies) {
				if (result.status === "fulfilled") {
					lines.push(`${result.value.target}: ${result.value.reply}`);
				} else {
					lines.push(`${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
				}
			}

			return { content: [{ type: "text", text: lines.join("\n\n") }] };
		},
	});

	pi.registerTool({
		name: "who",
		label: "Who",
		description: "List the agents currently connected to this room.",
		promptSnippet: "List pi agents currently connected to this room",
		parameters: Type.Object({}),
		async execute() {
			if (!agentName || !agentRoom) throw new Error("Pi2Pi: not connected");
			const others = onlineAgents.filter((n) => n !== agentName);
			const text = others.length
				? `Agents in #${agentRoom}: ${others.join(", ")}`
				: `No other agents connected in #${agentRoom}`;
			return { content: [{ type: "text", text }] };
		},
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("tell", {
		description: "Send a message to another agent. Usage: /tell <name|everyone> <message>",

		// Autocomplete: first word = agent name or 'everyone'
		getArgumentCompletions(prefix: string) {
			const parts = prefix.split(/\s+/);
			// Only complete the first word (the target name)
			if (parts.length > 1) return null;
			const stem = parts[0] ?? "";
			const candidates = ["everyone", ...onlineAgents.filter((n) => n !== agentName)];
			const matches = candidates
				.filter((c) => c.toLowerCase().startsWith(stem.toLowerCase()))
				.map((c) => ({ value: c + " ", label: c, description: c === "everyone" ? "all connected agents" : "agent" }));
			return matches.length ? matches : null;
		},

		handler: async (args, ctx) => {
			if (!agentName) {
				ctx.ui.notify("Pi2Pi: --name flag is required", "error");
				return;
			}
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				ctx.ui.notify("Pi2Pi: not connected to broker — is it running?", "error");
				return;
			}

			const trimmed = args.trim();
			const spaceIdx = trimmed.search(/\s+/);
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /tell <name|everyone> <message>", "warning");
				return;
			}

			const targetName = trimmed.slice(0, spaceIdx);
			const content = trimmed.slice(spaceIdx).trim();

			if (!content) {
				ctx.ui.notify("Usage: /tell <name|everyone> <message>", "warning");
				return;
			}

			if (targetName === "everyone") {
				// Broadcast to all other online agents
				const targets = onlineAgents.filter((n) => n !== agentName);
				if (targets.length === 0) {
					ctx.ui.notify("Pi2Pi: no other agents are connected", "warning");
					return;
				}

				pi.sendMessage({
					customType: "pi2pi-sent",
					content,
					display: true,
					details: { to: "everyone", broadcast: true },
				});

				for (const target of targets) {
					const msgId = randomUUID();
					pendingOutgoing.set(msgId, { to: target });
					ws!.send(JSON.stringify({ type: "message", id: msgId, to: target, content }));
				}
			} else {
				// Point-to-point
				if (targetName === agentName) {
					ctx.ui.notify("Pi2Pi: you can't message yourself", "warning");
					return;
				}

				const msgId = randomUUID();
				pendingOutgoing.set(msgId, { to: targetName });

				pi.sendMessage({
					customType: "pi2pi-sent",
					content,
					display: true,
					details: { to: targetName },
				});

				ws!.send(JSON.stringify({ type: "message", id: msgId, to: targetName, content }));
			}

			refreshStatus();
		},
	});

	pi.registerCommand("who", {
		description: "Show which agents are currently connected to the same room",
		handler: async (_args, ctx) => {
			if (!agentName || !agentRoom) {
				ctx.ui.notify("Pi2Pi: --agent-name and --room flags are required", "error");
				return;
			}
			const others = onlineAgents.filter((n) => n !== agentName);
			pi.sendMessage({
				customType: "pi2pi-who",
				content: others.length
					? `Room #${agentRoom}: you (${agentName}) + ${others.join(", ")}`
					: `Room #${agentRoom}: you (${agentName}), no others connected`,
				display: true,
				details: { self: agentName, room: agentRoom, others },
			});
		},
	});
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Walk the messages array returned by agent_end and extract the plain text
 * from the final assistant message.
 */
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
