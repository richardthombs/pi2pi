import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(import.meta.dir, "../cli.ts");
const tmpDirs: string[] = [];

function tmpRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi2pi-cli-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function run(args: string[], cwd: string, envOverride?: Record<string, string>) {
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: envOverride ? { ...process.env, ...envOverride } : undefined,
	});
	return {
		exitCode: proc.exitCode,
		stdout: Buffer.from(proc.stdout).toString("utf8"),
		stderr: Buffer.from(proc.stderr).toString("utf8"),
	};
}

describe("cli", () => {
	test("can create shared roles, repos, and workspaces from commands", () => {
		const cwd = tmpRoot();
		const configPath = join(cwd, "config.yaml");

		expect(run(["--config", configPath, "roles", "add", "manager", "gpt-4o", "Project Manager"], cwd).exitCode).toBe(0);
		expect(run(["--config", configPath, "repos", "add", "https://github.com/richardthombs/pi2pi.git"], cwd).exitCode).toBe(0);
		expect(run(["--config", configPath, "orchestration", "set", "leadership-room", "leadership"], cwd).exitCode).toBe(0);
		expect(run(["--config", configPath, "workspace", "create", "engineering"], cwd).exitCode).toBe(0);
		expect(run(["--config", configPath, "workspace", "engineering", "add", "repo", "pi2pi"], cwd).exitCode).toBe(0);
		expect(run(["--config", configPath, "workspace", "engineering", "add", "member", "Alice", "manager"], cwd).exitCode).toBe(0);
		expect(run(["--config", configPath, "workspace", "engineering", "set", "leader", "Alice"], cwd).exitCode).toBe(0);

		const saved = readFileSync(configPath, "utf8");
		expect(saved).toContain("orchestration:");
		expect(saved).toContain("roles:");
		expect(saved).toContain("manager:");
		expect(saved).toContain("repositories:");
		expect(saved).toContain("pi2pi:");
		expect(saved).toContain("workspaces:");
		expect(saved).toContain("engineering:");
		expect(saved).toContain("leader: Alice");
		expect(saved).toContain("Alice");
	});

	test("orchestration show prints resolved extension and broker script paths", () => {
		const cwd = tmpRoot();
		const configPath = join(cwd, "config.yaml");

		expect(run(["--config", cwd, "init"], cwd).exitCode).toBe(0);
		const result = run(["--config", configPath, "orchestration", "show"], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`Config directory: ${cwd}`);
		expect(result.stdout).toContain(`Pi2Pi extension: ${join(cwd, "pi2pi.ts")}`);
		expect(result.stdout).toContain(`Broker script: ${join(cwd, "broker.ts")}`);
		expect(existsSync(join(cwd, "pi2pi.ts"))).toBe(true);
		expect(existsSync(join(cwd, "broker.ts"))).toBe(true);
	});
});

// ── helpers ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
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

/** Create a config dir with a workspace fully wired up, ready for orchestration. */
function makeOrchestrationConfig(cwd: string): { configPath: string; originRepo: string; fakeDir: string } {
	const configPath = join(cwd, "config.yaml");
	const originRepo = join(cwd, "origin.git");
	mkdirSync(originRepo, { recursive: true });
	git(["init", "--initial-branch=main"], originRepo);
	writeFileSync(join(originRepo, "README.md"), "# test\n", "utf8");
	git(["add", "."], originRepo);
	git(["commit", "-m", "initial"], originRepo);

	// Create a fake cmux/tmux that records calls without doing anything real.
	// Prepend fakeDir to PATH so resolveMultiplexer() finds it.
	const fakeDir = join(cwd, "fake-bins");
	mkdirSync(fakeDir, { recursive: true });
	const logPath = join(fakeDir, "calls.log");

	for (const name of ["cmux", "tmux"]) {
		const fakeBin = join(fakeDir, name);
		writeFileSync(fakeBin, [
			"#!/bin/sh",
			`printf '%s\\t' "$@" >> '${logPath}'`,
			`printf '\\n' >> '${logPath}'`,
			'if [ "$1" = "ping" ]; then echo PONG; fi',
			'if [ "$1" = "has-session" ]; then exit 1; fi', // no session exists yet
		].join("\n"), "utf8");
		chmodSync(fakeBin, 0o755);
	}

	run(["--config", configPath, "init"], cwd);
	run(["--config", configPath, "roles", "add", "engineer", "gpt-4o"], cwd);
	run(["--config", configPath, "repos", "add", originRepo, "myrepo"], cwd);
	run(["--config", configPath, "workspace", "create", "alpha"], cwd);
	run(["--config", configPath, "workspace", "alpha", "add", "repo", "myrepo"], cwd);
	run(["--config", configPath, "workspace", "alpha", "add", "member", "Alice", "engineer"], cwd);
	run(["--config", configPath, "workspace", "alpha", "set", "leader", "Alice"], cwd);

	return { configPath, originRepo, fakeDir };
}

// ── orchestration CLI tests ───────────────────────────────────────────────────

describe("cli orchestration commands", () => {
	test("orchestration status reports backend and session name", () => {
		const cwd = tmpRoot();
		const { configPath } = makeOrchestrationConfig(cwd);

		const result = run(["--config", configPath, "orchestration", "status"], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/Backend:\s+(tmux|cmux|psmux)/);
		expect(result.stdout).toContain("Session:");
		expect(result.stdout).toMatch(/Available:\s+(yes|no)/);
	});

	test("overlord command prints the pi launch flags", () => {
		const cwd = tmpRoot();
		const { configPath } = makeOrchestrationConfig(cwd);

		const result = run(["--config", configPath, "overlord", "command"], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("pi");
		expect(result.stdout).toContain("--agent-name");
		expect(result.stdout).toContain("--rooms");
		expect(result.stdout).toContain("--session-dir");
		expect(result.stdout).toContain("--append-system-prompt");
	});

	test("orchestration start succeeds with a fake multiplexer on PATH", () => {
		const cwd = tmpRoot();
		const { configPath, fakeDir } = makeOrchestrationConfig(cwd);

		const result = run(["--config", configPath, "orchestration", "start"], cwd, {
			PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/Started orchestration using (tmux|cmux)/);
	});

	test("orchestration start writes launch scripts for cmux path", () => {
		const cwd = tmpRoot();
		const { configPath, fakeDir } = makeOrchestrationConfig(cwd);

		// Ensure cmux is preferred by making it respond to ping
		run(["--config", configPath, "orchestration", "start"], cwd, {
			PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
		});

		// If cmux was selected, scripts dir should exist
		// scripts are always written under the config dir's runtime root
		const scriptsDir = join(cwd, "runtime", "scripts");
		const muxCalls = join(fakeDir, "calls.log");
		if (existsSync(muxCalls)) {
			const log = readFileSync(muxCalls, "utf8");
			if (log.includes("new-workspace")) {
				// cmux path was taken — scripts must exist
				expect(existsSync(scriptsDir)).toBe(true);
				const scriptFiles = Bun.spawnSync(["ls", scriptsDir], { stdout: "pipe" });
				expect(Buffer.from(scriptFiles.stdout).toString()).toContain(".sh");
			}
		}
	});
});

// ── workspace status CLI tests ────────────────────────────────────────────────

describe("cli workspace status", () => {
	test("workspace status lists members with leader flag and rooms", () => {
		const cwd = tmpRoot();
		const { configPath } = makeOrchestrationConfig(cwd);

		const result = run(["--config", configPath, "workspace", "alpha", "status"], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Workspace: alpha");
		expect(result.stdout).toContain("Alice");
		expect(result.stdout).toContain("leader");
		expect(result.stdout).toContain("rooms=");
	});

	test("workspace status shows stopped for agents that are not running", () => {
		const cwd = tmpRoot();
		const { configPath } = makeOrchestrationConfig(cwd);

		const result = run(["--config", configPath, "workspace", "alpha", "status"], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stopped");
	});

	test("workspace status exits with error for unknown workspace", () => {
		const cwd = tmpRoot();
		const configPath = join(cwd, "config.yaml");
		run(["--config", configPath, "init"], cwd);

		const result = run(["--config", configPath, "workspace", "nonexistent", "status"], cwd);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("nonexistent");
	});
});
