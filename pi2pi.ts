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
 *   /tell <name> <message>      — send a message to a specific agent (fire-and-forget)
 *   /tell everyone <message>    — broadcast to all connected agents
 *   /replies                    — show messages still awaiting a reply
 *   /who                        — show who is currently connected
 *
 * Replies arrive automatically as follow-up messages; no polling required.
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

	// Incoming messages awaiting a reply, keyed by message ID.
	const incomingQueue = new Map<string, { id: string; from: string }>();

	function enqueueIncoming(id: string, from: string) {
		incomingQueue.set(id, { id, from });
	}

	function dequeueIncoming(id: string): { id: string; from: string } | undefined {
		const item = incomingQueue.get(id);
		if (item) incomingQueue.delete(id);
		return item;
	}

	// Outgoing messages still awaiting a reply: id → { to, message, sentAt }
	const pendingOutgoing = new Map<string, { to: string; message: string; sentAt: Date }>();

	// Latest online agent list from the broker
	let onlineAgents: string[] = [];

	// ── Custom message renderers ─────────────────────────────────────────────

	// "Asked @Bob: ..." — shown in the sender's conversation
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

	// "@Bob replied: ..." — the reply received from a remote agent
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

	// "@Alice: ..." — an incoming request from another agent, shown in the recipient's session
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

	// "⏳ Pending replies ..." — shown by /replies command
	pi.registerMessageRenderer("pi2pi-pending", (message, _options, theme) => {
		const details = message.details as { pending: Array<{ to: string; message: string; sentAt: string }> } | undefined;
		const pending = details?.pending ?? [];
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		if (pending.length === 0) {
			box.addChild(new Text(theme.fg("muted", "No pending messages — all replies have been received."), 0, 0));
		} else {
			const header = theme.fg("accent", `⏳ Pending replies (${pending.length})`) + "\n";
			const lines = pending.map(
				(p) =>
					theme.fg("accent", p.to) +
					theme.fg("muted", ` — "${p.message}" (sent ${new Date(p.sentAt).toLocaleTimeString()})`),
			);
			box.addChild(new Text(header + lines.join("\n"), 0, 0));
		}
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
				if (!id || !from || content === undefined) return;

				// Enqueue so agent_end can correlate each reply turn with the right message id.
				enqueueIncoming(id, from);

				// Use sendMessage (not sendUserMessage) so the styled pi2pi-incoming renderer
				// is used. triggerTurn starts an agent turn so the LLM generates a reply.
				// deliverAs followUp ensures messages are processed in arrival order.
				pi.sendMessage({
					customType: "pi2pi-incoming",
					content: `Message from ${from} [id: ${id}]: ${content}\n\nUse the reply tool with id="${id}" to send your response.`,
					display: true,
					details: { from, message: content },
				}, { triggerTurn: true, deliverAs: "followUp" });
				break;
			}

			// ── Reply came back for one of our outgoing messages ─────────────
			case "reply_result": {
				if (!id || !from || content === undefined) return;
				pendingOutgoing.delete(id);
				refreshStatus();

				// Inject the reply as a follow-up turn so the LLM sees it automatically,
				// regardless of what else the agent is doing at the time.
				pi.sendMessage({
					customType: "pi2pi-reply",
					content: `[Incoming message received from ${from}]\n${from}: ${content}`,
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
		incomingQueue.clear();
		pendingOutgoing.clear();
		onlineAgents = [];
		if (ws) {
			try {
				ws.close();
			} catch {}
			ws = null;
		}
	});



	// ── Tools (callable by the LLM) ───────────────────────────────────────────

	pi.registerTool({
		name: "tell",
		label: "Tell",
		description:
			"Send a message to another agent and return immediately — do not wait. " +
			"The reply will arrive automatically as a follow-up message when ready. " +
			"Use the replies tool only to check what is still outstanding.",
		promptSnippet: "Send a message to another pi agent (fire-and-forget; reply arrives automatically)",
		parameters: Type.Object({
			to: Type.String({ description: 'Agent name to message, or "everyone" to broadcast to all connected agents' }),
			message: Type.String({ description: "Message to send" }),
		}),
		renderCall(args, theme, context) {
			const t = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("muted", "Asked ") + theme.fg("accent", args.to);
			if (context.expanded) {
				content += theme.fg("muted", ": ") + theme.fg("dim", args.message);
			} else {
				content += theme.fg("muted", "…");
			}
			t.setText(content);
			return t;
		},
		renderResult(_result, _options, theme) {
			// Visually suppress the result — the call row already shows everything.
			// The tool result text is still present in the LLM context unchanged.
			return new Text(theme.fg("muted", "✓"), 0, 0);
		},
		async execute(_toolCallId, params) {
			if (!agentName) throw new Error("Pi2Pi: --agent-name flag is required");
			if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Pi2Pi: not connected to broker");

			const targets = params.to === "everyone"
				? onlineAgents.filter((n) => n !== agentName)
				: [params.to];

			if (targets.length === 0) throw new Error("Pi2Pi: no other agents are connected");

			for (const target of targets) {
				const msgId = randomUUID();
				pendingOutgoing.set(msgId, { to: target, message: params.message, sentAt: new Date() });
				ws!.send(JSON.stringify({ type: "message", id: msgId, to: target, content: params.message }));
			}
			refreshStatus();

			const targetList = targets.join(", ");
			return {
				content: [{
					type: "text",
					text: `Message sent to ${targetList}.`,
				}],
			};
		},
	});

	pi.registerTool({
		name: "replies",
		label: "Replies",
		description:
			"Show messages you have sent that are still awaiting a reply. " +
			"Replies arrive automatically in your conversation — you do not need to call this to receive them. " +
			"Use it only to check what is still outstanding.",
		promptSnippet: "Check which messages are still awaiting a reply from other agents",
		parameters: Type.Object({}),
		async execute() {
			if (!agentName) throw new Error("Pi2Pi: not connected");
			if (pendingOutgoing.size === 0) {
				return { content: [{ type: "text", text: "No pending messages — all replies have been received." }] };
			}
			const lines = [...pendingOutgoing.values()].map(
				(p) => `${p.to}: "${p.message}" (sent ${p.sentAt.toLocaleTimeString()})`,
			);
			return {
				content: [{
					type: "text",
					text: `Pending replies (${pendingOutgoing.size}):\n${lines.join("\n")}`,
				}],
			};
		},
	});

	pi.registerTool({
		name: "reply",
		label: "Reply",
		description: "Send a reply to a specific agent who sent you an incoming message. Always use this tool to respond — do not just write a response in plain text.",
		promptSnippet: "Reply to an incoming message from another agent",
		parameters: Type.Object({
			id: Type.String({ description: "The id of the incoming message to reply to" }),
			content: Type.String({ description: "The reply to send back" }),
		}),
		renderCall(args, theme, context) {
			const t = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const from = incomingQueue.get(args.id)?.from ?? args.id;
			let content = theme.fg("muted", "Replied to ") + theme.fg("accent", from);
			if (context.expanded) {
				content += theme.fg("muted", ": ") + theme.fg("dim", args.content);
			} else {
				content += theme.fg("muted", "…");
			}
			t.setText(content);
			return t;
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("muted", "✓"), 0, 0);
		},
		async execute(_toolCallId, params) {
			if (!agentName) throw new Error("Pi2Pi: not connected");
			if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Pi2Pi: not connected to broker");
			const incoming = dequeueIncoming(params.id);
			if (!incoming) throw new Error(`Pi2Pi: no pending message with id ${params.id}`);
			ws.send(JSON.stringify({ type: "reply", id: incoming.id, content: params.content }));
			return { content: [{ type: "text", text: `Reply sent to ${incoming.from}.` }] };
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
		description: "Send a message to another agent (fire-and-forget). Usage: /tell <name|everyone> <message>",

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
					pendingOutgoing.set(msgId, { to: target, message: content, sentAt: new Date() });
					ws!.send(JSON.stringify({ type: "message", id: msgId, to: target, content }));
				}
			} else {
				// Point-to-point
				if (targetName === agentName) {
					ctx.ui.notify("Pi2Pi: you can't message yourself", "warning");
					return;
				}

				const msgId = randomUUID();
				pendingOutgoing.set(msgId, { to: targetName, message: content, sentAt: new Date() });

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

	pi.registerCommand("reply", {
		description: "Send a reply to the most recent incoming message. Usage: /reply <content>",
		handler: async (args, ctx) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				ctx.ui.notify("Pi2Pi: not connected to broker", "error");
				return;
			}
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
			const incoming = dequeueIncoming(id);
			if (!incoming) {
				ctx.ui.notify(`Pi2Pi: no pending message with id ${id}`, "warning");
				return;
			}
			ws.send(JSON.stringify({ type: "reply", id: incoming.id, content }));
			ctx.ui.notify(`Reply sent to ${incoming.from}.`, "success");
		},
	});

	pi.registerCommand("replies", {
		description: "Show messages still awaiting a reply (replies arrive automatically when they come in)",
		handler: async (_args, _ctx) => {
			const pending = [...pendingOutgoing.values()].map((p) => ({
				to: p.to,
				message: p.message,
				sentAt: p.sentAt.toISOString(),
			}));
			pi.sendMessage({
				customType: "pi2pi-pending",
				content: pending.length
					? pending.map((p) => `${p.to}: "${p.message}"`).join("\n")
					: "No pending messages.",
				display: true,
				details: { pending },
			});
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
