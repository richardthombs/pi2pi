import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { buildTmuxLikeCommandSequence, cmuxLayoutForCommands, selectMultiplexerKind } from "../multiplexer";

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
		expect(commands[0]).toEqual(["tmux", "has-session", "-t", "pi2pi-org"]);
		expect(commands[1]).toContain("new-session");
		expect(commands[1]).toContain("leadership");
		expect(commands.some(command => command.includes("set-option") && command.includes("extended-keys") && command.includes("on"))).toBe(true);
		expect(commands.some(command => command.includes("new-window") && command.includes("broker"))).toBe(true);
		expect(commands.some(command => command.includes("new-window") && command.includes("engineering"))).toBe(true);
		expect(commands.some(command => command.includes("split-window") && command.includes("pi2pi-org:engineering"))).toBe(true);
		// 2 members → 2×1, spare=0 → "tiled"
		expect(commands.some(command => command.includes("select-layout") && command.includes("tiled"))).toBe(true);
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
