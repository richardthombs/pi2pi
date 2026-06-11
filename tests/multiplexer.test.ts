import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { buildTmuxLikeCommandSequence, cmuxLayoutForCommands, selectMultiplexerKind } from "../multiplexer";
import embeddedBrokerSource from "../broker.ts" with { type: "text" };
import embeddedBrokerUiSource from "../broker-ui.ts" with { type: "text" };

function git(args: string[], cwd?: string): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString("utf8"));
	return Buffer.from(proc.stdout).toString("utf8").trim();
}

describe("multiplexer selection", () => {
	test("windows requires psmux", () => {
		expect(selectMultiplexerKind("win32", { psmux: true })).toBe("psmux");
		expect(() => selectMultiplexerKind("win32", { psmux: false })).toThrow(/psmux is required on Windows/i);
	});

	test("mac prefers responsive cmux then tmux", () => {
		expect(selectMultiplexerKind("darwin", { cmux: true, cmuxResponsive: true, tmux: true })).toBe("cmux");
		expect(selectMultiplexerKind("darwin", { cmux: true, cmuxResponsive: false, tmux: true })).toBe("tmux");
		expect(() => selectMultiplexerKind("darwin", { cmux: false, tmux: false })).toThrow(/requires cmux .* or tmux/i);
	});

	test("linux requires tmux", () => {
		expect(selectMultiplexerKind("linux", { tmux: true })).toBe("tmux");
		expect(() => selectMultiplexerKind("linux", { tmux: false })).toThrow(/tmux is required on Linux/i);
	});
});

describe("tmux-like command generation", () => {
	let root: string;
	let originRepo: string;
	let loaded: LoadedConfig;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi2pi-mux-"));
		originRepo = join(root, "origin");
		mkdirSync(originRepo, { recursive: true });
		git(["init", "--initial-branch=main"], originRepo);
		writeFileSync(join(originRepo, "README.md"), "# test\n", "utf8");
		git(["add", "."], originRepo);
		git(["commit", "-m", "initial"], originRepo);

		loaded = {
			configPath: join(root, "config.yaml"),
			configDir: root,
			projectRoot: root,
			config: defaultConfig(),
		};
		loaded.config.orchestration.sessionName = "pi2pi-org";
		loaded.config.roles.manager = {
			title: "Manager",
			model: "gpt-4o",
			systemPrompt: "You are {{name}}.",
			tools: ["tell", "who"],
		};
		loaded.config.roles.engineer = {
			title: "Engineer",
			model: "gpt-4o",
			systemPrompt: "You are {{name}}.",
			tools: ["tell", "who"],
		};
		loaded.config.repositories.pi2pi = { url: originRepo, ref: "main" };
		loaded.config.workspaces.engineering = {
			room: "engineering",
			leader: "Alice",
			repositories: ["pi2pi"],
			members: [
				{ name: "Alice", role: "manager" },
				{ name: "Bob", role: "engineer" },
			],
		};
	});

	test("builds leadership, broker, and team windows for tmux-like backends", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		const brokerPath = join(root, "broker.ts");
		expect(existsSync(brokerPath)).toBe(true);
		expect(readFileSync(brokerPath, "utf8")).toBe(embeddedBrokerSource);
		const brokerUiPath = join(root, "broker-ui.ts");
		expect(existsSync(brokerUiPath)).toBe(true);
		expect(readFileSync(brokerUiPath, "utf8")).toBe(embeddedBrokerUiSource);
		expect(commands[0]).toEqual(["tmux", "has-session", "-t", "pi2pi-org"]);
		expect(commands[1]).toContain("new-session");
		expect(commands[1]).toContain("leadership");
		expect(commands.some(command => command.includes("set-option") && command.includes("extended-keys") && command.includes("on"))).toBe(true);
		expect(commands.some(command => command.includes("new-window") && command.includes("broker"))).toBe(true);
		expect(commands.some(command => command.some(el => el.includes(brokerPath)))).toBe(true);
		expect(commands.some(command => command.includes("new-window") && command.includes("engineering"))).toBe(true);
		expect(commands.some(command => command.includes("split-window") && command.some(el => el.startsWith("pi2pi-org:engineering")))).toBe(true);
		const worktreePath = join(root, ".pi", "workspaces", "engineering", "pi2pi");
		const workspaceRoot = join(root, ".pi", "workspaces", "engineering");
		expect(commands.some(command => command.some(el => el.includes(`cd '${worktreePath.replace(/\\/g, "\\\\")}'`) || el.includes(`cd '${worktreePath}'`)))).toBe(true);
		expect(commands.some(command => command.some(el => el.includes(`export GIT_CEILING_DIRECTORIES='${workspaceRoot.replace(/\\/g, "\\\\")}'`) || el.includes(`export GIT_CEILING_DIRECTORIES='${workspaceRoot}'`)))).toBe(true);
	});

	test("psmux commands inline cwd, git ceiling, and prompt text with only single-quote escaping", () => {
		loaded.config.roles.manager.systemPrompt = "Leader's base prompt with \"quotes\".\nSecond line.";
		const commands = buildTmuxLikeCommandSequence(loaded, "psmux", "psmux");
		const brokerPath = join(root, "broker.ts");
		expect(existsSync(brokerPath)).toBe(true);
		expect(readFileSync(brokerPath, "utf8")).toBe(embeddedBrokerSource);
		const brokerUiPath = join(root, "broker-ui.ts");
		expect(existsSync(brokerUiPath)).toBe(true);
		expect(readFileSync(brokerUiPath, "utf8")).toBe(embeddedBrokerUiSource);

		const launchScriptsDir = join(root, ".pi", "runtime", "launch-scripts");
		const launchPromptsDir = join(root, ".pi", "runtime", "launch-prompts");
		expect(existsSync(launchScriptsDir)).toBe(false);
		expect(existsSync(launchPromptsDir)).toBe(false);

		const engineeringWindow = commands.find(command => command[1] === "new-window" && command.includes("engineering"));
		expect(engineeringWindow).toBeDefined();
		const commandText = engineeringWindow![engineeringWindow!.length - 1];
		expect(commandText).toContain(`$env:GIT_CEILING_DIRECTORIES = '${join(root, ".pi", "workspaces", "engineering").replace(/'/g, "''")}'`);
		expect(commandText).toContain(`Set-Location -LiteralPath '${join(root, ".pi", "workspaces", "engineering", "pi2pi").replace(/'/g, "''")}'`);
		expect(commandText).not.toContain("FromBase64String");
		expect(commandText).toContain("$appendSystemPrompt = (@(");
		expect(commandText).toContain(`'Leader''s base prompt with "quotes".', 'Second line.'`);
		expect(commandText).toContain("-join [Environment]::NewLine");
		expect(commandText).toContain("Clear-Host; & 'pi'");

		const fakePiPath = join(root, "fake-pi.ps1");
		const capturePath = join(root, "captured-args.json");
		writeFileSync(fakePiPath, [
			"$items = @()",
			"foreach ($a in $args) { $items += $a }",
			`$items | ConvertTo-Json -Compress | Set-Content -LiteralPath '${capturePath.replace(/'/g, "''")}'`,
		].join("\n"), "utf8");

		const runnableCommand = commandText.replace("& 'pi'", `& '${fakePiPath.replace(/'/g, "''")}'`);
		const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const result = Bun.spawnSync([powershellPath, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", runnableCommand], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(existsSync(capturePath)).toBe(true);
		const capturedArgs = JSON.parse(readFileSync(capturePath, "utf8")) as string[];
		const promptArg = capturedArgs[capturedArgs.indexOf("--append-system-prompt") + 1].replace(/\r\n/g, "\n");
		expect(promptArg).toContain("Leader's base prompt with \"quotes\".\nSecond line.");
		expect(capturedArgs).toContain("--agent-name");
		expect(capturedArgs).toContain("engineering.lead");
	});
});

// ---------------------------------------------------------------------------
// Simulate pane dimensions from a tmux command sequence.
// Panes are tracked in POSITIONAL order (column-major). V-splits and H-splits
// insert the new pane at position idx+1 (splice), renumbering later panes — which
// matches psmux's column-major numbering scheme and keeps panes[idx] correct.
// ---------------------------------------------------------------------------
function simulatePanes(cmds: string[][]): Array<{ x: number; y: number; w: number; h: number }> {
	const panes: Array<{ x: number; y: number; w: number; h: number }> = [];
	for (const cmd of cmds) {
		const verb = cmd[1];
		if (verb === "new-window") {
			panes.push({ x: 0, y: 0, w: 1, h: 1 });
		} else if (verb === "split-window") {
			const tIdx = cmd.indexOf("-t") + 1;
			const paneIdx = parseInt(cmd[tIdx].split(".").pop()!);
			const isH = cmd.includes("-h");
			const pct = parseInt(cmd[cmd.indexOf("-p") + 1]) / 100;
			const par = panes[paneIdx];
			if (isH) {
				// New pane to the right; insert at paneIdx+1 (shifts later panes)
				const leftW = par.w * (1 - pct);
				panes[paneIdx] = { ...par, w: leftW };
				panes.splice(paneIdx + 1, 0, { x: par.x + leftW, y: par.y, w: par.w * pct, h: par.h });
			} else {
				// New pane below; insert at paneIdx+1 (shifts later panes)
				const topH = par.h * (1 - pct);
				panes[paneIdx] = { ...par, h: topH };
				panes.splice(paneIdx + 1, 0, { x: par.x, y: par.y + topH, w: par.w, h: par.h * pct });
			}
		}
	}
	return panes;
}

// Extract commands for a specific team window from the full sequence
function teamWindowCmds(all: string[][], windowName: string): string[][] {
	let inWindow = false;
	const result: string[][] = [];
	for (const cmd of all) {
		if (cmd[1] === "new-window" && cmd.includes(windowName)) { inWindow = true; }
		else if (cmd[1] === "new-window") { inWindow = false; }
		if (inWindow) result.push(cmd);
	}
	return result;
}

describe("tmux exact percentage splits", () => {
	const TOL = 0.011; // 1.1% — accommodates integer rounding

	let root: string;
	let originRepo: string;
	let baseLoaded: ReturnType<typeof makeLoaded>;

	function makeLoaded(memberCount: number) {
		const { mkdtempSync, mkdirSync, writeFileSync: wf } = require("fs");
		const { join: j } = require("path");
		const { tmpdir } = require("os");
		const { defaultConfig } = require("../config-store");
		const r = mkdtempSync(j(tmpdir(), "pi2pi-tmux-"));
		const orig = j(r, "origin");
		mkdirSync(orig, { recursive: true });
		const p = Bun.spawnSync(["git", "init", "--initial-branch=main", orig]);
		wf(j(orig, "README.md"), "# test\n", "utf8");
		Bun.spawnSync(["git", "-C", orig, "add", "."]);
		Bun.spawnSync(["git", "-C", orig, "commit", "-m", "init",
			"--author=Test User <t@t.com>"], { env: { ...process.env, GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "t@t.com" } });
		const cfg = defaultConfig();
		cfg.orchestration.sessionName = "pi2pi-test";
		cfg.roles.eng = { title: "Engineer", model: "gpt-4o", systemPrompt: ".", tools: [] };
		cfg.repositories.repo = { url: orig, ref: "main" };
		const members = Array.from({ length: memberCount }, (_, i) => ({ name: `Agent${i}`, role: "eng" }));
		cfg.workspaces.team = { room: "team", leader: "Agent0", repositories: ["repo"], members };
		return { configPath: j(r, "config.yaml"), configDir: r, projectRoot: r, config: cfg };
	}

	function getPanes(memberCount: number) {
		const loaded = makeLoaded(memberCount);
		const all = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		expect(all.some(c => c.includes("select-layout"))).toBe(false);
		const wCmds = teamWindowCmds(all, "team");
		return { panes: simulatePanes(wCmds), wCmds };
	}

	// Extract pane index from each split-window command's -t flag (.N suffix)
	function splitTargets(wCmds: string[][]): number[] {
		return wCmds
			.filter(cmd => cmd[1] === "split-window")
			.map(cmd => parseInt(cmd[cmd.indexOf("-t") + 1].split(".").pop()!));
	}

	test("n=3 (cols=2, sizes=[1,2]): 3 panes, correct targets, col widths ≈ equal, pane heights correct", () => {
		const { panes, wCmds } = getPanes(3);
		// offsets=[0,1]: Phase1 H-split target .0; Phase2 col1 V-split target .1
		expect(splitTargets(wCmds)).toEqual([0, 1]);
		expect(panes).toHaveLength(3);
		// pane 0: left col, full height
		expect(Math.abs(panes[0].x)).toBeLessThan(TOL);
		expect(Math.abs(panes[0].w - 0.5)).toBeLessThan(TOL);
		expect(Math.abs(panes[0].h - 1.0)).toBeLessThan(TOL);
		// pane 1 & 2: right col, each half height
		for (const p of [panes[1], panes[2]]) {
			expect(Math.abs(p.w - 0.5)).toBeLessThan(TOL);
			expect(Math.abs(p.h - 0.5)).toBeLessThan(TOL);
		}
	});

	test("n=5 (cols=2, sizes=[2,3]): 5 panes, correct targets, col widths ≈ 0.5, row heights ≈ equal per col", () => {
		const { panes, wCmds } = getPanes(5);
		// offsets=[0,2]: H .0; V col0 .0; V col1 .2, .3
		expect(splitTargets(wCmds)).toEqual([0, 0, 2, 3]);
		expect(panes).toHaveLength(5);
		// All panes roughly split into 2 equal-width columns
		for (const p of panes) expect(Math.abs(p.w - 0.5)).toBeLessThan(TOL);
		// Left col (2 panes): each ≈ 0.5 height
		const leftCol = panes.filter(p => p.x < 0.5);
		for (const p of leftCol) expect(Math.abs(p.h - 0.5)).toBeLessThan(TOL);
		// Right col (3 panes): each ≈ 1/3 height
		const rightCol = panes.filter(p => p.x >= 0.5 - TOL && p.x < 0.5 + TOL);
		for (const p of rightCol) expect(Math.abs(p.h - 1/3)).toBeLessThan(TOL);
	});

	test("n=7 (cols=3, sizes=[2,2,3]): 7 panes, correct targets, col widths ≈ 1/3", () => {
		const { panes, wCmds } = getPanes(7);
		// offsets=[0,2,4]: H .0 .1; V col0 .0; V col1 .2; V col2 .4 .5
		expect(splitTargets(wCmds)).toEqual([0, 1, 0, 2, 4, 5]);
		expect(panes).toHaveLength(7);
		for (const p of panes) expect(Math.abs(p.w - 1/3)).toBeLessThan(TOL);
		// col0 and col1: 2 panes each ≈ 0.5 height
		const col0 = panes.filter(p => p.x < 1/3 - TOL/2);
		const col1 = panes.filter(p => p.x > 1/3 - TOL && p.x < 2/3 - TOL);
		for (const p of [...col0, ...col1]) expect(Math.abs(p.h - 0.5)).toBeLessThan(TOL);
		// col2: 3 panes ≈ 1/3 height each
		const col2 = panes.filter(p => p.x > 2/3 - TOL);
		for (const p of col2) expect(Math.abs(p.h - 1/3)).toBeLessThan(TOL);
	});

	test("n=9 (cols=3, sizes=[3,3,3]): 9 panes, correct targets, col widths ≈ 1/3, row heights ≈ 1/3", () => {
		const { panes, wCmds } = getPanes(9);
		// offsets=[0,3,6]: H .0 .1; V col0 .0 .1; V col1 .3 .4; V col2 .6 .7
		expect(splitTargets(wCmds)).toEqual([0, 1, 0, 1, 3, 4, 6, 7]);
		expect(panes).toHaveLength(9);
		for (const p of panes) {
			expect(Math.abs(p.w - 1/3)).toBeLessThan(TOL);
			expect(Math.abs(p.h - 1/3)).toBeLessThan(TOL);
		}
	});

	test("no select-layout command appears for any team window", () => {
		for (const n of [3, 9]) {
			const loaded = makeLoaded(n);
			const all = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
			expect(all.some(c => c.includes("select-layout"))).toBe(false);
		}
	});
});


describe("cmux grid layout", () => {
	type LayoutNode = ReturnType<typeof cmuxLayoutForCommands>;

	// Count panes per top-level column
	function columnSizes(node: LayoutNode): number[] {
		function countLeaves(n: LayoutNode): number {
			if ("pane" in n) return 1;
			return countLeaves(n.children[0]) + countLeaves(n.children[1]);
		}
		const cols: number[] = [];
		let cur: LayoutNode = node;
		while (!("pane" in cur) && cur.direction === "horizontal") {
			cols.push(countLeaves(cur.children[0]));
			cur = cur.children[1];
		}
		cols.push(countLeaves(cur));
		return cols;
	}

	// In-order leaf traversal
	function inOrder(node: LayoutNode): string[] {
		if ("pane" in node) return [node.pane.surfaces[0].command];
		return [...inOrder(node.children[0]), ...inOrder(node.children[1])];
	}

	// Collect all horizontal split values
	function splitValues(node: LayoutNode): number[] {
		if ("pane" in node) return [];
		return [
			...(node.direction === "horizontal" ? [node.split] : []),
			...splitValues(node.children[0]),
			...splitValues(node.children[1]),
		];
	}

	const T = 1e-10;

	test("n=1 -- single pane, no split", () => {
		const layout = cmuxLayoutForCommands(["a"]);
		expect("pane" in layout).toBe(true);
		expect(columnSizes(layout)).toEqual([1]);
	});

	test("n=2 -- columnSizes=[2] (single column, known edge case)", () => {
		// rows_max=2, cols=ceil(2/2)=1 => single column of 2 stacked
		expect(columnSizes(cmuxLayoutForCommands(["a", "b"]))).toEqual([2]);
	});

	test("n=3 -- columnSizes=[1,2]", () => {
		expect(columnSizes(cmuxLayoutForCommands(["a","b","c"]))).toEqual([1, 2]);
	});

	test("n=4 -- columnSizes=[2,2]", () => {
		expect(columnSizes(cmuxLayoutForCommands(["a","b","c","d"]))).toEqual([2, 2]);
	});

	test("n=5 -- columnSizes=[2,3]", () => {
		expect(columnSizes(cmuxLayoutForCommands(["a","b","c","d","e"]))).toEqual([2, 3]);
	});

	test("n=7 -- columnSizes=[2,2,3]", () => {
		const cmds = ["a","b","c","d","e","f","g"];
		expect(columnSizes(cmuxLayoutForCommands(cmds))).toEqual([2, 2, 3]);
	});

	test("n=9 -- columnSizes=[3,3,3]", () => {
		const cmds = Array.from({length: 9}, (_, i) => String(i));
		expect(columnSizes(cmuxLayoutForCommands(cmds))).toEqual([3, 3, 3]);
	});

	test("commands appear in input order via in-order traversal", () => {
		const cmds = ["alpha","beta","gamma","delta","epsilon"];
		expect(inOrder(cmuxLayoutForCommands(cmds))).toEqual(cmds);
	});

	test("all horizontal splits give equal column widths (split=1/remaining cols)", () => {
		// n=6: cols=2, each horizontal split should be 0.5
		const splits6 = splitValues(cmuxLayoutForCommands(["a","b","c","d","e","f"]));
		expect(splits6.length).toBeGreaterThan(0);
		for (const s of splits6) expect(Math.abs(s - 0.5)).toBeLessThan(T);

		// n=9: cols=3, top-level splits are 1/3 and 1/2 (equal width columns)
		const node9 = cmuxLayoutForCommands(Array.from({length: 9}, (_, i) => String(i)));
		if (!("pane" in node9) && node9.direction === "horizontal") {
			expect(Math.abs(node9.split - 1/3)).toBeLessThan(T);
		}
	});

	test("n=0 throws", () => {
		expect(() => cmuxLayoutForCommands([])).toThrow();
	});
});
