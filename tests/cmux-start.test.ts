/**
 * cmux-start.test.ts
 *
 * Tests for the cmux orchestration path via buildCmuxWorkspaces, which writes
 * per-agent launch scripts and returns the workspace plan ready for cmux.
 * No real cmux installation required.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { buildCmuxWorkspaces, cmuxLayoutForCommands } from "../multiplexer";

// ── git helper ────────────────────────────────────────────────────────────────

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

// ── helpers ───────────────────────────────────────────────────────────────────

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
		systemPrompt: "You are {{name}}, an engineer in the {{team}} workspace.",
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

// Recursively collect all `command` values from a cmux layout node
function collectCommands(node: unknown): string[] {
	if (!node || typeof node !== "object") return [];
	const n = node as Record<string, unknown>;
	const commands: string[] = [];
	if (typeof n.command === "string") commands.push(n.command);
	for (const val of Object.values(n)) commands.push(...collectCommands(val));
	return commands;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cmux orchestration start", () => {
	let root: string;
	let originRepo: string;
	let loaded: LoadedConfig;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi2pi-cmux-"));
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

	test("writes an executable .sh script for each agent and the broker", () => {
		buildCmuxWorkspaces(loaded);

		const scriptsDir = join(root, ".pi", "runtime", "scripts");
		expect(existsSync(scriptsDir)).toBe(true);

		// Overlord script
		const overlordScript = join(scriptsDir, "orchestration-overlord.sh");
		expect(existsSync(overlordScript)).toBe(true);
		const overlordContent = readFileSync(overlordScript, "utf8");
		expect(overlordContent).toStartWith("#!/bin/sh\n");
		expect(overlordContent).toContain("--agent-name");
		expect(overlordContent).toContain("--rooms");
		expect(overlordContent).toContain("--append-system-prompt");
		// Full prompt must be present — not truncated
		expect(overlordContent).toContain("coordinate across teams");

		// Broker script
		expect(existsSync(join(scriptsDir, "broker.sh"))).toBe(true);

		// Workspace agent scripts
		expect(existsSync(join(scriptsDir, "alpha-Alice.sh"))).toBe(true);
		expect(existsSync(join(scriptsDir, "alpha-Bob.sh"))).toBe(true);

		// Agent script contains full system prompt
		const aliceContent = readFileSync(join(scriptsDir, "alpha-Alice.sh"), "utf8");
		expect(aliceContent).toContain("--append-system-prompt");
		expect(aliceContent).toContain("You are Alice");
	});

	test("workspace plan contains only short script paths, not inline commands", () => {
		const workspaces = buildCmuxWorkspaces(loaded);

		for (const workspace of workspaces) {
			const layout = cmuxLayoutForCommands(workspace.commands);
			for (const cmd of collectCommands(layout)) {
				// Must be a short quoted path to a .sh script
				expect(cmd).toMatch(/^'.*\.sh'$/);
				// Must NOT contain the inline pi command or system prompt
				expect(cmd).not.toContain("--append-system-prompt");
				expect(cmd).not.toContain("--agent-name");
				// Short enough that cmux keystroke delivery won't truncate it
				expect(cmd.length).toBeLessThan(300);
			}
		}
	});

	test("produces one workspace per logical unit (leadership, broker, each workspace)", () => {
		const workspaces = buildCmuxWorkspaces(loaded);

		// leadership + broker + alpha = 3
		expect(workspaces).toHaveLength(3);
		expect(workspaces.some(w => w.name === "leadership")).toBe(true);
		expect(workspaces.some(w => w.name === "broker")).toBe(true);
		expect(workspaces.some(w => w.name === "alpha")).toBe(true);
	});

	test("agent scripts are marked executable (chmod 755)", () => {
		buildCmuxWorkspaces(loaded);

		const scriptsDir = join(root, ".pi", "runtime", "scripts");
		for (const name of ["orchestration-overlord.sh", "broker.sh", "alpha-Alice.sh", "alpha-Bob.sh"]) {
			const scriptPath = join(scriptsDir, name);
			const mode = statSync(scriptPath).mode & 0o777;
			expect(mode).toBe(0o755);
		}
	});

	test("leader agent script binds to both team and leadership rooms", () => {
		buildCmuxWorkspaces(loaded);

		const aliceScript = readFileSync(join(root, ".pi", "runtime", "scripts", "alpha-Alice.sh"), "utf8");
		expect(aliceScript).toContain("team=alpha");
		expect(aliceScript).toContain("leadership=");
	});

	test("non-leader agent script only binds to the team room", () => {
		buildCmuxWorkspaces(loaded);

		const bobScript = readFileSync(join(root, ".pi", "runtime", "scripts", "alpha-Bob.sh"), "utf8");
		expect(bobScript).toContain("team=alpha");
		// Bob is not the leader, so no leadership room
		expect(bobScript).not.toContain("leadership=");
	});

	test("overlord script targets the leadership room", () => {
		buildCmuxWorkspaces(loaded);

		const overlordScript = readFileSync(join(root, ".pi", "runtime", "scripts", "orchestration-overlord.sh"), "utf8");
		expect(overlordScript).toContain("leadership=");
		// Overlord should not be in a team workspace room
		expect(overlordScript).not.toContain("team=alpha");
	});
});
