/**
 * Pi2Pi Extension — reply delivery tests (Priority 2)
 *
 * Tests the internal logic of pi2pi.ts: the three reply delivery paths,
 * wait timeout, tell-to-unknown-agent, and reply with invalid id.
 *
 * Strategy: a `MockPi` captures registered tools and event handlers so we can
 * invoke them directly.  A `FakeWebSocket` lets tests inject broker messages
 * (reply_result, error, incoming, etc.) without needing a real broker.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

// ── FakeWebSocket ─────────────────────────────────────────────────────────────
// pi2pi.ts uses addEventListener exclusively — no onmessage/onopen callbacks.

class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;

	readyState = FakeWebSocket.OPEN;
	sent: string[] = [];

	/** Optional hook called after every send(), for per-test interception. */
	sendInterceptor: ((data: string) => void) | null = null;

	private listeners: Map<string, Array<(e: unknown) => void>> = new Map();

	addEventListener(type: string, fn: (e: unknown) => void) {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string, fn: (e: unknown) => void) {
		const list = this.listeners.get(type) ?? [];
		this.listeners.set(type, list.filter(f => f !== fn));
	}

	send(data: string) {
		this.sent.push(data);
		this.sendInterceptor?.(data);
	}

	close() {
		this.readyState = FakeWebSocket.CLOSED;
		this._fire("close", {});
	}

	// ── Test helpers ────────────────────────────────────────────────────────

	/** Simulate the broker completing the WebSocket handshake. */
	triggerOpen() {
		this._fire("open", new Event("open"));
	}

	/**
	 * Simulate the broker pushing a message to the extension.
	 * Passes a MessageEvent-like object so `String(event.data)` gives JSON.
	 */
	receive(msg: Record<string, unknown>) {
		this._fire("message", { data: JSON.stringify(msg) });
	}

	/** All sent frames parsed as objects. */
	sentParsed(): Record<string, unknown>[] {
		return this.sent.map(s => JSON.parse(s) as Record<string, unknown>);
	}

	/** Sent frames of a specific broker message type. */
	sentOfType(type: string): Record<string, unknown>[] {
		return this.sentParsed().filter(m => m.type === type);
	}

	private _fire(type: string, event: unknown) {
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
}

// Track created FakeWebSockets so tests can access them.
let latestFakeWs: FakeWebSocket;
let fakeWss: FakeWebSocket[] = [];
const OrigWebSocket = (globalThis as unknown as { WebSocket: unknown }).WebSocket;

// ── MockPi ────────────────────────────────────────────────────────────────────

type CapturedMessage = {
	message: { customType: string; content: string; display?: boolean; details?: unknown };
	options?: { triggerTurn?: boolean; deliverAs?: string };
};

class MockPi {
	private _handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	private _tools = new Map<string, { execute: (id: string, params: unknown, sig: unknown, upd: unknown, ctx: unknown) => Promise<unknown> }>();
	private _flagValues = new Map<string, string | boolean>();

	sentMessages: CapturedMessage[] = [];
	notifications: Array<{ message: string; level?: string }> = [];
	statusUpdates: Array<{ key: string; text: string | undefined }> = [];

	// ── ExtensionAPI surface ───────────────────────────────────────────────

	on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
		const list = this._handlers.get(event) ?? [];
		list.push(handler);
		this._handlers.set(event, list);
	}

	registerTool(tool: { name: string; execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> }) {
		this._tools.set(tool.name, tool);
	}

	registerCommand() { /* no-op for tests */ }
	registerMessageRenderer() { /* no-op for tests */ }
	registerFlag() { /* no-op — values set via setFlag() */ }
	registerShortcut() { /* no-op */ }

	getFlag(name: string): boolean | string | undefined {
		return this._flagValues.get(name);
	}

	sendMessage(message: CapturedMessage["message"], options?: CapturedMessage["options"]) {
		this.sentMessages.push({ message, options });
	}

	sendUserMessage() { /* no-op */ }
	appendEntry() { /* no-op */ }
	get events() { return { emit: () => {}, on: () => () => {} }; }

	// ── Test helpers ────────────────────────────────────────────────────────

	setFlag(name: string, value: string | boolean) { this._flagValues.set(name, value); }

	/** Minimal ExtensionContext mock — matches what pi2pi.ts reads from ctx. */
	mockCtx() {
		return {
			model: null,
			getContextUsage: () => undefined,
			isIdle: () => true,
			ui: {
				notify: (message: string, level?: string) => this.notifications.push({ message, level }),
				setStatus: (key: string, text: string | undefined) => this.statusUpdates.push({ key, text }),
			},
		};
	}

	/** Fire a lifecycle event (e.g. "session_start", "agent_start", "agent_end"). */
	async fireEvent(event: string, data: Record<string, unknown> = {}) {
		const handlers = this._handlers.get(event) ?? [];
		for (const h of handlers) await h({ type: event, ...data }, this.mockCtx());
	}

	/**
	 * Call a registered tool's execute function directly.
	 * Returns the MCP-style result `{ content: [{type:"text", text:string}] }`.
	 */
	async callTool(name: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
		const tool = this._tools.get(name);
		if (!tool) throw new Error(`Tool "${name}" not registered on MockPi`);
		return tool.execute("test-call-id", params, undefined, undefined, this.mockCtx()) as Promise<{ content: Array<{ type: string; text: string }> }>;
	}

	/** Shortcut: all sendMessage calls of a given customType. */
	messagesOfType(customType: string): CapturedMessage[] {
		return this.sentMessages.filter(m => m.message.customType === customType);
	}
}

// ── Extension factory — loaded once ──────────────────────────────────────────
//
// We import pi2pi.ts dynamically (after module-level setup) so that Bun's module
// cache can resolve @earendil-works/* and typebox via the symlinks in
// node_modules/.  The factory is called with a fresh MockPi for each test.

let factory: (pi: MockPi) => void;

beforeAll(async () => {
	// Install the fake WebSocket globally BEFORE importing the extension.
	// The extension calls `new WebSocket(url)` inside connectToBroker().
	const FakeWsConstructor = class {
		constructor(_url: string) {
			const instance = new FakeWebSocket();
			latestFakeWs = instance;
			fakeWss.push(instance);
			return instance;
		}
		static OPEN = 1;
		static CLOSED = 3;
	};
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWsConstructor;

	// Dynamic import ensures the module runs AFTER globalThis.WebSocket is patched.
	const mod = await import("../pi2pi.ts");
	factory = mod.default as (pi: MockPi) => void;
});

afterAll(() => {
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = OrigWebSocket;
});

// ── Session bootstrap helper ──────────────────────────────────────────────────

interface BootOptions {
	name?: string;
	room?: string;
	rooms?: Array<{ alias: string; room: string; peers?: string[] }>;
	peers?: string[];
	displayName?: string;
	roomDisplayNames?: string;
}

/**
 * Creates a fresh MockPi, runs the extension factory, fires session_start,
 * and simulates the broker completing registration.  Returns the MockPi and
 * the FakeWebSocket the extension is connected to.
 */
async function boot(opts: BootOptions = {}): Promise<{ pi: MockPi; ws: FakeWebSocket; wss: FakeWebSocket[] }> {
	const name = opts.name ?? "TestAgent";
	const room = opts.room ?? "test-room";
	const rooms = opts.rooms ?? [{ alias: room, room, peers: opts.peers }];
	fakeWss = [];

	const pi = new MockPi();
	pi.setFlag("agent-name", name);
	if (opts.rooms) {
		pi.setFlag("rooms", rooms.map(binding => `${binding.alias}=${binding.room}`).join(","));
	} else {
		pi.setFlag("room", room);
	}
	if (opts.displayName) pi.setFlag("display-name", opts.displayName);
	if (opts.roomDisplayNames) pi.setFlag("room-display-names", opts.roomDisplayNames);
	pi.setFlag("broker", "ws://fake-broker");

	// Register all tools, handlers, message renderers.
	factory(pi);

	// Fire session_start — this calls connectToBroker(), which calls new WebSocket(...),
	// which populates latestFakeWs.
	await pi.fireEvent("session_start", { reason: "startup" });

	const ws = latestFakeWs;
	expect(ws).toBeDefined();

	// Trigger WS open → extension sends { type: "register", ... }
	for (const socket of fakeWss) socket.triggerOpen();
	await Bun.sleep(0); // flush microtasks

	// Simulate broker acknowledging registration + sending initial agent list.
	for (let i = 0; i < rooms.length; i++) {
		const binding = rooms[i];
		const socket = fakeWss[i];
		socket.receive({ type: "registered", name, room: binding.room });
		socket.receive({ type: "agent_list", agents: [name, ...(binding.peers ?? [])], room: binding.room });
	}
	await Bun.sleep(10); // let message handlers run

	return { pi, ws, wss: fakeWss };
}

describe("room-specific display names", () => {
	test("registers the leadership connection with the team display name", async () => {
		const { wss } = await boot({
			name: "blackbird.lead",
			displayName: "Alice",
			roomDisplayNames: "team=Alice,leadership=blackbird team",
			rooms: [
				{ alias: "team", room: "blackbird" },
				{ alias: "leadership", room: "leadership" },
			],
		});

		expect(wss).toHaveLength(2);
		const teamRegister = wss[0].sentOfType("register")[0];
		const leadershipRegister = wss[1].sentOfType("register")[0];
		expect(teamRegister.displayName).toBe("Alice");
		expect(leadershipRegister.displayName).toBe("blackbird team");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PATH 1: wait → read_reply
// Reply arrives while the LLM is blocking on wait(), then read_reply() claims it.
// ─────────────────────────────────────────────────────────────────────────────

describe("Reply delivery: wait → read_reply path", () => {
	test("wait resolves once the matching reply_result is received", async () => {
		const { ws } = await boot();

		// Start waiting for an id that hasn't arrived yet.
		const waitP = (await import("../pi2pi.ts").then(() => null), // module already cached
			// Call wait synchronously — replyWaiters.set() runs before first await
			null as unknown as Promise<{ content: Array<{ type: string; text: string }> }>);

		// We need a fresh boot to get the tools bound to the pi instance
		// — re-use the pi from boot() above
		const { pi, ws: ws2 } = await boot({ name: "WaitAgent" });

		const waitPromise = pi.callTool("wait", { ids: ["reply-wait-1"], timeout: 5000 });

		// Inject the reply — replyWaiters resolves synchronously via the message handler
		ws2.receive({ type: "reply_result", id: "reply-wait-1", from: "Bob", content: "Pong!" });

		const result = await waitPromise;
		expect(result.content[0].text).toContain("1");
		expect(result.content[0].text).toContain("received");
		void waitP; // suppress unused warning
	});

	test("read_reply returns content and marks the reply as claimed", async () => {
		const { pi, ws } = await boot({ name: "ReadAgent" });

		// Register a wait so the reply goes to replyBuffer (not idle-injected)
		const waitP = pi.callTool("wait", { ids: ["reply-read-1"], timeout: 5000 });

		ws.receive({ type: "reply_result", id: "reply-read-1", from: "Alice", content: "The answer is 42" });
		await waitP;

		// read_reply should return the stored reply
		const readResult = await pi.callTool("read_reply", { id: "reply-read-1" });
		expect(readResult.content[0].text).toContain("The answer is 42");
		expect(readResult.content[0].text).toContain("Alice");
	});

	test("claimed reply is not flushed again during agent_end", async () => {
		const { pi, ws } = await boot({ name: "ClaimAgent" });

		// wait → read_reply (claimed)
		const waitP = pi.callTool("wait", { ids: ["reply-claimed-1"], timeout: 5000 });
		ws.receive({ type: "reply_result", id: "reply-claimed-1", from: "Bob", content: "Claimed" });
		await waitP;
		await pi.callTool("read_reply", { id: "reply-claimed-1" });

		const countBefore = pi.messagesOfType("pi2pi-reply").length;

		// agent_end flush should NOT re-send the already-claimed reply
		await pi.fireEvent("agent_end", { messages: [] });
		await Bun.sleep(10);

		expect(pi.messagesOfType("pi2pi-reply").length).toBe(countBefore);
	});

	test("read_reply on unknown id throws", async () => {
		const { pi } = await boot({ name: "ReadBadAgent" });

		await expect(
			pi.callTool("read_reply", { id: "does-not-exist" }),
		).rejects.toThrow(/No reply available/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PATH 2: agent_end flush
// Reply arrives while an agent turn is active; it is buffered and then
// flushed (injected as a follow-up turn) when agent_end fires.
// ─────────────────────────────────────────────────────────────────────────────

describe("Reply delivery: agent_end flush path", () => {
	test("reply buffered during agent turn is flushed at agent_end", async () => {
		const { pi, ws } = await boot({ name: "FlushAgent" });

		// Simulate an active agent turn.
		await pi.fireEvent("agent_start");

		// Inject a reply while the turn is active.
		ws.receive({ type: "reply_result", id: "reply-flush-1", from: "Carol", content: "Flush me!" });
		await Bun.sleep(10);

		// The reply should NOT have been sent to sendMessage yet (turn is still active).
		expect(pi.messagesOfType("pi2pi-reply")).toHaveLength(0);

		// End the turn — triggers flush.
		await pi.fireEvent("agent_end", { messages: [] });
		await Bun.sleep(10);

		// Now the flushed reply should have been injected.
		const flushed = pi.messagesOfType("pi2pi-reply");
		expect(flushed).toHaveLength(1);
		expect(flushed[0].message.content).toContain("Flush me!");
		expect(flushed[0].message.content).toContain("Carol");
		expect(flushed[0].options?.triggerTurn).toBe(true);
		expect(flushed[0].options?.deliverAs).toBe("followUp");
	});

	test("multiple replies buffered during one turn are all flushed", async () => {
		const { pi, ws } = await boot({ name: "MultiFlushAgent" });

		await pi.fireEvent("agent_start");

		ws.receive({ type: "reply_result", id: "flush-a", from: "Alice", content: "Reply A" });
		ws.receive({ type: "reply_result", id: "flush-b", from: "Bob", content: "Reply B" });
		await Bun.sleep(10);

		expect(pi.messagesOfType("pi2pi-reply")).toHaveLength(0);

		await pi.fireEvent("agent_end", { messages: [] });
		await Bun.sleep(10);

		const flushed = pi.messagesOfType("pi2pi-reply");
		expect(flushed).toHaveLength(2);
		const contents = flushed.map(m => m.message.content);
		expect(contents.some(c => c.includes("Reply A"))).toBe(true);
		expect(contents.some(c => c.includes("Reply B"))).toBe(true);
	});

	test("reply is NOT flushed if it was claimed by read_reply during the turn", async () => {
		const { pi, ws } = await boot({ name: "ClaimDuringTurnAgent" });

		await pi.fireEvent("agent_start");

		// Register a waiter BEFORE the turn started (simulates wait called during prior turn)
		// by injecting after agent_start but using the wait tool first
		// (This tests the waiter path: replyWaiters.get(id) != null)
		const waitP = pi.callTool("wait", { ids: ["flush-claimed"], timeout: 5000 });
		ws.receive({ type: "reply_result", id: "flush-claimed", from: "Dan", content: "Claimed mid-turn" });
		await waitP;

		// Claim it
		await pi.callTool("read_reply", { id: "flush-claimed" });

		await pi.fireEvent("agent_end", { messages: [] });
		await Bun.sleep(10);

		// Should not have been flushed (claimed = true)
		expect(pi.messagesOfType("pi2pi-reply")).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PATH 3: immediate idle injection
// When a reply arrives and no agent turn is active, it is injected immediately
// via pi.sendMessage (not buffered for agent_end).
// ─────────────────────────────────────────────────────────────────────────────

describe("Reply delivery: immediate idle injection path", () => {
	test("reply arriving when agent is idle is injected immediately", async () => {
		const { pi, ws } = await boot({ name: "IdleAgent" });

		// Confirm no turn is active (default state after session_start).
		// Inject a reply — should trigger immediate sendMessage.
		ws.receive({ type: "reply_result", id: "reply-idle-1", from: "Bob", content: "Idle response!" });
		await Bun.sleep(10);

		const injected = pi.messagesOfType("pi2pi-reply");
		expect(injected).toHaveLength(1);
		expect(injected[0].message.content).toContain("Idle response!");
		expect(injected[0].message.content).toContain("Bob");
		expect(injected[0].options?.triggerTurn).toBe(true);
		expect(injected[0].options?.deliverAs).toBe("followUp");
	});

	test("idle reply injection marks the entry as claimed (no agent_end double-send)", async () => {
		const { pi, ws } = await boot({ name: "IdleClaimAgent" });

		ws.receive({ type: "reply_result", id: "reply-idle-2", from: "Eve", content: "Immediate" });
		await Bun.sleep(10);

		// Simulate the triggered turn completing
		await pi.fireEvent("agent_start");
		await pi.fireEvent("agent_end", { messages: [] });
		await Bun.sleep(10);

		// The idle-injected reply should not appear a second time after agent_end
		expect(pi.messagesOfType("pi2pi-reply")).toHaveLength(1);
	});

	test("reply arriving during a turn is NOT immediately injected — waits for agent_end", async () => {
		const { pi, ws } = await boot({ name: "BufferNotIdleAgent" });

		await pi.fireEvent("agent_start");

		ws.receive({ type: "reply_result", id: "reply-active", from: "Frank", content: "During turn" });
		await Bun.sleep(10);

		// Should not have been injected yet
		expect(pi.messagesOfType("pi2pi-reply")).toHaveLength(0);

		// Verify it IS injected after the turn ends
		await pi.fireEvent("agent_end", { messages: [] });
		await Bun.sleep(10);
		expect(pi.messagesOfType("pi2pi-reply")).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// wait timeout behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("wait tool — timeout behaviour", () => {
	test("wait throws when the reply does not arrive within the timeout", async () => {
		const { pi } = await boot({ name: "TimeoutAgent" });

		await expect(
			pi.callTool("wait", { ids: ["never-arrives"], timeout: 80 }),
		).rejects.toThrow(/Timed out waiting for replies to/i);
	});

	test("wait resolves immediately if the reply is already in the buffer", async () => {
		const { pi, ws } = await boot({ name: "AlreadyBufferedAgent" });

		// Inject reply with NO active waiter → goes to replyBuffer
		await pi.fireEvent("agent_start"); // turn active keeps idle injection from running
		ws.receive({ type: "reply_result", id: "pre-buffered", from: "Grace", content: "Already here" });
		await Bun.sleep(10);
		await pi.fireEvent("agent_end", { messages: [] }); // flush happens — this injects it

		// IMPORTANT: after agent_end flush the entry has claimed=true and is REMOVED from
		// replyBuffer. So we test the pre-agent_end scenario instead:
		// (Re-boot a fresh instance where the reply is in buffer but not yet flushed)
		const { pi: pi2, ws: ws2 } = await boot({ name: "PreBufferedAgent" });
		await pi2.fireEvent("agent_start");
		ws2.receive({ type: "reply_result", id: "pre-buf-2", from: "Hank", content: "Buffered" });
		await Bun.sleep(10);

		// wait should resolve immediately because "pre-buf-2" is now in replyBuffer
		const result = await pi2.callTool("wait", { ids: ["pre-buf-2"], timeout: 100 });
		expect(result.content[0].text).toContain("received");
	});

	test("wait for multiple ids times out if any id is missing", async () => {
		const { pi, ws } = await boot({ name: "MultiWaitTimeoutAgent" });

		// Call wait first so both ids register waiters.
		// Then deliver multi-a (resolves its waiter), leaving multi-b-never to time out.
		const multiWaitP = pi.callTool("wait", { ids: ["multi-a", "multi-b-never"], timeout: 80 });
		ws.receive({ type: "reply_result", id: "multi-a", from: "Ian", content: "First" });
		await expect(multiWaitP).rejects.toThrow(/multi-b-never/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// tell tool — unknown agent / broker error
// ─────────────────────────────────────────────────────────────────────────────

describe("tell tool — unknown agent and broker errors", () => {
	test("tell throws immediately when broker returns an error for the message", async () => {
		const { pi, ws } = await boot({ name: "TellErrorAgent", peers: ["Ghost"] });

		// Start the tell call — it runs synchronously up to its first `await`
		// (which is `await Promise.allSettled(deliveryPromises)`).  By the time
		// callTool() returns its Promise, pendingDelivery.set() has already run.
		const tellPromise = pi.callTool("tell", { to: "Ghost", message: "Hello?" });

		// The message frame is already in ws.sent (send() is synchronous)
		const msgFrame = ws.sentOfType("message")[0];
		expect(msgFrame).toBeDefined();

		// Inject the broker error — pendingDelivery entry exists, so reject fires immediately
		ws.receive({
			type: "error",
			id: msgFrame.id as string,
			reason: `Agent "Ghost" is not in room "test-room"`,
		});

		await expect(tellPromise).rejects.toThrow(/is not in room/);
	});

	test("tell throws when no agents are connected (tell everyone with empty room)", async () => {
		// Boot with no peers — only the agent itself is in onlineAgents
		const { pi } = await boot({ name: "LonelyAgent", peers: [] });

		await expect(
			pi.callTool("tell", { to: "everyone", message: "Is anyone there?" }),
		).rejects.toThrow(/no other agents/i);
	});

	test("tell sends the correct broker message format", async () => {
		const { pi, ws } = await boot({ name: "FormatAgent", peers: ["Bob"] });

		// Intercept the outgoing message and immediately ACK (inject nothing = 2s wait).
		// Instead, we inspect what was sent and inject an error to unblock quickly.
		// Start tell — runs synchronously to first await; message is in ws.sent
		const fmtPromise = pi.callTool("tell", { to: "Bob", message: "Test content" });

		const sentMsg = ws.sentOfType("message")[0];
		expect(sentMsg).toBeDefined();
		expect(sentMsg.type).toBe("message");
		expect(sentMsg.to).toBe("Bob");
		expect(sentMsg.content).toBe("Test content");
		expect(typeof sentMsg.id).toBe("string");
		expect((sentMsg.id as string).length).toBeGreaterThan(0);

		// Unblock the 2s delivery timeout quickly
		ws.receive({ type: "error", id: sentMsg.id as string, reason: "test abort" });
		await fmtPromise.catch(() => { /* expected rejection */ });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// reply tool — invalid / expired id
// ─────────────────────────────────────────────────────────────────────────────

describe("reply tool — invalid and expired message ids", () => {
	test("reply with a non-existent id throws", async () => {
		const { pi } = await boot({ name: "ReplyBadIdAgent" });

		await expect(
			pi.callTool("reply", { id: "definitely-not-a-real-id", content: "Hello" }),
		).rejects.toThrow(/no pending message/i);
	});

	test("reply with an id that has already been replied to throws", async () => {
		const { pi, ws } = await boot({ name: "ReplyExpiredAgent" });

		// Simulate an incoming message arriving (adds to incomingQueue)
		ws.receive({ type: "incoming", id: "incoming-123", from: "Alice", content: "Can you help?" });
		await Bun.sleep(10);

		// First reply — should succeed
		const first = await pi.callTool("reply", { id: "incoming-123", content: "Sure!" });
		expect(first.content[0].text).toContain("Alice");

		// Second reply with the same id — id has been dequeued, should throw
		await expect(
			pi.callTool("reply", { id: "incoming-123", content: "Duplicate" }),
		).rejects.toThrow(/no pending message/i);
	});

	test("reply with a valid id sends the correct broker frame", async () => {
		const { pi, ws } = await boot({ name: "ReplyFormatAgent" });

		// Inject an incoming message to prime the incomingQueue
		ws.receive({ type: "incoming", id: "format-incoming-1", from: "Bob", content: "Question?" });
		await Bun.sleep(10);

		const result = await pi.callTool("reply", {
			id: "format-incoming-1",
			content: "My answer",
		});

		// Verify result text
		expect(result.content[0].text).toContain("Bob");

		// Verify the correct broker frame was sent
		const replyFrames = ws.sentOfType("reply");
		expect(replyFrames.length).toBeGreaterThan(0);
		const frame = replyFrames[replyFrames.length - 1];
		expect(frame.id).toBe("format-incoming-1");
		expect(frame.content).toBe("My answer");
	});

	test("incoming message is delivered to pi.sendMessage for LLM processing", async () => {
		const { pi, ws } = await boot({ name: "IncomingDeliveryAgent" });

		ws.receive({ type: "incoming", id: "inc-deliver-1", from: "Charlie", content: "Hey there!" });
		await Bun.sleep(10);

		const incoming = pi.messagesOfType("pi2pi-incoming");
		expect(incoming).toHaveLength(1);
		expect(incoming[0].message.content).toContain("Hey there!");
		expect(incoming[0].message.content).toContain("Charlie");
		expect(incoming[0].options?.triggerTurn).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("Session lifecycle", () => {
	test("tool calls throw when session has been shut down", async () => {
		const { pi } = await boot({ name: "ShutdownAgent" });

		await pi.fireEvent("session_shutdown", { reason: "quit" });

		// After shutdown, agentName is cleared — tool calls should throw
		await expect(
			pi.callTool("who", {}),
		).rejects.toThrow(/not connected/i);
	});

	test("wait waiters are resolved (not hung) on session shutdown", async () => {
		const { pi } = await boot({ name: "ShutdownWaitAgent" });

		// Start a wait that will never receive a reply normally
		const waitP = pi.callTool("wait", { ids: ["shutdown-id"], timeout: 30000 });

		// Shut down while wait is pending
		await pi.fireEvent("session_shutdown", { reason: "quit" });

		// The wait should resolve (not hang) because shutdown resolves all waiters
		// wait() checks the buffer after waiter() is called; if reply isn't there it
		// would timeout — but shutdown resolves, giving us a settled promise quickly.
		const result = await Promise.race([
			waitP.then(() => "resolved").catch(() => "rejected"),
			Bun.sleep(500).then(() => "timed-out"),
		]);

		// It should not time out
		expect(result).not.toBe("timed-out");
	});
});
