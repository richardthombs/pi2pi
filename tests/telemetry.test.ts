/**
 * Telemetry extension tests
 *
 * Tests the SQLite schema, session/task/turn lifecycle, CoT capture,
 * tool call recording, the telemetry_query tool, and pi2pi decoration.
 *
 * Since the extension factory uses pi's ExtensionAPI, we drive it through
 * a lightweight harness that simulates the event lifecycle.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Minimal pi harness ────────────────────────────────────────────────────────

type EventName = string;
type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakeCtx {
	model: { id: string; name: string; provider: string } | null;
	cwd: string;
	getContextUsage: () => undefined;
}

function makeHarness(dbPath: string) {
	const handlers = new Map<EventName, Handler[]>();
	const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
	const eventBusListeners = new Map<string, Array<(data: unknown) => void>>();
	const flags: Record<string, unknown> = {
		"telemetry-db": dbPath,
		"telemetry-agent-name": "test-agent",
		"telemetry-session-label": "test-session",
	};

	const ctx: FakeCtx = {
		model: { id: "claude-3-opus", name: "Claude 3 Opus", provider: "anthropic" },
		cwd: "/test",
		getContextUsage: () => undefined,
	};

	const pi = {
		registerFlag: (_name: string, _opts: unknown) => {},
		getFlag: (name: string) => flags[name] ?? undefined,
		registerTool: (def: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => {
			tools.set(def.name, def);
		},
		registerCommand: (_name: string, _opts: unknown) => {},
		sendMessage: (_msg: unknown) => {},
		on: (event: EventName, handler: Handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		events: {
			on: (event: string, handler: (data: unknown) => void) => {
				if (!eventBusListeners.has(event)) eventBusListeners.set(event, []);
				eventBusListeners.get(event)!.push(handler);
			},
			emit: (event: string, data: unknown) => {
				for (const handler of eventBusListeners.get(event) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;

	async function fire(event: EventName, eventData: unknown = {}, fakeCtx: unknown = ctx) {
		for (const handler of handlers.get(event) ?? []) {
			await handler(eventData, fakeCtx);
		}
	}

	async function callTool(name: string, params: unknown) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool not registered: ${name}`);
		return tool.execute("test-call-id", params);
	}

	return { pi, fire, callTool, flags, ctx, events: pi.events };
}

// ── Import the extension factory ──────────────────────────────────────────────

// Dynamic import so each test suite can get a fresh instance
async function loadExtension(dbPath: string) {
	// We need a fresh module-level closure for each test, so we load via dynamic import.
	// The extension is a default export factory function.
	const mod = await import("../telemetry.ts");
	const factory = mod.default as (pi: ExtensionAPI) => void;
	const harness = makeHarness(dbPath);
	factory(harness.pi);
	return harness;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAssistantMessage(opts: {
	thinking?: string[];
	text?: string[];
	usage?: Partial<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; total: number };
	}>;
	stopReason?: string;
}) {
	return {
		role: "assistant",
		content: [
			...(opts.thinking ?? []).map(t => ({ type: "thinking", thinking: t })),
			...(opts.text ?? []).map(t => ({ type: "text", text: t })),
		],
		usage: {
			input: opts.usage?.input ?? 100,
			output: opts.usage?.output ?? 50,
			cacheRead: opts.usage?.cacheRead ?? 0,
			cacheWrite: opts.usage?.cacheWrite ?? 0,
			totalTokens: opts.usage?.totalTokens ?? 150,
			cost: {
				input: opts.usage?.cost?.input ?? 0.001,
				output: opts.usage?.cost?.output ?? 0.002,
				total: opts.usage?.cost?.total ?? 0.003,
			},
		},
		stopReason: opts.stopReason ?? "stop",
		model: "claude-3-opus",
		provider: "anthropic",
	};
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("telemetry extension", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-telemetry-test-"));
		dbPath = join(tmpDir, "telemetry.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── Phase 1: Schema creation ──────────────────────────────────────────────

	describe("schema creation", () => {
		test("DB file is created on session_start", async () => {
			const h = await loadExtension(dbPath);
			expect(existsSync(dbPath)).toBe(false);
			await h.fire("session_start", {});
			expect(existsSync(dbPath)).toBe(true);
		});

		test("all tables exist after session_start", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			const db = new Database(dbPath, { readonly: true });
			const tables = db.query<{ name: string }, []>(
				`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
			).all().map(r => r.name);
			db.close();

			expect(tables).toContain("sessions");
			expect(tables).toContain("tasks");
			expect(tables).toContain("turns");
			expect(tables).toContain("thinking_blocks");
			expect(tables).toContain("assistant_text");
			expect(tables).toContain("tool_calls");
		});
	});

	// ── Phase 2: Session lifecycle ────────────────────────────────────────────

	describe("session lifecycle", () => {
		test("session_start inserts a sessions row", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			const db = new Database(dbPath, { readonly: true });
			const rows = db.query<{ agent_name: string; session_label: string; model: string; ended_at: string | null }, []>(
				`SELECT agent_name, session_label, model, ended_at FROM sessions`,
			).all();
			db.close();

			expect(rows).toHaveLength(1);
			expect(rows[0].agent_name).toBe("test-agent");
			expect(rows[0].session_label).toBe("test-session");
			expect(rows[0].model).toBe("Claude 3 Opus");
			expect(rows[0].ended_at).toBeNull();
		});

		test("session_shutdown sets ended_at", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("session_shutdown");

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ ended_at: string | null }, []>(
				`SELECT ended_at FROM sessions LIMIT 1`,
			).get();
			db.close();

			expect(row?.ended_at).not.toBeNull();
		});
	});

	// ── Phase 2: Task lifecycle ───────────────────────────────────────────────

	describe("task lifecycle", () => {
		test("agent_start inserts a tasks row", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});

			const db = new Database(dbPath, { readonly: true });
			const rows = db.query<{ id: string; ended_at: string | null }, []>(
				`SELECT id, ended_at FROM tasks`,
			).all();
			db.close();

			expect(rows).toHaveLength(1);
			expect(rows[0].ended_at).toBeNull();
		});

		test("agent_end sets ended_at on the task", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("agent_end", {});

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ ended_at: string | null }, []>(
				`SELECT ended_at FROM tasks LIMIT 1`,
			).get();
			db.close();

			expect(row?.ended_at).not.toBeNull();
		});

		test("pending annotation is applied when agent_start fires", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			// Annotation arrives before agent_start (pi2pi fires this on incoming message)
			h.events.emit("telemetry:annotate", {
				pi2pi_message_id: "msg-001",
				from_agent: "overlord",
				overlord_request: "build the feature",
				role: "engineer",
				team: "engineering",
			});

			await h.fire("agent_start", {});

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{
				pi2pi_message_id: string;
				from_agent: string;
				overlord_request: string;
				role: string;
				team: string;
			}, []>(`SELECT pi2pi_message_id, from_agent, overlord_request, role, team FROM tasks LIMIT 1`).get();
			db.close();

			expect(row?.pi2pi_message_id).toBe("msg-001");
			expect(row?.from_agent).toBe("overlord");
			expect(row?.overlord_request).toBe("build the feature");
			expect(row?.role).toBe("engineer");
			expect(row?.team).toBe("engineering");
		});

		test("annotation emitted during active task updates the row immediately", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});

			h.events.emit("telemetry:annotate", {
				role: "backend-dev",
				team: "core",
			});

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ role: string; team: string }, []>(
				`SELECT role, team FROM tasks LIMIT 1`,
			).get();
			db.close();

			expect(row?.role).toBe("backend-dev");
			expect(row?.team).toBe("core");
		});
	});

	// ── Phase 3: Turn capture ─────────────────────────────────────────────────

	describe("turn capture", () => {
		test("turn_start inserts a turns row", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });

			const db = new Database(dbPath, { readonly: true });
			const rows = db.query<{ turn_index: number; tokens_total: number | null }, []>(
				`SELECT turn_index, tokens_total FROM turns`,
			).all();
			db.close();

			expect(rows).toHaveLength(1);
			expect(rows[0].turn_index).toBe(0);
			expect(rows[0].tokens_total).toBeNull();
		});

		test("message_end populates token fields on the turn", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("message_end", { message: makeAssistantMessage({ usage: { input: 200, output: 80, totalTokens: 280, cost: { input: 0.002, output: 0.004, total: 0.006 } } }) });

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{
				tokens_input: number;
				tokens_output: number;
				tokens_total: number;
				cost_total: number;
				stop_reason: string;
			}, []>(`SELECT tokens_input, tokens_output, tokens_total, cost_total, stop_reason FROM turns LIMIT 1`).get();
			db.close();

			expect(row?.tokens_input).toBe(200);
			expect(row?.tokens_output).toBe(80);
			expect(row?.tokens_total).toBe(280);
			expect(row?.cost_total).toBeCloseTo(0.006);
			expect(row?.stop_reason).toBe("stop");
		});

		test("message_end ignores non-assistant messages", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("message_end", { message: { role: "user", content: "hello" } });

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ tokens_total: number | null }, []>(
				`SELECT tokens_total FROM turns LIMIT 1`,
			).get();
			db.close();

			// tokens_total should still be null — user message was ignored
			expect(row?.tokens_total).toBeNull();
		});
	});

	// ── Phase 3: Chain of thought ─────────────────────────────────────────────

	describe("chain of thought capture", () => {
		test("thinking blocks are extracted and stored", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("message_end", {
				message: makeAssistantMessage({
					thinking: ["First, I need to understand the problem.", "Then I will write the code."],
					text: ["Here is my solution."],
				}),
			});

			const db = new Database(dbPath, { readonly: true });
			const blocks = db.query<{ sequence: number; content: string }, []>(
				`SELECT sequence, content FROM thinking_blocks ORDER BY sequence`,
			).all();
			const texts = db.query<{ sequence: number; content: string }, []>(
				`SELECT sequence, content FROM assistant_text ORDER BY sequence`,
			).all();
			db.close();

			expect(blocks).toHaveLength(2);
			expect(blocks[0].content).toBe("First, I need to understand the problem.");
			expect(blocks[1].content).toBe("Then I will write the code.");
			expect(texts).toHaveLength(1);
			expect(texts[0].content).toBe("Here is my solution.");
		});

		test("thinking blocks are linked to the correct turn", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});

			// Turn 0
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("message_end", { message: makeAssistantMessage({ thinking: ["Turn 0 thought"] }) });

			// Turn 1
			await h.fire("turn_start", { turnIndex: 1 });
			await h.fire("message_end", { message: makeAssistantMessage({ thinking: ["Turn 1 thought"] }) });

			const db = new Database(dbPath, { readonly: true });
			const rows = db.query<{ turn_index: number; content: string }, []>(`
				SELECT tu.turn_index, tb.content
				FROM thinking_blocks tb
				JOIN turns tu ON tb.turn_id = tu.id
				ORDER BY tu.turn_index
			`).all();
			db.close();

			expect(rows).toHaveLength(2);
			expect(rows[0].turn_index).toBe(0);
			expect(rows[0].content).toBe("Turn 0 thought");
			expect(rows[1].turn_index).toBe(1);
			expect(rows[1].content).toBe("Turn 1 thought");
		});
	});

	// ── Phase 4: Tool call capture ────────────────────────────────────────────

	describe("tool call capture", () => {
		test("tool_execution_end inserts a tool_calls row", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("tool_execution_end", {
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "ls -la" },
				isError: false,
			});

			const db = new Database(dbPath, { readonly: true });
			const rows = db.query<{ tool_name: string; is_error: number; args_json: string }, []>(
				`SELECT tool_name, is_error, args_json FROM tool_calls`,
			).all();
			db.close();

			expect(rows).toHaveLength(1);
			expect(rows[0].tool_name).toBe("bash");
			expect(rows[0].is_error).toBe(0);
			expect(JSON.parse(rows[0].args_json)).toEqual({ command: "ls -la" });
		});

		test("tool_execution_end records error flag", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("tool_execution_end", {
				toolCallId: "tc-err",
				toolName: "bash",
				args: { command: "bad command" },
				isError: true,
			});

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ is_error: number }, []>(
				`SELECT is_error FROM tool_calls LIMIT 1`,
			).get();
			db.close();

			expect(row?.is_error).toBe(1);
		});

		test("large args are truncated", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });
			const bigContent = "x".repeat(10_000);
			await h.fire("tool_execution_end", {
				toolCallId: "tc-big",
				toolName: "write",
				args: { path: "file.txt", content: bigContent },
				isError: false,
			});

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ args_json: string }, []>(
				`SELECT args_json FROM tool_calls LIMIT 1`,
			).get();
			db.close();

			expect(row?.args_json.length).toBeLessThanOrEqual(2060); // 2048 + "…"
		});
	});

	// ── Phase 5: telemetry_query tool ─────────────────────────────────────────

	describe("telemetry_query tool", () => {
		test("SELECT returns rows as JSON", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			const result = await h.callTool("telemetry_query", { sql: "SELECT * FROM sessions" }) as {
				content: Array<{ type: string; text: string }>;
				details: { rows: unknown[]; truncated: boolean };
			};

			expect(result.details.rows).toHaveLength(1);
			expect(result.content[0].text).toContain("1 row returned");
		});

		test("non-SELECT statement throws", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			await expect(
				h.callTool("telemetry_query", { sql: "DROP TABLE sessions" }),
			).rejects.toThrow("only allows SELECT");
		});

		test("WITH ... SELECT is allowed", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			const result = await h.callTool("telemetry_query", {
				sql: "WITH s AS (SELECT id FROM sessions) SELECT * FROM s",
			}) as { details: { rows: unknown[] } };

			expect(result.details.rows).toHaveLength(1);
		});

		test("invalid SQL throws a descriptive error", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			await expect(
				h.callTool("telemetry_query", { sql: "SELECT * FROM nonexistent_table" }),
			).rejects.toThrow("SQL error");
		});
	});

	// ── Phase 6: pi2pi decoration ─────────────────────────────────────────────

	describe("pi2pi decoration via pi.events", () => {
		test("annotation emitted before agent_start is buffered and applied", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});

			h.events.emit("telemetry:annotate", {
				pi2pi_message_id: "abc123",
				from_agent: "blackbird",
				overlord_request: "implement login page",
				role: "frontend",
				team: "ui-team",
			});

			await h.fire("agent_start", {});

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ overlord_request: string; from_agent: string }, []>(
				`SELECT overlord_request, from_agent FROM tasks LIMIT 1`,
			).get();
			db.close();

			expect(row?.overlord_request).toBe("implement login page");
			expect(row?.from_agent).toBe("blackbird");
		});

		test("unknown annotation keys are ignored safely", async () => {
			const h = await loadExtension(dbPath);
			await h.fire("session_start", {});
			await h.fire("agent_start", {});

			// Should not throw
			expect(() => {
				h.events.emit("telemetry:annotate", {
					unknown_key: "should be ignored",
					role: "tester",
				});
			}).not.toThrow();

			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ role: string }, []>(
				`SELECT role FROM tasks LIMIT 1`,
			).get();
			db.close();

			expect(row?.role).toBe("tester");
		});
	});

	// ── Integration: standalone (no pi2pi) ────────────────────────────────────

	describe("standalone operation", () => {
		test("full lifecycle without any pi2pi decoration", async () => {
			const h = await loadExtension(dbPath);

			await h.fire("session_start", {});
			await h.fire("agent_start", {});
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("message_end", {
				message: makeAssistantMessage({
					thinking: ["Let me think..."],
					text: ["Done."],
					usage: { input: 50, output: 20, totalTokens: 70, cost: { input: 0.001, output: 0.001, total: 0.002 } },
				}),
			});
			await h.fire("tool_execution_end", { toolCallId: "t1", toolName: "read", args: { path: "foo.ts" }, isError: false });
			await h.fire("turn_start", { turnIndex: 1 });
			await h.fire("message_end", {
				message: makeAssistantMessage({
					text: ["All done."],
					usage: { input: 70, output: 30, totalTokens: 100, cost: { input: 0.001, output: 0.002, total: 0.003 } },
				}),
			});
			await h.fire("agent_end", {});
			await h.fire("session_shutdown");

			const db = new Database(dbPath, { readonly: true });
			const sessionCount = (db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM sessions`).get())!.c;
			const taskCount = (db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM tasks`).get())!.c;
			const turnCount = (db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM turns`).get())!.c;
			const thinkCount = (db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM thinking_blocks`).get())!.c;
			const textCount = (db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM assistant_text`).get())!.c;
			const toolCount = (db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM tool_calls`).get())!.c;
			db.close();

			expect(sessionCount).toBe(1);
			expect(taskCount).toBe(1);
			expect(turnCount).toBe(2);
			expect(thinkCount).toBe(1);
			expect(textCount).toBe(2);
			expect(toolCount).toBe(1);
		});
	});
});
