import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { buildTmuxLikeCommandSequence, cmuxLayoutForCommands, selectMultiplexerKind, tmuxLayoutName } from "../multiplexer";

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
	const T = 1e-10;

	type LayoutNode = ReturnType<typeof cmuxLayoutForCommands>;

	function paneAreas(node: LayoutNode, w = 1, h = 1): Array<{ width: number; height: number }> {
		if ("pane" in node) return [{ width: w, height: h }];
		if (node.direction === "horizontal") {
			return [
				...paneAreas(node.children[0], w * node.split, h),
				...paneAreas(node.children[1], w * (1 - node.split), h),
			];
		} else {
			return [
				...paneAreas(node.children[0], w, h * node.split),
				...paneAreas(node.children[1], w, h * (1 - node.split)),
			];
		}
	}

	function inOrder(node: LayoutNode): string[] {
		if ("pane" in node) return [node.pane.surfaces[0].command];
		return [...inOrder(node.children[0]), ...inOrder(node.children[1])];
	}

	test("n=1 -- single pane node, no split", () => {
		const layout = cmuxLayoutForCommands(["a"]);
		expect("pane" in layout).toBe(true);
	});

	test("n=2 (2x1, spare=0) -- 2 equal panes, area = 0.5 each", () => {
		const areas = paneAreas(cmuxLayoutForCommands(["a", "b"]));
		expect(areas).toHaveLength(2);
		for (const a of areas) expect(Math.abs(a.width * a.height - 0.5)).toBeLessThan(T);
	});

	test("n=3 (2x2, spare=1) -- leader area = 0.5, height = 1, others = 0.25 each", () => {
		const areas = paneAreas(cmuxLayoutForCommands(["leader", "b", "c"]));
		expect(areas).toHaveLength(3);
		expect(Math.abs(areas[0].width - 0.5)).toBeLessThan(T);
		expect(Math.abs(areas[0].height - 1)).toBeLessThan(T);
		for (const a of areas.slice(1)) expect(Math.abs(a.width * a.height - 0.25)).toBeLessThan(T);
	});

	test("n=4 (2x2, spare=0) -- all areas = 0.25", () => {
		const areas = paneAreas(cmuxLayoutForCommands(["a", "b", "c", "d"]));
		expect(areas).toHaveLength(4);
		for (const a of areas) expect(Math.abs(a.width * a.height - 0.25)).toBeLessThan(T);
	});

	test("n=5 (3x2, spare=1) -- leader area = 1/3, others = 1/6 each", () => {
		const areas = paneAreas(cmuxLayoutForCommands(["a", "b", "c", "d", "e"]));
		expect(areas).toHaveLength(5);
		expect(Math.abs(areas[0].width * areas[0].height - 1 / 3)).toBeLessThan(T);
		for (const a of areas.slice(1)) expect(Math.abs(a.width * a.height - 1 / 6)).toBeLessThan(T);
	});

	test("n=6 (3x2, spare=0) -- all areas = 1/6", () => {
		const areas = paneAreas(cmuxLayoutForCommands(["a", "b", "c", "d", "e", "f"]));
		expect(areas).toHaveLength(6);
		for (const a of areas) expect(Math.abs(a.width * a.height - 1 / 6)).toBeLessThan(T);
	});

	test("commands appear in input order via in-order traversal", () => {
		const cmds = ["alpha", "beta", "gamma", "delta"];
		expect(inOrder(cmuxLayoutForCommands(cmds))).toEqual(cmds);
	});

	test("n=0 throws", () => {
		expect(() => cmuxLayoutForCommands([])).toThrow();
	});
});

describe("tmuxLayoutName", () => {
	test("spare=0 cases use tiled", () => {
		expect(tmuxLayoutName(1)).toBe("tiled");
		expect(tmuxLayoutName(2)).toBe("tiled");
		expect(tmuxLayoutName(4)).toBe("tiled");
		expect(tmuxLayoutName(6)).toBe("tiled");
		expect(tmuxLayoutName(9)).toBe("tiled");
	});

	test("spare>0 cases use main-vertical", () => {
		expect(tmuxLayoutName(3)).toBe("main-vertical");
		expect(tmuxLayoutName(5)).toBe("main-vertical");
		expect(tmuxLayoutName(7)).toBe("main-vertical");
		expect(tmuxLayoutName(8)).toBe("main-vertical");
	});
});
