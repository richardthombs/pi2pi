/**
 * psmux-integration.test.ts
 *
 * Live integration tests that spin up real psmux sessions, execute the
 * buildColumnSplitCommands sequence against them, and verify the resulting
 * pane geometry via `list-panes`.
 *
 * Prerequisites:
 *   - psmux must be available on PATH (or at the path below)
 *   - Tests are skipped gracefully if psmux is not found
 *
 * Verified against live psmux output:
 *   n=5: 0 0 0 59 14 / 1 0 15 59 15 / 2 60 0 60 9 / 3 60 10 60 9 / 4 60 20 60 10
 *   n=7: 0 0 0 39 14 / 1 0 15 39 15 / 2 40 0 39 14 / 3 40 15 39 15 /
 *        4 80 0 40 9 / 5 80 10 40 9 / 6 80 20 40 10
 */

import { describe, test, expect, afterAll } from "bun:test";
import { buildColumnSplitCommands } from "../multiplexer";

const PSMUX = "psmux";
const ENV = { ...process.env, PSMUX_SESSION: "" };
const WIN_W = 120;
const WIN_H = 30;

// ── low-level helpers ─────────────────────────────────────────────────────────

function run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const r = Bun.spawnSync([PSMUX, ...args], { env: ENV, stdout: "pipe", stderr: "pipe" });
	return {
		ok: r.exitCode === 0,
		stdout: Buffer.from(r.stdout).toString("utf8").trim(),
		stderr: Buffer.from(r.stderr).toString("utf8").trim(),
	};
}

function psmuxAvailable(): boolean {
	try {
		const r = Bun.spawnSync([PSMUX, "-V"], { env: ENV, stdout: "pipe", stderr: "pipe" });
		return r.exitCode === 0;
	} catch {
		return false;
	}
}

interface PaneInfo {
	index: number;
	left: number;
	top: number;
	width: number;
	height: number;
}

function listPanes(session: string, window: string): PaneInfo[] {
	const r = run([
		"list-panes", "-t", `${session}:${window}`,
		"-F", "#{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
	]);
	if (!r.ok) throw new Error("list-panes failed: " + r.stderr);
	return r.stdout.split("\n").filter(Boolean).map(line => {
		const [index, left, top, width, height] = line.trim().split(" ").map(Number);
		return { index, left, top, width, height };
	});
}

function groupByColumn(panes: PaneInfo[]): Map<number, PaneInfo[]> {
	const cols = new Map<number, PaneInfo[]>();
	for (const p of panes) {
		const existing = cols.get(p.left) ?? [];
		existing.push(p);
		cols.set(p.left, existing);
	}
	return cols;
}

// ── session fixture ───────────────────────────────────────────────────────────

function runLayout(sessionName: string, agents: string[]): PaneInfo[] {
	const winName = "panes";

	// Create session with fixed terminal size for deterministic pane dimensions
	const newSession = run([
		"new-session", "-d", "-s", sessionName, "-n", winName,
		"-x", String(WIN_W), "-y", String(WIN_H),
		agents[0], // first pane command (leader)
	]);
	if (!newSession.ok) throw new Error("new-session failed: " + newSession.stderr);

	// Run the split commands — uses buildColumnSplitCommands, the same path as production
	const cmds = buildColumnSplitCommands(PSMUX, sessionName, winName, agents);
	for (const cmd of cmds) {
		const r = Bun.spawnSync(cmd, { env: ENV, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) {
			throw new Error(
				"psmux command failed: " + cmd.join(" ") + "\n" + Buffer.from(r.stderr).toString(),
			);
		}
	}

	return listPanes(sessionName, winName);
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("psmux live layout integration", () => {
	const sessions: string[] = [];

	afterAll(() => {
		for (const s of sessions) {
			run(["kill-session", "-t", s]);
		}
	});

	function session(name: string): string {
		sessions.push(name);
		return name;
	}

	const skip = !psmuxAvailable();
	const maybeTest = skip ? test.skip : test;
	if (skip) console.log("  (skipping psmux integration tests — psmux not found on PATH)");

	// ── n=5: cols=2, colSizes=[2,3] ──────────────────────────────────────────

	maybeTest("n=5 agents -> 2:3 columns on live psmux", () => {
		const agents = ["cat", "cat", "cat", "cat", "cat"];
		const panes = runLayout(session("pi2pi-test-n5"), agents);

		// Correct pane count
		expect(panes).toHaveLength(5);

		// Leader is top-left
		expect(panes[0].left).toBe(0);
		expect(panes[0].top).toBe(0);

		// Group by column
		const cols = groupByColumn(panes);
		const colXs = [...cols.keys()].sort((a, b) => a - b);

		// Exactly 2 columns
		expect(colXs).toHaveLength(2);

		// 2 : 3 pane distribution
		const leftCol  = cols.get(colXs[0])!.sort((a, b) => a.top - b.top);
		const rightCol = cols.get(colXs[1])!.sort((a, b) => a.top - b.top);
		expect(leftCol).toHaveLength(2);
		expect(rightCol).toHaveLength(3);

		// Equal column widths across all panes (±1 cell — integer rounding)
		const allWidths = panes.map(p => p.width);
		expect(Math.max(...allWidths) - Math.min(...allWidths)).toBeLessThanOrEqual(1);

		// Equal heights within left col (±1 cell)
		const leftHeights = leftCol.map(p => p.height);
		expect(Math.max(...leftHeights) - Math.min(...leftHeights)).toBeLessThanOrEqual(1);

		// Equal heights within right col (±1 cell)
		const rightHeights = rightCol.map(p => p.height);
		expect(Math.max(...rightHeights) - Math.min(...rightHeights)).toBeLessThanOrEqual(1);

		// Panes fill window height contiguously (psmux adds 1-cell separator between panes)
		for (const col of [leftCol, rightCol]) {
			let y = 0;
			for (const p of col) {
				expect(p.top).toBe(y);
				y += p.height + 1; // 1-cell separator
			}
		}
	});

	// ── n=7: cols=3, colSizes=[2,2,3] ────────────────────────────────────────

	maybeTest("n=7 agents -> 2:2:3 columns on live psmux", () => {
		const agents = Array(7).fill("cat");
		const panes = runLayout(session("pi2pi-test-n7"), agents);

		// Correct pane count
		expect(panes).toHaveLength(7);

		// Leader is top-left
		expect(panes[0].left).toBe(0);
		expect(panes[0].top).toBe(0);

		// Group by column
		const cols = groupByColumn(panes);
		const colXs = [...cols.keys()].sort((a, b) => a - b);

		// Exactly 3 columns
		expect(colXs).toHaveLength(3);

		const [c0, c1, c2] = colXs.map(x => cols.get(x)!.sort((a, b) => a.top - b.top));

		// 2 : 2 : 3 pane distribution
		expect(c0).toHaveLength(2);
		expect(c1).toHaveLength(2);
		expect(c2).toHaveLength(3);

		// Equal column widths (±1 cell)
		const allWidths = panes.map(p => p.width);
		expect(Math.max(...allWidths) - Math.min(...allWidths)).toBeLessThanOrEqual(1);

		// Equal heights within each column (±1 cell)
		for (const col of [c0, c1, c2]) {
			const hs = col.map(p => p.height);
			expect(Math.max(...hs) - Math.min(...hs)).toBeLessThanOrEqual(1);
		}

		// Panes fill window height contiguously within each column
		for (const col of [c0, c1, c2]) {
			let y = 0;
			for (const p of col) {
				expect(p.top).toBe(y);
				y += p.height + 1;
			}
		}
	});
});
