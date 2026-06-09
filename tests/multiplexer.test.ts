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
		expect(commands.some(command => command.includes("select-layout") && command.includes("tiled"))).toBe(true);
	});
});

describe("cmux equal-pane layout", () => {
	const TOLERANCE = 1e-10;

	function totalWidth(node: ReturnType<typeof cmuxLayoutForCommands>, inherited = 1): number[] {
		if ("pane" in node) return [inherited];
		const left = inherited * node.split;
		const right = inherited * (1 - node.split);
		return [...totalWidth(node.children[0], left), ...totalWidth(node.children[1], right)];
	}

	test("1 command — single pane, no split", () => {
		const layout = cmuxLayoutForCommands(["cmd1"]);
		expect("pane" in layout).toBe(true);
		if ("pane" in layout) {
			expect(layout.pane.surfaces[0].command).toBe("cmd1");
		}
	});

	test("2 commands — each pane gets 1/2 of total width", () => {
		const layout = cmuxLayoutForCommands(["cmd1", "cmd2"]);
		const widths = totalWidth(layout);
		expect(widths).toHaveLength(2);
		for (const w of widths) expect(Math.abs(w - 1 / 2)).toBeLessThan(TOLERANCE);
	});

	test("3 commands — each pane gets 1/3 of total width", () => {
		const layout = cmuxLayoutForCommands(["cmd1", "cmd2", "cmd3"]);
		const widths = totalWidth(layout);
		expect(widths).toHaveLength(3);
		for (const w of widths) expect(Math.abs(w - 1 / 3)).toBeLessThan(TOLERANCE);
	});

	test("4 commands — each pane gets 1/4 of total width", () => {
		const layout = cmuxLayoutForCommands(["cmd1", "cmd2", "cmd3", "cmd4"]);
		const widths = totalWidth(layout);
		expect(widths).toHaveLength(4);
		for (const w of widths) expect(Math.abs(w - 1 / 4)).toBeLessThan(TOLERANCE);
	});

	test("commands are embedded in pane surfaces in order", () => {
		const cmds = ["alpha", "beta", "gamma"];
		const layout = cmuxLayoutForCommands(cmds);
		const collected: string[] = [];
		function collect(node: ReturnType<typeof cmuxLayoutForCommands>): void {
			if ("pane" in node) { collected.push(node.pane.surfaces[0].command); return; }
			collect(node.children[0]);
			collect(node.children[1]);
		}
		collect(layout);
		expect(collected).toEqual(cmds);
	});

	test("all splits use horizontal direction", () => {
		const layout = cmuxLayoutForCommands(["a", "b", "c", "d"]);
		function checkDirs(node: ReturnType<typeof cmuxLayoutForCommands>): void {
			if ("pane" in node) return;
			expect(node.direction).toBe("horizontal");
			checkDirs(node.children[0]);
			checkDirs(node.children[1]);
		}
		checkDirs(layout);
	});
});
