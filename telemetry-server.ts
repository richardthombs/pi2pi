import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── DB ────────────────────────────────────────────────────────────────────────

function resolveDbPath(override?: string): string {
	if (override) return override;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
	return join(home, ".pi", "agent", "telemetry", "telemetry.db");
}

function openDb(dbPath?: string): Database {
	const path = resolveDbPath(dbPath);
	if (!existsSync(path)) {
		throw new Error(
			`Telemetry database not found at: ${path}\n` +
			`Run an agent with the telemetry extension first, or specify a different path with --db <path>`,
		);
	}
	return new Database(path, { readonly: true });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(message: string, status = 500): Response {
	return jsonResponse({ error: message }, status);
}

// ── API routes ────────────────────────────────────────────────────────────────

function handleApi(db: Database, url: URL): Response {
	try {
		return routeApi(db, url);
	} catch (e) {
		return errorResponse(e instanceof Error ? e.message : String(e));
	}
}

function routeApi(db: Database, url: URL): Response {
	const path = url.pathname;

	// GET /api/sessions
	if (path === "/api/sessions") {
		const rows = db.prepare(`
			SELECT
				s.id, s.agent_name, s.session_label, s.model, s.provider, s.cwd,
				s.started_at, s.ended_at,
				COUNT(DISTINCT t.id) AS task_count,
				SUM(tr.tokens_total) AS total_tokens,
				SUM(tr.cost_total)   AS total_cost,
				MAX(tc.is_error)     AS has_errors
			FROM sessions s
			LEFT JOIN tasks t   ON t.session_id = s.id
			LEFT JOIN turns tr  ON tr.session_id = s.id
			LEFT JOIN tool_calls tc ON tc.session_id = s.id
			GROUP BY s.id
			ORDER BY s.started_at DESC
		`).all();
		return jsonResponse(rows);
	}

	// GET /api/sessions/:id/tasks
	const sessTasksM = path.match(/^\/api\/sessions\/([^/]+)\/tasks$/);
	if (sessTasksM) {
		const sessionId = sessTasksM[1];
		const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
		if (!session) return errorResponse("Session not found", 404);
		const tasks = db.prepare(`
			SELECT
				t.id, t.session_id, t.started_at, t.ended_at,
				t.pi2pi_message_id, t.from_agent, t.overlord_request,
				t.role, t.team, t.user_prompt,
				COUNT(DISTINCT tr.id) AS turn_count,
				SUM(tr.tokens_total)  AS total_tokens,
				SUM(tr.cost_total)    AS total_cost,
				MAX(tc.is_error)      AS has_errors
			FROM tasks t
			LEFT JOIN turns tr  ON tr.task_id = t.id
			LEFT JOIN tool_calls tc ON tc.task_id = t.id
			WHERE t.session_id = ?
			GROUP BY t.id
			ORDER BY t.started_at ASC
		`).all(sessionId);
		return jsonResponse({ session, tasks });
	}

	// GET /api/tasks/:id
	const taskM = path.match(/^\/api\/tasks\/([^/]+)$/);
	if (taskM) {
		const taskId = taskM[1];
		const task = db.prepare(`
			SELECT t.*, s.agent_name, s.model, s.session_label
			FROM tasks t JOIN sessions s ON t.session_id = s.id
			WHERE t.id = ?
		`).get(taskId);
		if (!task) return errorResponse("Task not found", 404);
		const turns = db.prepare(`
			SELECT
				tr.id, tr.turn_index, tr.started_at, tr.ended_at,
				tr.model, tr.tokens_input, tr.tokens_output, tr.tokens_total,
				tr.cost_total, tr.stop_reason,
				COUNT(tc.id)     AS tool_call_count,
				MAX(tc.is_error) AS has_errors
			FROM turns tr
			LEFT JOIN tool_calls tc ON tc.turn_id = tr.id
			WHERE tr.task_id = ?
			GROUP BY tr.id
			ORDER BY tr.turn_index ASC
		`).all(taskId);
		return jsonResponse({ task, turns });
	}

	// GET /api/turns/:id
	const turnM = path.match(/^\/api\/turns\/([^/]+)$/);
	if (turnM) {
		const turnId = turnM[1];
		const turn = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(turnId);
		if (!turn) return errorResponse("Turn not found", 404);
		const thinkingBlocks = db.prepare(
			`SELECT sequence, content FROM thinking_blocks WHERE turn_id = ? ORDER BY sequence`,
		).all(turnId);
		const assistantText = db.prepare(
			`SELECT sequence, content FROM assistant_text WHERE turn_id = ? ORDER BY sequence`,
		).all(turnId);
		const toolCalls = db.prepare(
			`SELECT id, tool_name, called_at, args_json, result_json, is_error, tool_call_id
			 FROM tool_calls WHERE turn_id = ? ORDER BY called_at`,
		).all(turnId);
		const contextDelta = db.prepare(
			`SELECT message_count, total_message_count, messages_json
			 FROM turn_contexts WHERE turn_id = ? LIMIT 1`,
		).get(turnId) ?? null;
		return jsonResponse({
			turn,
			thinking_blocks: thinkingBlocks,
			assistant_text: assistantText,
			tool_calls: toolCalls,
			context_delta: contextDelta,
		});
	}

	return errorResponse("Not found", 404);
}

// ── SPA shell ─────────────────────────────────────────────────────────────────

function serveApp(): Response {
	return new Response(getHtml(), {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startTelemetryServer(options: { port: number; dbPath?: string }): Promise<void> {
	const db = openDb(options.dbPath);
	console.log(`Telemetry UI running at http://localhost:${options.port}`);
	Bun.serve({
		port: options.port,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/api/")) return handleApi(db, url);
			return serveApp();
		},
	});
}

// ── Frontend ──────────────────────────────────────────────────────────────────

function getHtml(): string {
	const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;background:#0f1117;color:#e2e8f0}
#app{max-width:1200px;margin:0 auto;padding:16px}
.top-nav{background:#1a1d2e;padding:12px 16px;border-bottom:1px solid #2d3148;margin-bottom:20px}
.top-nav h1{font-size:15px;color:#7c84f0;font-weight:600}
.breadcrumb{color:#94a3b8;margin-bottom:14px;font-size:13px}
.breadcrumb a{color:#7c84f0;text-decoration:none;cursor:pointer}
.breadcrumb a:hover{text-decoration:underline}
h2{color:#e2e8f0;margin-bottom:12px;font-size:16px}
h3{color:#cbd5e1;margin:16px 0 10px;font-size:14px;font-weight:600}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 12px;background:#1a1d2e;color:#94a3b8;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #2d3148}
td{padding:8px 12px;border-bottom:1px solid #1e2130;color:#cbd5e1;font-size:13px}
tr.clickable:hover td{background:#1a1d2e;cursor:pointer}
.task-header{background:#1a1d2e;border:1px solid #2d3148;border-radius:6px;padding:14px 16px;margin-bottom:16px}
.task-request{font-size:14px;color:#e2e8f0;margin-bottom:10px;line-height:1.5}
.task-meta{display:flex;gap:12px;flex-wrap:wrap;color:#94a3b8;font-size:12px}
.task-meta span{padding:2px 8px;background:#0f1117;border-radius:12px;border:1px solid #2d3148}
.turn-row{margin-bottom:3px;border:1px solid #2d3148;border-radius:4px;overflow:hidden}
.turn-header{display:flex;gap:14px;padding:9px 14px;background:#1a1d2e;cursor:pointer;align-items:center;flex-wrap:wrap;user-select:none}
.turn-header:hover{background:#21253a}
.turn-idx{color:#e2e8f0;font-weight:600;min-width:52px;font-size:13px}
.turn-stat{color:#94a3b8;font-size:12px}
.expand-icon{margin-left:auto;color:#7c84f0;font-size:11px}
.turn-detail{padding:12px 14px;background:#0d0f18;border-top:1px solid #2d3148}
.section{margin-bottom:8px;border:1px solid #2d3148;border-radius:4px;overflow:hidden}
.section-header{padding:8px 12px;background:#1a1d2e;display:flex;align-items:center;gap:8px;font-size:13px;color:#cbd5e1}
.section-header.clickable{cursor:pointer;user-select:none}
.section-header.clickable:hover{background:#21253a}
.arrow{margin-left:auto;color:#7c84f0;font-size:11px}
.section-body{padding:8px;background:#09090f}
.tool-call{margin-bottom:3px;border:1px solid #2d3148;border-radius:3px;overflow:hidden}
.tool-header{display:flex;align-items:center;gap:8px;padding:7px 12px;background:#1a1d2e;cursor:pointer;font-size:13px;color:#cbd5e1;user-select:none}
.tool-header:hover{background:#21253a}
.tool-body{padding:8px;background:#09090f}
.tool-sub-label{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 0 3px}
.badge{padding:1px 5px;border-radius:3px;font-size:11px;font-weight:700;flex-shrink:0}
.badge-ok{background:#052e16;color:#86efac}
.badge-error{background:#450a0a;color:#fca5a5}
pre.block-content{font-size:12px;white-space:pre-wrap;word-break:break-word;padding:8px;color:#94a3b8;line-height:1.5;max-height:500px;overflow-y:auto;font-family:Menlo,Consolas,monospace}
.error-panel{background:#2d0a0a;color:#fca5a5;padding:12px 16px;border-radius:4px;border:1px solid #7f1d1d;margin:12px 0}
.muted{color:#475569;font-style:italic;font-size:13px;padding:8px 0}
`;

	const js = `
function formatCost(c) { return c != null ? '$' + c.toFixed(4) : '\u2014'; }
function formatTokens(t) { return t != null ? t.toLocaleString() : '\u2014'; }
function formatDuration(s, e) {
  if (!e) return 'running';
  var ms = new Date(e) - new Date(s);
  return ms < 60000 ? (ms / 1000).toFixed(1) + 's' : (ms / 60000).toFixed(1) + 'm';
}
function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + '\u2026' : (s || '\u2014'); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtJson(s) {
  if (!s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return s; }
}

// \u2500\u2500 Router \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function route() {
  var hash = location.hash.slice(1) || '/';
  var parts = hash.split('?');
  var segs = parts[0].split('/').filter(Boolean);
  var params = new URLSearchParams(parts[1] || '');
  var main = document.getElementById('main');
  if (segs[0] === 'tasks' && segs[1])
    await renderTask(main, segs[1], params.get('expand'));
  else if (segs[0] === 'sessions' && segs[1])
    await renderSession(main, segs[1]);
  else
    await renderSessions(main);
}

async function apiFetch(url) {
  var res = await fetch(url);
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function showError(el, msg) { el.innerHTML = '<div class="error-panel">' + esc(msg) + '</div>'; }

// \u2500\u2500 Sessions list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function renderSessions(el) {
  el.innerHTML = '<p>Loading\u2026</p>';
  try {
    var rows = await apiFetch('/api/sessions');
    if (!rows.length) { el.innerHTML = '<p class="muted">No sessions recorded.</p>'; return; }
    var h = '<h2>Sessions</h2><table>'
      + '<thead><tr><th>Label</th><th>Agent</th><th>Model</th><th>Started</th>'
      + '<th>Duration</th><th>Tasks</th><th>Cost</th><th></th></tr></thead><tbody>';
    for (var s of rows) {
      h += '<tr class="clickable" data-href="#/sessions/' + esc(s.id) + '">'
        + '<td>' + esc(s.session_label || '\u2014') + '</td>'
        + '<td>' + esc(s.agent_name || '\u2014') + '</td>'
        + '<td>' + esc(s.model || '\u2014') + '</td>'
        + '<td>' + esc((s.started_at || '').slice(0, 19)) + '</td>'
        + '<td>' + formatDuration(s.started_at, s.ended_at) + '</td>'
        + '<td>' + (s.task_count || 0) + '</td>'
        + '<td>' + formatCost(s.total_cost) + '</td>'
        + '<td>' + (s.has_errors ? '\u26a0\ufe0f' : '\u2713') + '</td></tr>';
    }
    el.innerHTML = h + '</tbody></table>';
  } catch (e) { showError(el, e.message); }
}

// \u2500\u2500 Session task list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function renderSession(el, sessionId) {
  el.innerHTML = '<p>Loading\u2026</p>';
  try {
    var d = await apiFetch('/api/sessions/' + sessionId + '/tasks');
    var s = d.session, tasks = d.tasks;
    var label = s.session_label || s.id.slice(0, 8);
    var h = '<nav class="breadcrumb"><a data-href="#/sessions">Sessions</a> \u203a ' + esc(label) + '</nav>'
      + '<h2>Tasks</h2>';
    if (!tasks.length) { el.innerHTML = h + '<p class="muted">No tasks.</p>'; return; }
    h += '<table><thead><tr><th>Role</th><th>Team</th><th>Request</th>'
      + '<th>Turns</th><th>Cost</th><th>Duration</th><th></th></tr></thead><tbody>';
    for (var t of tasks) {
      h += '<tr class="clickable" data-href="#/tasks/' + esc(t.id) + '">'
        + '<td>' + esc(t.role || '\u2014') + '</td>'
        + '<td>' + esc(t.team || '\u2014') + '</td>'
        + '<td title="' + esc(t.overlord_request || '') + '">' + esc(trunc(t.overlord_request, 80)) + '</td>'
        + '<td>' + (t.turn_count || 0) + '</td>'
        + '<td>' + formatCost(t.total_cost) + '</td>'
        + '<td>' + formatDuration(t.started_at, t.ended_at) + '</td>'
        + '<td>' + (t.has_errors ? '\u26a0\ufe0f' : '\u2713') + '</td></tr>';
    }
    el.innerHTML = h + '</tbody></table>';
  } catch (e) { showError(el, e.message); }
}

// \u2500\u2500 Task detail \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
var _cache = {};

async function renderTask(el, taskId, expandIdx) {
  el.innerHTML = '<p>Loading\u2026</p>';
  try {
    var d = await apiFetch('/api/tasks/' + taskId);
    var t = d.task, turns = d.turns;
    var label = t.session_label || t.session_id.slice(0, 8);
    var totCost = turns.reduce(function(s, r) { return s + (r.cost_total || 0); }, 0);
    var totTok  = turns.reduce(function(s, r) { return s + (r.tokens_total || 0); }, 0);
    var h = '<nav class="breadcrumb">'
      + '<a data-href="#/sessions">Sessions</a> \u203a '
      + '<a data-href="#/sessions/' + esc(t.session_id) + '">' + esc(label) + '</a> \u203a '
      + 'Task ' + esc(t.id.slice(0, 8)) + '</nav>'
      + '<div class="task-header">'
      + '<div class="task-request">' + esc(t.overlord_request || t.user_prompt || '(no request)') + '</div>'
      + '<div class="task-meta">'
      + (t.role      ? '<span>Role: '  + esc(t.role)       + '</span>' : '')
      + (t.team      ? '<span>Team: '  + esc(t.team)       + '</span>' : '')
      + (t.from_agent? '<span>From: '  + esc(t.from_agent) + '</span>' : '')
      + '<span>' + formatTokens(totTok) + ' tok</span>'
      + '<span>' + formatCost(totCost) + '</span>'
      + '<span>' + formatDuration(t.started_at, t.ended_at) + '</span>'
      + '</div></div>'
      + '<h3>Turns (' + turns.length + ')</h3>';
    for (var tr of turns) {
      h += '<div class="turn-row">'
        + '<div class="turn-header" data-turn-id="' + esc(tr.id) + '">'
        + '<span class="turn-idx">Turn ' + tr.turn_index + '</span>'
        + '<span class="turn-stat">' + formatTokens(tr.tokens_total) + ' tok</span>'
        + '<span class="turn-stat">' + formatCost(tr.cost_total) + '</span>'
        + '<span class="turn-stat">stop=' + esc(tr.stop_reason || '\u2014') + '</span>'
        + '<span class="turn-stat">' + (tr.tool_call_count || 0) + ' tools</span>'
        + (tr.has_errors ? '<span class="turn-stat" style="color:#fca5a5">\u26a0 errors</span>' : '')
        + '<span class="expand-icon">\u25b6</span>'
        + '</div>'
        + '<div class="turn-detail" id="td-' + tr.id + '" style="display:none"></div>'
        + '</div>';
    }
    el.innerHTML = h;
    if (expandIdx != null) {
      var match = turns.find(function(r) { return String(r.turn_index) === String(expandIdx); });
      if (match) toggleTurn(match.id);
    }
  } catch (e) { showError(el, e.message); }
}

async function toggleTurn(turnId) {
  var detail = document.getElementById('td-' + turnId);
  if (!detail) return;
  var header = detail.previousElementSibling;
  var icon = header ? header.querySelector('.expand-icon') : null;
  if (detail.style.display !== 'none') {
    detail.style.display = 'none';
    if (icon) icon.textContent = '\u25b6';
    return;
  }
  if (!_cache[turnId]) {
    detail.innerHTML = '<p>Loading\u2026</p>';
    detail.style.display = 'block';
    try {
      _cache[turnId] = await apiFetch('/api/turns/' + turnId);
    } catch (e) {
      detail.innerHTML = '<div class="error-panel">' + esc(e.message) + '</div>';
      return;
    }
  }
  detail.innerHTML = renderTurnDetail(_cache[turnId]);
  detail.style.display = 'block';
  if (icon) icon.textContent = '\u25bc';
}

function renderTurnDetail(d) {
  var tb = d.thinking_blocks, at = d.assistant_text, tc = d.tool_calls, cd = d.context_delta;
  var h = '';
  if (tb.length) {
    var chars = tb.reduce(function(s, b) { return s + b.content.length; }, 0);
    h += '<div class="section">'
      + '<div class="section-header clickable">'
      + '\ud83d\udcad Thinking \u2014 ' + tb.length + ' block' + (tb.length !== 1 ? 's' : '')
      + ', ~' + (chars / 1000).toFixed(1) + 'k chars'
      + '<span class="arrow">\u25b6</span></div>'
      + '<div class="section-body" style="display:none">'
      + tb.map(function(b) { return '<pre class="block-content">' + esc(b.content) + '</pre>'; }).join('')
      + '</div></div>';
  }
  for (var b of at) {
    var short = b.content.length <= 500;
    h += '<div class="section">'
      + '<div class="section-header' + (short ? '' : ' clickable') + '">'
      + '\ud83d\udcac Assistant \u2014 ' + b.content.length + ' chars'
      + (short ? '' : '<span class="arrow">\u25b6</span>') + '</div>'
      + '<div class="section-body"' + (short ? '' : ' style="display:none"') + '>'
      + '<pre class="block-content">' + esc(b.content) + '</pre>'
      + '</div></div>';
  }
  if (tc.length) {
    h += '<div class="section">'
      + '<div class="section-header">\ud83d\udd27 Tool calls (' + tc.length + ')</div>'
      + '<div class="section-body">';
    for (var c of tc) {
      h += '<div class="tool-call">'
        + '<div class="tool-header">'
        + '<span class="badge ' + (c.is_error ? 'badge-error' : 'badge-ok') + '">'
        + (c.is_error ? '\u2717' : '\u2713') + '</span>'
        + esc(c.tool_name) + '<span class="arrow">\u25b6</span></div>'
        + '<div class="tool-body" style="display:none">'
        + '<div class="tool-sub-label">Args</div>'
        + '<pre class="block-content">' + esc(fmtJson(c.args_json)) + '</pre>'
        + (c.result_json
            ? '<div class="tool-sub-label">Result</div><pre class="block-content">'
              + esc(fmtJson(c.result_json)) + '</pre>'
            : '')
        + '</div></div>';
    }
    h += '</div></div>';
  }
  if (cd) {
    h += '<div class="section">'
      + '<div class="section-header clickable">'
      + '\ud83d\udccb Context delta \u2014 '
      + cd.message_count + ' new / ' + cd.total_message_count + ' total'
      + '<span class="arrow">\u25b6</span></div>'
      + '<div class="section-body" style="display:none">'
      + '<pre class="block-content">' + esc(fmtJson(cd.messages_json)) + '</pre>'
      + '</div></div>';
  }
  return h || '<p class="muted">No content recorded for this turn.</p>';
}

function toggleSection(header) {
  var body = header.nextElementSibling;
  var arrow = header.querySelector('.arrow');
  if (body.style.display === 'none') {
    body.style.display = 'block';
    if (arrow) arrow.textContent = '\u25bc';
  } else {
    body.style.display = 'none';
    if (arrow) arrow.textContent = '\u25b6';
  }
}

// \u2500\u2500 Event delegation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
document.addEventListener('click', function(e) {
  var nav = e.target.closest('[data-href]');
  if (nav) { location.hash = nav.dataset.href; return; }
  var th = e.target.closest('.turn-header[data-turn-id]');
  if (th) { toggleTurn(th.dataset.turnId); return; }
  var sh = e.target.closest('.section-header.clickable, .tool-header');
  if (sh) { toggleSection(sh); return; }
});

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', route);
`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi Telemetry</title>
<style>${css}</style>
</head>
<body>
<div class="top-nav"><h1>\ud83d\udcca Pi Telemetry</h1></div>
<div id="app"><div id="main">Loading\u2026</div></div>
<script>${js}<\/script>
</body>
</html>`;
}
