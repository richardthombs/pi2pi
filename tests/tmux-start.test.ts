/**
 * tmux-start.test.ts
 *
 * Tests for the tmux/psmux orchestration start path via buildTmuxLikeCommandSequence
 * combined with a fake tmux binary that records invocations. Validates the
 * command sequence that would be sent to tmux without needing tmux installed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { buildTmuxLikeCommandSequence } from "../multiplexer";

function git(args: string[], cwd?: string): void {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "t@t.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "t@t.com",
		},
	});
	if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString("utf8"));
}

function makeLoadedConfig(root: string, originRepo: string): LoadedConfig {
	const loaded: LoadedConfig = {
		configPath: join(root, "config.yaml"),
		configDir: root,
		projectRoot: root,
		config: defaultConfig(),
	};
	loaded.config.orchestration.sessionName = "pi2pi-test";
	loaded.config.orchestration.broker = "ws://localhost:7331";
	loaded.config.roles.engineer = {
		title: "Engineer",
		model: "github-copilot/claude-sonnet-4",
		systemPrompt: "You are {{name}}, engineer in the {{team}} workspace.",
		tools: ["tell", "who"],
	};
	loaded.config.repositories.repo = { url: originRepo, ref: "main" };
	loaded.config.workspaces.alpha = {
		room: "alpha",
		leader: "Alice",
		repositories: ["repo"],
		members: [
			{ name: "Alice", role: "engineer" },
			{ name: "Bob", role: "engineer" },
		],
	};
	return loaded;
}

describe("tmux orchestration command sequence", () => {
	let root: string;
	let originRepo: string;
	let loaded: LoadedConfig;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi2pi-tmux-start-"));
		originRepo = join(root, "origin");
		mkdirSync(originRepo, { recursive: true });
		git(["init", "--initial-branch=main"], originRepo);
		writeFileSync(join(originRepo, "README.md"), "# test\n", "utf8");
		git(["add", "."], originRepo);
		git(["commit", "-m", "initial"], originRepo);
		loaded = makeLoadedConfig(root, originRepo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("first command is has-session check, second is new-session with leadership window", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		expect(commands[0]).toEqual(["tmux", "has-session", "-t", "pi2pi-test"]);
		expect(commands[1]).toContain("new-session");
		expect(commands[1]).toContain("-s");
		expect(commands[1]).toContain("pi2pi-test");
		expect(commands[1]).toContain("-n");
		expect(commands[1]).toContain("leadership");
	});

	test("leadership window command contains pi with overlord flags", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		const newSession = commands[1];
		const shellCommand = newSession[newSession.length - 1];
		expect(shellCommand).toContain("pi");
		expect(shellCommand).toContain("--agent-name");
		expect(shellCommand).toContain("--rooms");
		expect(shellCommand).toContain("--append-system-prompt");
		// Full prompt must be present (not truncated)
		expect(shellCommand).toContain("coordinate across teams");
	});

	test("broker window is created with broker.ts entrypoint", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		const brokerWindow = commands.find(c => c.includes("new-window") && c.some(el => el.includes("broker")));
		expect(brokerWindow).toBeDefined();
		// The broker script path should be present somewhere in the command sequence
		const brokerPath = join(root, "broker.ts");
		expect(commands.some(c => c.some(el => el.includes(brokerPath)))).toBe(true);
	});

	test("workspace window is created with split panes for each member", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		expect(commands.some(c => c.includes("new-window") && c.includes("alpha"))).toBe(true);
		expect(commands.some(c => c.includes("split-window") && c.some(el => el.includes("pi2pi-test:alpha")))).toBe(true);
	});

	test("shell commands contain correct cwd and GIT_CEILING_DIRECTORIES for workspace agents", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		const worktreePath  = join(root, ".pi", "workspaces", "alpha", "repo");
		const workspaceRoot = join(root, ".pi", "workspaces", "alpha");
		const shellCommands = commands.flatMap(c => c.filter(el => el.includes("--agent-name")));
		expect(shellCommands.some(cmd => cmd.includes(`cd '${worktreePath}'`))).toBe(true);
		expect(shellCommands.some(cmd => cmd.includes(`export GIT_CEILING_DIRECTORIES='${workspaceRoot}'`))).toBe(true);
	});

	test("leader agent command includes leadership room binding", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		const shellCommands = commands.flatMap(c => c.filter(el => el.includes("--agent-name")));
		// Alice is the leader and should be bound to both team and leadership rooms
		const leaderCmd = shellCommands.find(cmd => cmd.includes("alpha.lead"));
		expect(leaderCmd).toBeDefined();
		expect(leaderCmd).toContain("leadership=");
	});

	test("no command in the sequence uses select-layout (all splits use explicit percentages)", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		expect(commands.some(c => c.includes("select-layout"))).toBe(false);
	});

	test("pane title commands are emitted for overlord, broker, and each team member", () => {
		const commands = buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		const titleCommands = commands.filter(c => c[1] === "select-pane" && c.includes("-T"));
		const titles = titleCommands.map(c => c[c.indexOf("-T") + 1]);
		expect(titles).toContain("overlord");
		expect(titles).toContain("broker");
		expect(titles).toContain("Alice");
		expect(titles).toContain("Bob");
	});

	test("embedded broker and extension files are written to configDir", () => {
		buildTmuxLikeCommandSequence(loaded, "tmux", "tmux");
		expect(existsSync(join(root, "broker.ts"))).toBe(true);
		expect(existsSync(join(root, "broker-ui.ts"))).toBe(true);
		expect(existsSync(join(root, "pi2pi.ts"))).toBe(true);
	});
});
