/**
 * Broker integration tests
 *
 * Spins up a real broker subprocess on a dedicated test port and drives it
 * with WebSocket clients.  Each test uses a unique room name so they are
 * fully isolated from one another even though they share one broker process.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { join } from "path";

const TEST_PORT = 19001;
const BROKER_URL = `ws://localhost:${TEST_PORT}`;
let brokerProcess: ReturnType<typeof Bun.spawn>;

// ── TestClient helper ─────────────────────────────────────────────────────────

class TestClient {
	private ws!: WebSocket;
	private queue: Record<string, unknown>[] = [];
	private waiters: Array<(msg: Record<string, unknown>) => void> = [];
	closed = false;

	/** Open a connection to the broker and wait for it to be established. */
	static async connect(url = BROKER_URL): Promise<TestClient> {
		const c = new TestClient();
		await new Promise<void>((resolve, reject) => {
			c.ws = new WebSocket(url);
			c.ws.addEventListener("open", () => resolve());
			c.ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")));
			c.ws.addEventListener("message", (e) => c._onMessage(String(e.data)));
			c.ws.addEventListener("close", () => { c.closed = true; });
		});
		return c;
	}

	private _onMessage(raw: string) {
		const msg = JSON.parse(raw) as Record<string, unknown>;
		const waiter = this.waiters.shift();
		if (waiter) waiter(msg);
		else this.queue.push(msg);
	}

	/** Send a structured message as JSON. */
	send(msg: Record<string, unknown>) {
		this.ws.send(JSON.stringify(msg));
	}

	/** Send a raw string (e.g. to test malformed JSON handling). */
	sendRaw(raw: string) {
		this.ws.send(raw);
	}

	/**
	 * Receive the next queued message, or wait for one to arrive.
	 * Rejects after `timeoutMs` milliseconds.
	 */
	recv(timeoutMs = 2000): Promise<Record<string, unknown>> {
		if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
		return new Promise((resolve, reject) => {
			const handler = (msg: Record<string, unknown>) => { clearTimeout(t); resolve(msg); };
			const t = setTimeout(() => {
				const i = this.waiters.findIndex(w => w === handler);
				if (i !== -1) this.waiters.splice(i, 1);
				reject(new Error(`recv() timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.waiters.push(handler);
		});
	}

	/**
	 * Receive the next message of a specific `type`, stashing any unrelated
	 * messages back on the queue so they aren't silently discarded.
	 */
	async recvType(type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		const stash: Record<string, unknown>[] = [];
		try {
			while (Date.now() < deadline) {
				const msg = await this.recv(deadline - Date.now());
				if (msg.type === type) {
					this.queue.unshift(...stash);
					return msg;
				}
				stash.push(msg);
			}
			throw new Error(`Timed out waiting for message type "${type}"`);
		} catch (e) {
			this.queue.unshift(...stash);
			throw e;
		}
	}

	/**
	 * Send a register message and wait for the "registered" acknowledgement.
	 * Other messages received in the meantime (e.g. agent_list) remain in the queue.
	 */
	async register(name: string, room: string): Promise<Record<string, unknown>> {
		this.send({ type: "register", name, room });
		return this.recvType("registered");
	}

	/** Return and remove all messages currently buffered (non-blocking). */
	drain(): Record<string, unknown>[] {
		const msgs = [...this.queue];
		this.queue = [];
		return msgs;
	}

	/** Close the WebSocket and wait for the close event. */
	close(): Promise<void> {
		return new Promise((resolve) => {
			if (this.closed) { resolve(); return; }
			this.ws.addEventListener("close", () => resolve());
			try { this.ws.close(); } catch { /* ignore */ }
		});
	}
}

// ── Broker lifecycle ──────────────────────────────────────────────────────────

async function waitForBroker(port: number, attempts = 40): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		try {
			const ws = new WebSocket(`ws://localhost:${port}`);
			await new Promise<void>((res, rej) => {
				ws.addEventListener("open", () => { ws.close(); res(); });
				ws.addEventListener("error", () => rej(new Error("not ready")));
			});
			return;
		} catch {
			await Bun.sleep(100);
		}
	}
	throw new Error(`Broker did not become ready on port ${port}`);
}

let roomCounter = 0;
/** Return a unique room name for each test to prevent cross-test interference. */
const nextRoom = () => `room-${++roomCounter}`;

beforeAll(async () => {
	brokerProcess = Bun.spawn(
		["bun", join(import.meta.dir, "../broker.ts"), "--port", String(TEST_PORT)],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await waitForBroker(TEST_PORT);
});

afterAll(() => {
	brokerProcess.kill();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

describe("Registration", () => {
	test("successful registration returns registered message with name and room", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const msg = await alice.register("Alice", r);
		expect(msg.type).toBe("registered");
		expect(msg.name).toBe("Alice");
		expect(msg.room).toBe(r);
		await alice.close();
	});

	test("registration broadcasts agent_list containing the new agent", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		alice.send({ type: "register", name: "Alice", room: r });
		await alice.recvType("registered");
		const listMsg = await alice.recvType("agent_list");
		expect(listMsg.agents).toContain("Alice");
		expect(listMsg.room).toBe(r);
		await alice.close();
	});

	test("second agent joining updates agent_list for both agents", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();

		// Explicitly consume both the registered ack AND the initial single-member
		// agent_list using recvType (not drain) so we wait for the list to actually
		// arrive rather than racing against the async WebSocket message event.
		alice.send({ type: "register", name: "Alice", room: r });
		await alice.recvType("registered");
		await alice.recvType("agent_list"); // consume the single-member list

		await bob.register("Bob", r);

		// Both should now receive an updated list containing both members
		const aliceList = await alice.recvType("agent_list");
		const bobList = await bob.recvType("agent_list");

		expect((aliceList.agents as string[]).sort()).toEqual(["Alice", "Bob"]);
		expect((bobList.agents as string[]).sort()).toEqual(["Alice", "Bob"]);

		await alice.close();
		await bob.close();
	});

	test("register with empty name returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "register", name: "", room: nextRoom() });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/non-empty name/);
		await client.close();
	});

	test("register with missing name field returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "register", room: nextRoom() });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/non-empty name/);
		await client.close();
	});

	test("register with empty room returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "register", name: "Alice", room: "" });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/non-empty room/);
		await client.close();
	});

	test("register with missing room field returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "register", name: "Alice" });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/non-empty room/);
		await client.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MESSAGE ROUTING
// ─────────────────────────────────────────────────────────────────────────────

describe("Message routing", () => {
	test("message from Alice reaches Bob as an 'incoming' message", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		alice.send({ type: "message", id: "msg-1", to: "Bob", content: "Hello Bob!" });
		const incoming = await bob.recvType("incoming");

		expect(incoming.id).toBe("msg-1");
		expect(incoming.from).toBe("Alice");
		expect(incoming.content).toBe("Hello Bob!");

		await alice.close();
		await bob.close();
	});

	test("reply from Bob routes back to Alice as 'reply_result'", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		alice.send({ type: "message", id: "msg-2", to: "Bob", content: "Ping" });
		await bob.recvType("incoming");

		bob.send({ type: "reply", id: "msg-2", content: "Pong" });
		const result = await alice.recvType("reply_result");

		expect(result.id).toBe("msg-2");
		expect(result.from).toBe("Bob");
		expect(result.content).toBe("Pong");

		await alice.close();
		await bob.close();
	});

	test("replying cleans up the pending entry (second reply to same id returns error)", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		alice.send({ type: "message", id: "msg-cleanup", to: "Bob", content: "Hi" });
		await bob.recvType("incoming");
		bob.send({ type: "reply", id: "msg-cleanup", content: "First reply" });
		await alice.recvType("reply_result");

		// Attempt a second reply with the same id — should fail
		bob.send({ type: "reply", id: "msg-cleanup", content: "Duplicate reply" });
		const err = await bob.recvType("error");
		expect(String(err.reason)).toMatch(/No pending message/);

		await alice.close();
		await bob.close();
	});

	test("message to unknown agent returns error with the message id", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		await alice.register("Alice", r);
		alice.drain();

		alice.send({ type: "message", id: "msg-ghost", to: "Ghost", content: "Hello?" });
		const err = await alice.recvType("error");

		expect(err.id).toBe("msg-ghost");
		expect(String(err.reason)).toMatch(/not in room/);

		await alice.close();
	});

	test("message before registration returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "message", id: "msg-unreg", to: "Bob", content: "Hi" });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/register before sending/);
		await client.close();
	});

	test("message missing content returns error", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		await alice.register("Alice", r);
		alice.drain();

		alice.send({ type: "message", id: "msg-bad", to: "Bob" }); // no content
		const err = await alice.recvType("error");
		expect(String(err.reason)).toMatch(/requires id, to, and content/);

		await alice.close();
	});

	test("reply with unknown message id returns error", async () => {
		const r = nextRoom();
		const bob = await TestClient.connect();
		await bob.register("Bob", r);
		bob.drain();

		bob.send({ type: "reply", id: "nonexistent-id", content: "Oops" });
		const err = await bob.recvType("error");
		expect(String(err.reason)).toMatch(/No pending message/);

		await bob.close();
	});

	test("reply before registration returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "reply", id: "some-id", content: "Hi" });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/register before sending replies/);
		await client.close();
	});

	test("invalid JSON payload returns error", async () => {
		const client = await TestClient.connect();
		client.sendRaw("{ this is not : valid JSON {{");
		const err = await client.recvType("error");
		expect(err.id).toBeNull();
		expect(String(err.reason)).toMatch(/Invalid JSON/);
		await client.close();
	});

	test("unknown message type returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "teleport", id: "x" });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/Unknown message type/);
		await client.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ROOM ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe("Room isolation", () => {
	test("agent cannot message an agent in a different room", async () => {
		const roomA = nextRoom();
		const roomB = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", roomA);
		await bob.register("Bob", roomB);
		alice.drain(); bob.drain();

		alice.send({ type: "message", id: "cross-room", to: "Bob", content: "Can you hear me?" });
		const err = await alice.recvType("error");

		expect(err.id).toBe("cross-room");
		expect(String(err.reason)).toMatch(/not in room/);

		await alice.close();
		await bob.close();
	});

	test("agent_list only contains agents in the same room", async () => {
		const roomA = nextRoom();
		const roomB = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		const carol = await TestClient.connect();

		await alice.register("Alice", roomA);
		await bob.register("Bob", roomA);
		await carol.register("Carol", roomB);
		alice.drain(); bob.drain(); carol.drain();

		// Force a fresh agent_list for Alice by having a new agent join roomA
		const dave = await TestClient.connect();
		await dave.register("Dave", roomA);
		const aliceList = await alice.recvType("agent_list");

		expect((aliceList.agents as string[]).sort()).toEqual(["Alice", "Bob", "Dave"]);
		expect(aliceList.agents as string[]).not.toContain("Carol");

		await alice.close();
		await bob.close();
		await carol.close();
		await dave.close();
	});

	test("messages between same-room agents are not received by other-room agents", async () => {
		const roomA = nextRoom();
		const roomB = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		const carol = await TestClient.connect();

		await alice.register("Alice", roomA);
		await bob.register("Bob", roomA);
		await carol.register("Carol", roomB);
		alice.drain(); bob.drain(); carol.drain();

		alice.send({ type: "message", id: "private-msg", to: "Bob", content: "Secret" });
		const bobIncoming = await bob.recvType("incoming");
		expect(bobIncoming.content).toBe("Secret");

		// Give the broker a moment to route, then verify Carol got nothing
		await Bun.sleep(50);
		const carolMsgs = carol.drain();
		expect(carolMsgs.filter(m => m.type === "incoming")).toHaveLength(0);

		await alice.close();
		await bob.close();
		await carol.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DUPLICATE AGENT NAME EVICTION
// ─────────────────────────────────────────────────────────────────────────────

describe("Duplicate agent name eviction", () => {
	test("re-registering the same name in the same room evicts the previous connection", async () => {
		const r = nextRoom();
		const alice1 = await TestClient.connect();
		await alice1.register("Alice", r);
		alice1.drain();

		const alice2 = await TestClient.connect();
		// Don't use the register() helper here — we want to check alice1's side first
		alice2.send({ type: "register", name: "Alice", room: r });

		// The original connection should receive an eviction error
		const evictionErr = await alice1.recvType("error");
		expect(String(evictionErr.reason)).toMatch(/Replaced by a new connection/);

		// The new connection should successfully register
		const registered = await alice2.recvType("registered");
		expect(registered.name).toBe("Alice");

		await alice2.close();
	});

	test("same name in different rooms does not cause eviction", async () => {
		const roomA = nextRoom();
		const roomB = nextRoom();
		const alice1 = await TestClient.connect();
		const alice2 = await TestClient.connect();

		const reg1 = await alice1.register("Alice", roomA);
		const reg2 = await alice2.register("Alice", roomB);

		expect(reg1.type).toBe("registered");
		expect(reg2.type).toBe("registered");
		expect(reg1.room).toBe(roomA);
		expect(reg2.room).toBe(roomB);

		// Neither should have received an eviction error
		await Bun.sleep(50);
		const alice1Msgs = alice1.drain();
		const alice2Msgs = alice2.drain();
		expect(alice1Msgs.filter(m => m.type === "error")).toHaveLength(0);
		expect(alice2Msgs.filter(m => m.type === "error")).toHaveLength(0);

		await alice1.close();
		await alice2.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DISCONNECTION HANDLING
// ─────────────────────────────────────────────────────────────────────────────

describe("Disconnection handling", () => {
	test("originator is notified when target disconnects before replying", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		alice.send({ type: "message", id: "msg-disc", to: "Bob", content: "Will you reply?" });
		await bob.recvType("incoming");

		// Bob disconnects without replying
		await bob.close();
		await Bun.sleep(100); // wait for close event to propagate

		const err = await alice.recvType("error");
		expect(err.id).toBe("msg-disc");
		expect(String(err.reason)).toMatch(/disconnected before replying/);

		await alice.close();
	});

	test("agent_list is updated when an agent disconnects", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		await bob.close();
		await Bun.sleep(100);

		const listMsg = await alice.recvType("agent_list");
		expect(listMsg.agents as string[]).not.toContain("Bob");
		expect(listMsg.agents).toContain("Alice");

		await alice.close();
	});

	test("reply still routes to originator after they disconnect and reconnect", async () => {
		const r = nextRoom();
		const alice1 = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice1.register("Alice", r);
		await bob.register("Bob", r);
		alice1.drain(); bob.drain();

		// Alice sends a message then disconnects before Bob replies
		alice1.send({ type: "message", id: "msg-reconnect", to: "Bob", content: "Ping" });
		await bob.recvType("incoming");
		await alice1.close();

		// Alice reconnects with a brand-new WebSocket and re-registers
		const alice2 = await TestClient.connect();
		await alice2.register("Alice", r);
		alice2.drain();

		// Now Bob sends the reply — it should route to alice2
		bob.send({ type: "reply", id: "msg-reconnect", content: "Pong" });
		const result = await alice2.recvType("reply_result");

		expect(result.id).toBe("msg-reconnect");
		expect(result.from).toBe("Bob");
		expect(result.content).toBe("Pong");

		await alice2.close();
		await bob.close();
	});

	test("reply for message with disconnected originator returns error to responder", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		alice.send({ type: "message", id: "msg-gone", to: "Bob", content: "Bye" });
		await bob.recvType("incoming");

		// Alice disconnects permanently (won't reconnect before Bob replies)
		await alice.close();
		await Bun.sleep(100);

		// Bob tries to reply — originator is gone
		bob.send({ type: "reply", id: "msg-gone", content: "Too late?" });
		const err = await bob.recvType("error");
		expect(String(err.reason)).toMatch(/no longer connected/i);

		await bob.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. STATUS / AGENT_STATUS
// ─────────────────────────────────────────────────────────────────────────────

describe("Status updates", () => {
	test("status message broadcasts agent_status to all room members including sender", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		alice.send({
			type: "status",
			state: "active",
			model: "gpt-4o",
			contextTokens: 1000,
			contextWindow: 128000,
			contextPercent: 0.78,
		});

		const aliceStatus = await alice.recvType("agent_status");
		const bobStatus = await bob.recvType("agent_status");

		for (const s of [aliceStatus, bobStatus]) {
			expect(s.name).toBe("Alice");
			expect(s.room).toBe(r);
			expect(s.state).toBe("active");
			expect(s.model).toBe("gpt-4o");
		}

		await alice.close();
		await bob.close();
	});

	test("status idle state is broadcast correctly", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		await alice.register("Alice", r);
		alice.drain();

		alice.send({ type: "status", state: "idle", model: null, contextTokens: null, contextWindow: null, contextPercent: null });
		const status = await alice.recvType("agent_status");

		expect(status.state).toBe("idle");
		expect(status.model).toBeNull();

		await alice.close();
	});

	test("status with invalid state value returns error", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		await alice.register("Alice", r);
		alice.drain();

		alice.send({ type: "status", state: "sleeping" });
		const err = await alice.recvType("error");
		expect(String(err.reason)).toMatch(/active.*idle|idle.*active/);

		await alice.close();
	});

	test("status before registration returns error", async () => {
		const client = await TestClient.connect();
		client.send({ type: "status", state: "active" });
		const err = await client.recvType("error");
		expect(String(err.reason)).toMatch(/register before sending status/);
		await client.close();
	});

	test("status does not leak to agents in other rooms", async () => {
		const roomA = nextRoom();
		const roomB = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", roomA);
		await bob.register("Bob", roomB);
		alice.drain(); bob.drain();

		alice.send({
			type: "status",
			state: "active",
			model: null,
			contextTokens: null,
			contextWindow: null,
			contextPercent: null,
		});
		await alice.recvType("agent_status"); // alice's own broadcast

		await Bun.sleep(50);
		const bobMsgs = bob.drain();
		expect(bobMsgs.filter(m => m.type === "agent_status")).toHaveLength(0);

		await alice.close();
		await bob.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. BROADCAST ("TELL EVERYONE" SIMULATION)
// ─────────────────────────────────────────────────────────────────────────────

describe("Broadcast (tell everyone simulation)", () => {
	test("agent_list accurately reflects all members so a sender knows who to address", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		const carol = await TestClient.connect();

		await alice.register("Alice", r);
		await bob.register("Bob", r);
		await carol.register("Carol", r);
		alice.drain(); bob.drain(); carol.drain();

		// Trigger a fresh agent_list by re-registering (eviction of self is a no-op)
		alice.send({ type: "register", name: "Alice", room: r });
		await alice.recvType("registered");
		const listMsg = await alice.recvType("agent_list");

		expect((listMsg.agents as string[]).sort()).toEqual(["Alice", "Bob", "Carol"]);

		await alice.close();
		await bob.close();
		await carol.close();
	});

	test("individual messages sent to each room member all arrive correctly", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		const carol = await TestClient.connect();

		await alice.register("Alice", r);
		await bob.register("Bob", r);
		await carol.register("Carol", r);
		alice.drain(); bob.drain(); carol.drain();

		// Simulate "tell everyone" — Alice sends individual messages to Bob and Carol
		alice.send({ type: "message", id: "bcast-bob", to: "Bob", content: "Hello everyone!" });
		alice.send({ type: "message", id: "bcast-carol", to: "Carol", content: "Hello everyone!" });

		const bobMsg = await bob.recvType("incoming");
		const carolMsg = await carol.recvType("incoming");

		expect(bobMsg.from).toBe("Alice");
		expect(carolMsg.from).toBe("Alice");
		expect(bobMsg.content).toBe("Hello everyone!");
		expect(carolMsg.content).toBe("Hello everyone!");
		// IDs are preserved
		expect(bobMsg.id).toBe("bcast-bob");
		expect(carolMsg.id).toBe("bcast-carol");

		await alice.close();
		await bob.close();
		await carol.close();
	});

	test("sender is not included in the agent_list (can exclude self for broadcast)", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();

		await alice.register("Alice", r);
		await bob.register("Bob", r);
		alice.drain(); bob.drain();

		// The agent_list includes Alice herself — client code must filter self out
		alice.send({ type: "register", name: "Alice", room: r });
		await alice.recvType("registered");
		const listMsg = await alice.recvType("agent_list");
		const others = (listMsg.agents as string[]).filter(n => n !== "Alice");

		expect(others).toEqual(["Bob"]);

		await alice.close();
		await bob.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. HTTP /agents ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP /agents endpoint", () => {
	test("returns JSON with registered agents grouped by room", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		const bob = await TestClient.connect();
		await alice.register("Alice", r);
		await bob.register("Bob", r);

		const resp = await fetch(`http://localhost:${TEST_PORT}/agents`);
		expect(resp.ok).toBe(true);
		expect(resp.headers.get("content-type")).toMatch(/application\/json/);

		const body = await resp.json() as { rooms: Record<string, Array<{ name: string }>> };
		expect(body.rooms).toBeDefined();
		expect(body.rooms[r]).toBeDefined();

		const names = body.rooms[r].map(a => a.name).sort();
		expect(names).toEqual(["Alice", "Bob"]);

		await alice.close();
		await bob.close();
	});

	test("root path returns 200 plain-text response (not WebSocket upgrade path)", async () => {
		const resp = await fetch(`http://localhost:${TEST_PORT}/`);
		expect(resp.status).toBe(200);
		const body = await resp.text();
		expect(body).toContain("Pi2Pi Broker");
	});

	test("/agents response includes agent status fields", async () => {
		const r = nextRoom();
		const alice = await TestClient.connect();
		await alice.register("Alice", r);
		alice.drain();

		alice.send({ type: "status", state: "active", model: "claude-3-5", contextTokens: 5000, contextWindow: 200000, contextPercent: 2.5 });
		await alice.recvType("agent_status");

		const resp = await fetch(`http://localhost:${TEST_PORT}/agents`);
		const body = await resp.json() as { rooms: Record<string, Array<Record<string, unknown>>> };
		const agentEntry = body.rooms[r]?.find(a => a.name === "Alice");

		expect(agentEntry).toBeDefined();
		expect(agentEntry!.state).toBe("active");
		expect(agentEntry!.model).toBe("claude-3-5");

		await alice.close();
	});

	test("/agents response includes displayName when provided during registration", async () => {
		const r = nextRoom();
		const leader = await TestClient.connect();
		leader.send({ type: "register", name: "pi2pi.lead", displayName: "Alice", room: r });
		await leader.recvType("registered");
		await leader.recvType("agent_list");

		const resp = await fetch(`http://localhost:${TEST_PORT}/agents`);
		const body = await resp.json() as { rooms: Record<string, Array<Record<string, unknown>>> };
		const agentEntry = body.rooms[r]?.find(a => a.name === "pi2pi.lead");

		expect(agentEntry).toBeDefined();
		expect(agentEntry!.displayName).toBe("Alice");

		await leader.close();
	});
});
