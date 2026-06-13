/**
 * Pi Telemetry Extension
 *
 * Standalone extension that records chain of thought, token usage, and tool-call
 * traces into a SQLite database. Works with or without pi2pi.
 *
 * Pi2pi (and other extensions) can decorate tasks with additional metadata by
 * emitting on the shared event bus:
 *
 *   pi.events.emit("telemetry:annotate", {
 *     pi2pi_message_id: string,
 *     from_agent:       string,
 *     overlord_request: string,
 *     role:             string,
 *     team:             string,
 *   });
 *
 * Flags:
 *   --telemetry-db            Path to SQLite DB (default: ~/.pi/agent/telemetry/telemetry.db)
 *   --telemetry-agent-name    Agent name written to sessions table (default: os.hostname())
 *   --telemetry-session-label Human-readable label for this session (e.g. "sprint-42")
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  agent_name     TEXT,
  session_label  TEXT,
  model          TEXT,
  provider       TEXT,
  cwd            TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  pi2pi_message_id  TEXT,
  from_agent        TEXT,
  overlord_request  TEXT,
  role              TEXT,
  team              TEXT,
  user_prompt       TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  turn_index       INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  model            TEXT,
  provider         TEXT,
  tokens_input     INTEGER,
  tokens_output    INTEGER,
  tokens_cache_rd  INTEGER,
  tokens_cache_wr  INTEGER,
  tokens_total     INTEGER,
  cost_input       REAL,
  cost_output      REAL,
  cost_total       REAL,
  stop_reason      TEXT
);

CREATE TABLE IF NOT EXISTS thinking_blocks (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL REFERENCES turns(id),
  session_id TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  content    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_text (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL REFERENCES turns(id),
  session_id TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  content    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT REFERENCES turns(id),
  session_id TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id),
  tool_name  TEXT NOT NULL,
  called_at  TEXT NOT NULL,
  args_json  TEXT,
  is_error   INTEGER NOT NULL DEFAULT 0
);
`;

const MAX_ARGS_BYTES = 2048;
const MAX_QUERY_ROWS = 200;
const MAX_QUERY_BYTES = 20 * 1024;

export default function (pi: ExtensionAPI) {
	// ── Flags ─────────────────────────────────────────────────────────────────
	pi.registerFlag("telemetry-db", {
		description: "Path to the telemetry SQLite database (default: ~/.pi/agent/telemetry/telemetry.db)",
		type: "string",
	});
	pi.registerFlag("telemetry-agent-name", {
		description: "Agent name recorded in the sessions table (default: os.hostname())",
		type: "string",
	});
	pi.registerFlag("telemetry-session-label", {
		description: "Human-readable label for this session (e.g. 'sprint-42')",
		type: "string",
	});

	// ── Runtime state ─────────────────────────────────────────────────────────
	let db: DatabaseSync | null = null;
	let currentSessionId: string | null = null;
	let currentTaskId: string | null = null;
	let currentTurnId: string | null = null;
	let currentModel: string | null = null;
	let currentProvider: string | null = null;

	// Decoration context emitted by pi2pi (or others) before or during a task.
	// Buffered here if it arrives before agent_start fires.
	let pendingAnnotation: Record<string, string> | null = null;
	let pendingUserPrompt: string | null = null;

	// ── Helpers ───────────────────────────────────────────────────────────────
	function now(): string {
		return new Date().toISOString();
	}

	function newId(): string {
		return randomUUID();
	}

	function dbPath(): string {
		const flag = (pi.getFlag("telemetry-db") as string | undefined)?.trim();
		if (flag) return flag;
		const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
		return join(home, ".pi", "agent", "telemetry", "telemetry.db");
	}

	function openDb(): DatabaseSync {
		const path = dbPath();
		mkdirSync(dirname(path), { recursive: true });
		const database = new DatabaseSync(path);
		database.exec("PRAGMA journal_mode=WAL;");
		database.exec(SCHEMA);
		return database;
	}

	function applyAnnotation(taskId: string, annotation: Record<string, string>): void {
		if (!db) return;
		const fields: string[] = [];
		const values: unknown[] = [];
		for (const [k, v] of Object.entries(annotation)) {
			if (["pi2pi_message_id", "from_agent", "overlord_request", "role", "team"].includes(k)) {
				fields.push(`${k} = ?`);
				values.push(v);
			}
		}
		if (fields.length === 0) return;
		values.push(taskId);
		db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
	}

	// ── Inter-extension event bus ─────────────────────────────────────────────
	pi.events.on("telemetry:annotate", (data) => {
		const annotation = data as Record<string, string>;
		if (currentTaskId) {
			applyAnnotation(currentTaskId, annotation);
		} else {
			// Buffer — will be applied when the next task starts
			pendingAnnotation = { ...(pendingAnnotation ?? {}), ...annotation };
		}
	});

	// ── Session lifecycle ─────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		db = openDb();

		const agentName =
			(pi.getFlag("telemetry-agent-name") as string | undefined)?.trim() || hostname();
		const sessionLabel =
			(pi.getFlag("telemetry-session-label") as string | undefined)?.trim() || null;
		const model = ctx.model ? (ctx.model.name || ctx.model.id) : null;
		const provider = ctx.model?.provider ?? null;
		currentModel = model;
		currentProvider = provider;

		const sessionId = newId();
		currentSessionId = sessionId;

		db.prepare(
			`INSERT INTO sessions (id, agent_name, session_label, model, provider, cwd, started_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(sessionId, agentName, sessionLabel, model, provider, ctx.cwd ?? null, now());
	});

	pi.on("session_shutdown", async () => {
		if (db && currentSessionId) {
			db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(now(), currentSessionId);
		}
		db?.close();
		db = null;
		currentSessionId = null;
		currentTaskId = null;
		currentTurnId = null;
		pendingAnnotation = null;
	});

	// ── Model changes ─────────────────────────────────────────────────────────
	pi.on("model_select", async (event) => {
		currentModel = event.model.name || event.model.id;
		currentProvider = event.model.provider ?? null;
		if (db && currentSessionId) {
			db.prepare(
				`UPDATE sessions SET model = ?, provider = ? WHERE id = ?`
			).run(currentModel, currentProvider, currentSessionId);
		}
	});

	// ── Capture user prompt ─────────────────────────────────────────────────
	pi.on("before_agent_start", async (event) => {
		pendingUserPrompt = (event as { prompt?: string }).prompt ?? null;
	});

	// ── Task lifecycle (agent_start / agent_end) ──────────────────────────────
	pi.on("agent_start", async () => {
		if (!db || !currentSessionId) return;

		const taskId = newId();
		currentTaskId = taskId;

		db.prepare(
			`INSERT INTO tasks (id, session_id, started_at, user_prompt) VALUES (?, ?, ?, ?)`
		).run(taskId, currentSessionId, now(), pendingUserPrompt ?? null);
		pendingUserPrompt = null;

		// Apply any decoration that arrived before this turn started
		if (pendingAnnotation) {
			applyAnnotation(taskId, pendingAnnotation);
			pendingAnnotation = null;
		}
	});

	pi.on("agent_end", async () => {
		if (!db || !currentTaskId) return;
		db.prepare(`UPDATE tasks SET ended_at = ? WHERE id = ?`).run(now(), currentTaskId);
		currentTaskId = null;
		currentTurnId = null;
	});

	// ── Turn lifecycle (turn_start / turn_end) ────────────────────────────────
	pi.on("turn_start", async (event) => {
		if (!db || !currentSessionId || !currentTaskId) return;

		const turnId = newId();
		currentTurnId = turnId;

		db.prepare(
			`INSERT INTO turns (id, session_id, task_id, turn_index, started_at, model, provider)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(turnId, currentSessionId, currentTaskId, event.turnIndex, now(), currentModel, currentProvider);
	});

	// ── Assistant message capture (tokens + CoT + text) ──────────────────────
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		if (!db || !currentTurnId || !currentSessionId) return;

		const msg = event.message as {
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				totalTokens?: number;
				cost?: { input?: number; output?: number; total?: number };
			};
			content?: Array<{ type: string; thinking?: string; text?: string }>;
			stopReason?: string;
		};

		// Update turn with token usage and stop reason
		const usage = msg.usage ?? {};
		const cost = usage.cost ?? {};
		db.prepare(
			`UPDATE turns SET
				ended_at        = ?,
				tokens_input    = ?,
				tokens_output   = ?,
				tokens_cache_rd = ?,
				tokens_cache_wr = ?,
				tokens_total    = ?,
				cost_input      = ?,
				cost_output     = ?,
				cost_total      = ?,
				stop_reason     = ?
			 WHERE id = ?`
		).run(
			now(),
			usage.input ?? null,
			usage.output ?? null,
			usage.cacheRead ?? null,
			usage.cacheWrite ?? null,
			usage.totalTokens ?? null,
			cost.input ?? null,
			cost.output ?? null,
			cost.total ?? null,
			msg.stopReason ?? null,
			currentTurnId,
		);

		// Extract content blocks
		const content = msg.content ?? [];
		let thinkSeq = 0;
		let textSeq = 0;

		for (const block of content) {
			if (block.type === "thinking" && block.thinking) {
				db.prepare(
					`INSERT INTO thinking_blocks (id, turn_id, session_id, sequence, content)
					 VALUES (?, ?, ?, ?, ?)`
				).run(newId(), currentTurnId, currentSessionId, thinkSeq++, block.thinking);
			} else if (block.type === "text" && block.text?.trim()) {
				db.prepare(
					`INSERT INTO assistant_text (id, turn_id, session_id, sequence, content)
					 VALUES (?, ?, ?, ?, ?)`
				).run(newId(), currentTurnId, currentSessionId, textSeq++, block.text);
			}
		}
	});

	// ── Tool call capture ─────────────────────────────────────────────────────
	pi.on("tool_execution_end", async (event) => {
		if (!db || !currentSessionId) return;

		// Truncate args to avoid bloating the DB
		let argsJson: string | null = null;
		try {
			const raw = JSON.stringify((event as { args?: unknown }).args ?? null);
			argsJson = raw.length > MAX_ARGS_BYTES ? raw.slice(0, MAX_ARGS_BYTES) + "…" : raw;
		} catch {
			argsJson = null;
		}

		db.prepare(
			`INSERT INTO tool_calls (id, turn_id, session_id, task_id, tool_name, called_at, args_json, is_error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			newId(),
			currentTurnId ?? null,
			currentSessionId,
			currentTaskId ?? null,
			event.toolName,
			now(),
			argsJson,
			event.isError ? 1 : 0,
		);
	});

	// ── telemetry_query tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "telemetry_query",
		label: "Telemetry Query",
		description: `Run a read-only SQL SELECT against the telemetry database and return results as JSON.

Tables:
  sessions(id, agent_name, session_label, model, provider, cwd, started_at, ended_at)
  tasks(id, session_id, started_at, ended_at, pi2pi_message_id, from_agent, overlord_request, role, team, user_prompt)
  turns(id, session_id, task_id, turn_index, started_at, ended_at, model, provider,
        tokens_input, tokens_output, tokens_cache_rd, tokens_cache_wr, tokens_total,
        cost_input, cost_output, cost_total, stop_reason)
  thinking_blocks(id, turn_id, session_id, sequence, content)
  assistant_text(id, turn_id, session_id, sequence, content)
  tool_calls(id, turn_id, session_id, task_id, tool_name, called_at, args_json, is_error)

Useful queries:
  -- Total tokens per overlord request:
  SELECT t.overlord_request, SUM(tr.tokens_total) AS tokens, SUM(tr.cost_total) AS cost
  FROM tasks t JOIN turns tr ON tr.task_id = t.id GROUP BY t.id ORDER BY t.started_at DESC LIMIT 10;

  -- Chain of thought for a task:
  SELECT tu.turn_index, tb.sequence, tb.content
  FROM thinking_blocks tb JOIN turns tu ON tb.turn_id = tu.id
  WHERE tu.task_id = '<id>' ORDER BY tu.turn_index, tb.sequence;

  -- Token cost by role:
  SELECT t.role, t.team, SUM(tr.tokens_total) AS tokens, SUM(tr.cost_total) AS cost
  FROM tasks t JOIN turns tr ON tr.task_id = t.id GROUP BY t.role, t.team;`,
		promptSnippet: "Query the telemetry SQLite database for token usage, chain of thought, and tool traces",
		parameters: {
			type: "object" as const,
			properties: {
				sql: {
					type: "string",
					description: "A SELECT statement to run against the telemetry database",
				},
			},
			required: ["sql"],
		},
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { sql } = params as { sql: string };

			// Safety: only allow SELECT
			const trimmed = sql.trim().toUpperCase();
			if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
				throw new Error("telemetry_query only allows SELECT (or WITH ... SELECT) statements");
			}

			if (!db) {
				throw new Error("Telemetry database is not open");
			}

			let rows: unknown[];
			try {
				rows = db.prepare(sql).all();
			} catch (err) {
				throw new Error(`SQL error: ${err instanceof Error ? err.message : String(err)}`);
			}

			const truncated = rows.length > MAX_QUERY_ROWS;
			if (truncated) rows = rows.slice(0, MAX_QUERY_ROWS);

			let json = JSON.stringify(rows, null, 2);
			if (json.length > MAX_QUERY_BYTES) {
				json = json.slice(0, MAX_QUERY_BYTES) + "\n… (truncated)";
			}

			const summary = truncated
				? `${MAX_QUERY_ROWS} rows returned (result truncated at ${MAX_QUERY_ROWS} rows)`
				: `${rows.length} row${rows.length !== 1 ? "s" : ""} returned`;

			return {
				content: [{ type: "text" as const, text: `${summary}\n\n${json}` }],
				details: { rows, truncated },
			};
		},
	});

	// ── /telemetry command ────────────────────────────────────────────────────
	pi.registerCommand("telemetry", {
		description: "Show telemetry data. Usage: /telemetry [task <id> | stats | sessions]",
		handler: async (args, ctx) => {
			if (!db) {
				ctx.ui.notify("Telemetry database is not open", "error");
				return;
			}

			const sub = args.trim();

			if (!sub || sub === "tasks") {
				// Last 10 tasks with token totals
				type TaskRow = {
					id: string;
					agent_name: string | null;
					overlord_request: string | null;
					role: string | null;
					team: string | null;
					started_at: string;
					ended_at: string | null;
					turns: number;
					tokens: number | null;
					cost: number | null;
				};
				const rows = db.prepare(`
					SELECT
						t.id,
						s.agent_name,
						t.overlord_request,
						t.role,
						t.team,
						t.started_at,
						t.ended_at,
						COUNT(DISTINCT tr.id)    AS turns,
						SUM(tr.tokens_total)     AS tokens,
						SUM(tr.cost_total)       AS cost
					FROM tasks t
					JOIN sessions s ON t.session_id = s.id
					LEFT JOIN turns tr ON tr.task_id = t.id
					GROUP BY t.id
					ORDER BY t.started_at DESC
					LIMIT 10
				`).all() as TaskRow[];

				if (rows.length === 0) {
					ctx.ui.notify("No tasks recorded yet", "info");
					return;
				}

				const lines = rows.map(r => {
					const req = r.overlord_request
						? r.overlord_request.slice(0, 60) + (r.overlord_request.length > 60 ? "…" : "")
						: "(no overlord request)";
					const tokens = r.tokens != null ? `${r.tokens.toLocaleString()} tok` : "—";
					const cost = r.cost != null ? `$${r.cost.toFixed(4)}` : "—";
					const who = [r.agent_name, r.role, r.team].filter(Boolean).join("/");
					return `[${r.id.slice(0, 8)}] ${who} | ${r.turns} turns | ${tokens} ${cost}\n  ${req}`;
				});

				pi.sendMessage({
					customType: "telemetry-tasks",
					content: `── Recent tasks ──\n${lines.join("\n")}`,
					display: true,
					details: { rows },
				});
				return;
			}

			if (sub.startsWith("task ")) {
				const taskId = sub.slice(5).trim();
				const partial = taskId.length < 36;

				type TaskDetail = {
					id: string;
					agent_name: string | null;
					overlord_request: string | null;
					role: string | null;
					team: string | null;
					from_agent: string | null;
					user_prompt: string | null;
					started_at: string;
					ended_at: string | null;
				};
				const task = db.prepare(`
					SELECT t.*, s.agent_name
					FROM tasks t JOIN sessions s ON t.session_id = s.id
					WHERE t.id ${partial ? "LIKE ?" : "= ?"}
					LIMIT 1
				`).get(partial ? `${taskId}%` : taskId) as TaskDetail | null;

				if (!task) {
					ctx.ui.notify(`No task found for id: ${taskId}`, "warning");
					return;
				}

				type TurnRow = {
					id: string;
					turn_index: number;
					tokens_total: number | null;
					cost_total: number | null;
					stop_reason: string | null;
					started_at: string;
				};
				const turns = db.prepare(
					`SELECT id, turn_index, tokens_total, cost_total, stop_reason, started_at
					 FROM turns WHERE task_id = ? ORDER BY turn_index`,
				).all(task.id) as TurnRow[];

				const lines: string[] = [
					`── Task ${task.id.slice(0, 8)} ──`,
					`Agent:    ${task.agent_name ?? "—"}  Role: ${task.role ?? "—"}  Team: ${task.team ?? "—"}`,
					`From:     ${task.from_agent ?? "—"}`,
					`Started:  ${task.started_at}`,
					`Ended:    ${task.ended_at ?? "in progress"}`,
					`Prompt:   ${task.user_prompt ?? "(none)"}`,
					`Request:  ${task.overlord_request ?? "(none)"}`,
					``,
				];

				type ContentRow = { sequence: number; content: string };
				type ToolRow = { tool_name: string; called_at: string; is_error: number };

				for (const turn of turns) {
					lines.push(
						`  Turn ${turn.turn_index}  ${turn.tokens_total?.toLocaleString() ?? "—"} tok  ` +
						`$${(turn.cost_total ?? 0).toFixed(4)}  stop=${turn.stop_reason ?? "—"}`,
					);

					const thinking = db.prepare(
						`SELECT sequence, content FROM thinking_blocks WHERE turn_id = ? ORDER BY sequence`,
					).all(turn.id) as ContentRow[];

					for (const tb of thinking) {
						const preview = tb.content.slice(0, 200) + (tb.content.length > 200 ? "…" : "");
						lines.push(`    [thinking ${tb.sequence}] ${preview}`);
					}

					const text = db.prepare(
						`SELECT sequence, content FROM assistant_text WHERE turn_id = ? ORDER BY sequence`,
					).all(turn.id) as ContentRow[];

					for (const at of text) {
						const preview = at.content.slice(0, 200) + (at.content.length > 200 ? "…" : "");
						lines.push(`    [text ${at.sequence}] ${preview}`);
					}

					const tools = db.prepare(
						`SELECT tool_name, called_at, is_error FROM tool_calls WHERE turn_id = ? ORDER BY called_at`,
					).all(turn.id) as ToolRow[];

					for (const tc of tools) {
						lines.push(`    [tool] ${tc.tool_name}${tc.is_error ? " ✗" : ""}`);
					}
				}

				pi.sendMessage({
					customType: "telemetry-task-detail",
					content: lines.join("\n"),
					display: true,
					details: { task, turns },
				});
				return;
			}

			if (sub === "stats") {
				type StatsRow = {
					role: string | null;
					team: string | null;
					tasks: number;
					total_turns: number;
					total_tokens: number | null;
					total_cost: number | null;
				};
				const rows = db.prepare(`
					SELECT
						t.role,
						t.team,
						COUNT(DISTINCT t.id)  AS tasks,
						COUNT(tr.id)          AS total_turns,
						SUM(tr.tokens_total)  AS total_tokens,
						SUM(tr.cost_total)    AS total_cost
					FROM tasks t
					LEFT JOIN turns tr ON tr.task_id = t.id
					GROUP BY t.role, t.team
					ORDER BY total_tokens DESC
				`).all() as StatsRow[];

				if (rows.length === 0) {
					ctx.ui.notify("No stats recorded yet", "info");
					return;
				}

				const lines = rows.map(r => {
					const who = `${r.role ?? "—"} / ${r.team ?? "—"}`;
					const tokens = r.total_tokens != null ? r.total_tokens.toLocaleString() : "—";
					const cost = r.total_cost != null ? `$${r.total_cost.toFixed(4)}` : "—";
					return `${who.padEnd(30)} ${r.tasks} tasks  ${r.total_turns} turns  ${tokens} tok  ${cost}`;
				});

				pi.sendMessage({
					customType: "telemetry-stats",
					content: `── Token stats by role/team ──\n${lines.join("\n")}`,
					display: true,
					details: { rows },
				});
				return;
			}

			if (sub === "sessions") {
				type SessionRow = {
					id: string;
					agent_name: string | null;
					session_label: string | null;
					model: string | null;
					started_at: string;
					ended_at: string | null;
					tasks: number;
					tokens: number | null;
				};
				const rows = db.prepare(`
					SELECT
						s.id,
						s.agent_name,
						s.session_label,
						s.model,
						s.started_at,
						s.ended_at,
						COUNT(DISTINCT t.id)   AS tasks,
						SUM(tr.tokens_total)   AS tokens
					FROM sessions s
					LEFT JOIN tasks t ON t.session_id = s.id
					LEFT JOIN turns tr ON tr.session_id = s.id
					GROUP BY s.id
					ORDER BY s.started_at DESC
					LIMIT 20
				`).all() as SessionRow[];

				if (rows.length === 0) {
					ctx.ui.notify("No sessions recorded yet", "info");
					return;
				}

				const lines = rows.map(r => {
					const label = r.session_label ? ` [${r.session_label}]` : "";
					const tokens = r.tokens != null ? ` ${r.tokens.toLocaleString()} tok` : "";
					return `[${r.id.slice(0, 8)}] ${r.agent_name ?? "—"}${label}  ${r.model ?? "—"}  ${r.started_at}${tokens}`;
				});

				pi.sendMessage({
					customType: "telemetry-sessions",
					content: `── Recent sessions ──\n${lines.join("\n")}`,
					display: true,
					details: { rows },
				});
				return;
			}

			ctx.ui.notify("Usage: /telemetry [task <id> | stats | sessions]", "warning");
		},
	});
}
