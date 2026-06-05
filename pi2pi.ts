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
import { keyHint } from "@earendil-works/pi-coding-agent";
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

	// Agent instrumentation state — sent to broker as status updates.
	let agentModel: string | null = null;
	let agentState: "active" | "idle" = "idle";
	let getContextUsage: (() => { tokens: number | null; contextWindow: number; percent: number | null } | undefined) | null = null;

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

	// Delivery confirmations: resolves silently on timeout, rejects immediately on broker error.
	const pendingDelivery = new Map<string, { reject: (reason: string) => void; resolve: () => void }>();

	// Full history of sent messages (capped at MAX_SENT_HISTORY, oldest dropped first).
	const MAX_SENT_HISTORY = 100;
	type SentEntry = { id: string; to: string; message: string; sentAt: Date; repliedAt?: Date };
	const sentHistory = new Map<string, SentEntry>();

	function addToHistory(id: string, to: string, message: string) {
		sentHistory.set(id, { id, to, message, sentAt: new Date() });
		if (sentHistory.size > MAX_SENT_HISTORY) {
			sentHistory.delete(sentHistory.keys().next().value!);
		}
	}

	// Buffer of received replies not yet consumed by read/wait.
	type ReplyEntry = { id: string; from: string; content: string; receivedAt: Date; claimed: boolean };
	const replyBuffer = new Map<string, ReplyEntry>();

	// Resolvers registered by the wait tool, keyed by message id.
	const replyWaiters = new Map<string, () => void>();

	// True while an agent turn is in progress; used to decide whether to inject
	// replies immediately or wait for the agent_end flush.
	let agentTurnActive = false;

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

	// "📨 Sent messages" — shown by /replies command
	pi.registerMessageRenderer("pi2pi-pending", (message, _options, theme) => {
		const details = message.details as { messages: Array<{ id: string; to: string; message: string; sentAt: string; repliedAt?: string }> } | undefined;
		const messages = details?.messages ?? [];
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		if (messages.length === 0) {
			box.addChild(new Text(theme.fg("muted", "No messages sent yet."), 0, 0));
		} else {
			const header = theme.fg("accent", `📨 Sent messages (${messages.length})`) + "\n";
			const lines = messages.map((p) => {
				const status = p.repliedAt ? theme.fg("success", "✓") : theme.fg("warning", "⏳");
				const time = p.repliedAt
					? theme.fg("muted", `replied ${new Date(p.repliedAt).toLocaleTimeString()}`)
					: theme.fg("muted", `sent ${new Date(p.sentAt).toLocaleTimeString()}`);
				return status + " " +
					theme.fg("accent", p.to) +
					theme.fg("dim", ` [id: ${p.id}]`) +
					theme.fg("muted", ` — "${p.message}" (`) +
					time +
					theme.fg("muted", ")");
			});
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

	function sendStatus() {
		if (!ws || ws.readyState !== WebSocket.OPEN || !agentName) return;
		const usage = getContextUsage?.();
		ws.send(JSON.stringify({
			type: "status",
			state: agentState,
			model: agentModel,
			contextTokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? null,
			contextPercent: usage?.percent ?? null,
		}));
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
				// Send initial idle status so the broker dashboard has data immediately.
				sendStatus();
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
				const histEntry = sentHistory.get(id);
				if (histEntry) histEntry.repliedAt = new Date();
				refreshStatus();

				// Store in buffer. Delivery to the LLM happens either via the read tool
				// (claimed explicitly), the agent_end flush (unclaimed, turn active),
				// or immediately if no turn is currently active.
				const entry: ReplyEntry = { id, from, content, receivedAt: new Date(), claimed: false };

				// Signal any wait tool that is blocking on this id.
				const waiter = replyWaiters.get(id);
				if (waiter) {
					replyWaiters.delete(id);
					replyBuffer.set(id, entry);
					waiter();
				} else if (!agentTurnActive) {
					// Agent is idle — inject immediately so it doesn't wait for a
					// user message to trigger the next agent_end flush.
					entry.claimed = true;
					pi.sendMessage({
						customType: "pi2pi-reply",
						content: `[Incoming message received from ${from}, id: ${id}]\n${from}: ${content}`,
						display: true,
						details: { from, full: content },
					}, { triggerTurn: true, deliverAs: "followUp" });
				} else {
					replyBuffer.set(id, entry);
				}
				break;
			}

			// ── Error from broker ────────────────────────────────────────────
			case "error": {
				const forId = id ? ` (id ${id})` : "";
				notify(`Broker error${forId}: ${reason ?? "unknown"}`, "error");

				if (id) {
					// Reject the delivery promise so the tell tool throws immediately.
					pendingDelivery.get(id)?.reject(reason ?? "unknown error");
					pendingDelivery.delete(id);
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
		agentModel = ctx.model ? (ctx.model.name || ctx.model.id) : null;
		getContextUsage = ctx.getContextUsage.bind(ctx);

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
		agentModel = null;
		agentState = "idle";
		getContextUsage = null;
		agentName = null;
		agentRoom = null;
		incomingQueue.clear();
		pendingOutgoing.clear();
		pendingDelivery.clear();
		sentHistory.clear();
		replyBuffer.clear();
		readReplyMeta.clear();
		// Reject any in-flight wait calls so they don't hang forever.
		for (const resolve of replyWaiters.values()) resolve(); // resolving is safe; wait checks buffer
		replyWaiters.clear();
		onlineAgents = [];
		if (ws) {
			try {
				ws.close();
			} catch {}
			ws = null;
		}
	});



	// ── Flush unclaimed replies at the end of each agent turn ────────────────
	// Replies are always buffered first. If the agent used wait+read they will
	// have been claimed already. Any that weren't are injected here as follow-up
	// turns so the agent still sees them on the next turn.
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
			pi.sendMessage({
				customType: "pi2pi-reply",
				content: `[Incoming message received from ${entry.from}, id: ${entry.id}]\n${entry.from}: ${entry.content}`,
				display: true,
				details: { from: entry.from, full: entry.content },
			}, { triggerTurn: true, deliverAs: "followUp" });
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

			// Send each message and register a short-lived delivery promise.
			// The promise rejects immediately if the broker returns an error (e.g. unknown
			// agent name), or resolves silently after a timeout, after which the actual
			// reply will arrive asynchronously as a follow-up message.
			const DELIVERY_TIMEOUT_MS = 2000;
			const sent: { target: string; msgId: string }[] = [];
			const deliveryPromises: Promise<void>[] = [];

			for (const target of targets) {
				const msgId = randomUUID();
				sent.push({ target, msgId });
				pendingOutgoing.set(msgId, { to: target, message: params.message, sentAt: new Date() });
				addToHistory(msgId, target, params.message);
				ws!.send(JSON.stringify({ type: "message", id: msgId, to: target, content: params.message }));

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
				.map((r, i) => r.status === "rejected" ? `${sent[i].target}: ${r.reason}` : null)
				.filter(Boolean) as string[];

			if (failures.length > 0) throw new Error(failures.join("; "));

			const targetList = sent.map(({ target, msgId }) => `${target} [id: ${msgId}]`).join(", ");
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
			"Show all messages you have sent, with their status (replied or awaiting reply). " +
			"Replies arrive automatically in your conversation — you do not need to call this to receive them.",
		promptSnippet: "Show all sent messages and whether replies have been received",
		parameters: Type.Object({}),
		async execute() {
			if (!agentName) throw new Error("Pi2Pi: not connected");
			if (sentHistory.size === 0) {
				return { content: [{ type: "text", text: "No messages sent yet." }] };
			}
			const lines = [...sentHistory.values()].reverse().map((p) => {
				const status = p.repliedAt ? "✓" : "⏳";
				const time = p.repliedAt
					? `replied ${p.repliedAt.toLocaleTimeString()}`
					: `sent ${p.sentAt.toLocaleTimeString()}`;
				return `${status} ${p.to} [id: ${p.id}] — "${p.message}" (${time})`;
			});
			return {
				content: [{
					type: "text",
					text: `Sent messages (${sentHistory.size}):\n${lines.join("\n")}`,
				}],
			};
		},
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description:
			"Wait for replies to arrive for one or more sent messages. " +
			"Blocks until all specified replies have been received or the timeout is reached. " +
			"Use the read tool afterwards to retrieve the reply content.",
		promptSnippet: "Wait for replies to specific sent messages before proceeding",
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { description: "Message ids to wait for" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
		}),
		async execute(_toolCallId, params) {
			const timeout = params.timeout ?? 30000;
			const promises = params.ids.map((id) => {
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
			const timedOut = results
				.map((r, i) => r.status === "rejected" ? params.ids[i] : null)
				.filter(Boolean) as string[];
			if (timedOut.length > 0) throw new Error(`Timed out waiting for replies to: ${timedOut.join(", ")}`);
			return { content: [{ type: "text", text: `All ${params.ids.length} ${params.ids.length === 1 ? "reply" : "replies"} received. Use the read tool to retrieve ${params.ids.length === 1 ? "it" : "them"}.` }] };
		},
	});

	// Metadata for read_reply render, keyed by toolCallId.
	const readReplyMeta = new Map<string, { from: string }>();

	pi.registerTool({
		name: "read_reply",
		label: "Read Reply",
		description:
			"Read the reply for a specific sent message. " +
			"The reply is removed from the queue so it will not be delivered again as a follow-up message. " +
			"Call wait first to ensure the reply has arrived.",
		promptSnippet: "Read the reply for a specific sent message",
		parameters: Type.Object({
			id: Type.String({ description: "The message id to read the reply for" }),
		}),
		renderResult(result, { expanded }, theme, context) {
			const from = readReplyMeta.get(context.toolCallId)?.from ?? "?";
			if (!expanded) {
				return new Text(theme.fg("muted", "Reply received from ") + theme.fg("accent", from), 0, 0);
			}
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params) {
			const entry = replyBuffer.get(params.id);
			if (!entry) throw new Error(`No reply available for id ${params.id} — has it arrived yet? Use the wait tool first.`);
			entry.claimed = true;
			if (toolCallId) readReplyMeta.set(toolCallId, { from: entry.from });
			return {
				content: [{
					type: "text",
					text: `[Incoming message received from ${entry.from}, id: ${entry.id}]\n${entry.from}: ${entry.content}`,
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
					addToHistory(msgId, target, content);
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
				addToHistory(msgId, targetName, content);

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
		description: "Show all sent messages with their status (replied or awaiting reply)",
		handler: async (_args, _ctx) => {
			const messages = [...sentHistory.values()].reverse().map((p) => ({
				id: p.id,
				to: p.to,
				message: p.message,
				sentAt: p.sentAt.toISOString(),
				repliedAt: p.repliedAt?.toISOString(),
			}));
			pi.sendMessage({
				customType: "pi2pi-pending",
				content: messages.length
					? messages.map((p) => `${p.repliedAt ? "✓" : "⏳"} ${p.to} [id: ${p.id}] — "${p.message}"`).join("\n")
					: "No messages sent yet.",
				display: true,
				details: { messages },
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
