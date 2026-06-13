/**
 * tests/pit-init.test.ts
 *
 * Tests for:
 *   - pitHomeDir() / globalConfigPath() helpers
 *   - resolveDefaultConfigPath() (via loadConfig behaviour)
 *   - handleInit (via `bun cli.ts init` subprocess)
 */

import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { parse } from "yaml";
import { builtInDefaultRoles, pitHomeDir, globalConfigPath, loadConfig } from "../config-store";

// ── helpers ──────────────────────────────────────────────────────────────────

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pit-test-"));
}

// ── 1. pitHomeDir / globalConfigPath ─────────────────────────────────────────

describe("pitHomeDir and globalConfigPath", () => {
	test("pitHomeDir() returns ~/.pit", () => {
		expect(pitHomeDir()).toBe(join(homedir(), ".pit"));
	});

	test("globalConfigPath() returns ~/.pit/config.yaml", () => {
		expect(globalConfigPath()).toBe(join(homedir(), ".pit", "config.yaml"));
	});
});

// ── 2. resolveDefaultConfigPath (via loadConfig) ──────────────────────────────

describe("resolveDefaultConfigPath via loadConfig", () => {
	const savedCwd = process.cwd();

	afterEach(() => {
		// Always restore the working directory
		process.chdir(savedCwd);
	});

	test("uses local .pi/config.yaml when it exists in CWD", () => {
		const dir = tempDir();
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		const localConfig = join(piDir, "config.yaml");
		writeFileSync(localConfig, "version: 1\nroles: {}\nrepositories: {}\nworkspaces: {}\n", "utf8");

		process.chdir(dir);
		const loaded = loadConfig(); // no explicit path
		expect(loaded.configPath).toBe(realpathSync(resolve(localConfig)));

		process.chdir(savedCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	test("falls back to globalConfigPath() when no local .pi/config.yaml", () => {
		// chdir to a temp dir with no .pi subfolder
		const dir = tempDir();
		process.chdir(dir);

		const loaded = loadConfig(); // no explicit path
		// configPath should equal the global config path (even if it doesn't exist on disk yet)
		expect(loaded.configPath).toBe(resolve(globalConfigPath()));

		process.chdir(savedCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	test("explicit configPath always overrides resolution", () => {
		const dir = tempDir();
		const explicit = join(dir, "my-config.yaml");
		writeFileSync(explicit, "version: 1\nroles: {}\nrepositories: {}\nworkspaces: {}\n", "utf8");

		const loaded = loadConfig(explicit);
		expect(loaded.configPath).toBe(resolve(explicit));

		rmSync(dir, { recursive: true, force: true });
	});
});

// ── 3. handleInit integration ─────────────────────────────────────────────────

describe("pit init", () => {
	test("creates ~/.pit structure with absolute state paths in config", () => {
		const fakeHome = tempDir();

		const result = Bun.spawnSync(["bun", join(import.meta.dir, "../cli.ts"), "init"], {
			cwd: fakeHome,
			env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = Buffer.from(result.stdout).toString("utf8");
		const stderr = Buffer.from(result.stderr).toString("utf8");
		expect(result.exitCode).toBe(0);
		expect(stdout).toContain("Initialised pit at");
		expect(stderr).toBe("");

		const pitDir = join(fakeHome, ".pit");
		expect(existsSync(pitDir)).toBe(true);
		expect(existsSync(join(pitDir, "repos"))).toBe(true);
		expect(existsSync(join(pitDir, "workspaces"))).toBe(true);
		expect(existsSync(join(pitDir, "runtime"))).toBe(true);

		const configFile = join(pitDir, "config.yaml");
		expect(existsSync(configFile)).toBe(true);

		// Config should have absolute paths pointing into fakeHome/.pit/
		const cfg = parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		const state = cfg.state as Record<string, string>;
		const roles = (cfg as { roles: unknown }).roles;
		expect(state.reposRoot).toBe(join(pitDir, "repos"));
		expect(state.workspacesRoot).toBe(join(pitDir, "workspaces"));
		expect(state.runtimeRoot).toBe(join(pitDir, "runtime"));
		expect(roles).toEqual(builtInDefaultRoles() as unknown);

		rmSync(fakeHome, { recursive: true, force: true });
	});

	test("supports --config for init and seeds the default roles into the specified config home", () => {
		const fakeHome = tempDir();
		const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
		const customHome = join(fakeHome, "custom-pit-home");
		const customConfig = join(customHome, "config.yaml");
		const result = Bun.spawnSync(
			["bun", join(import.meta.dir, "../cli.ts"), "--config", customHome, "init"],
			{ cwd: fakeHome, env, stdout: "pipe", stderr: "pipe" }
		);

		expect(result.exitCode).toBe(0);
		expect(existsSync(customHome)).toBe(true);
		expect(existsSync(customConfig)).toBe(true);
		expect(existsSync(join(customHome, "repos"))).toBe(true);
		expect(existsSync(join(customHome, "workspaces"))).toBe(true);
		expect(existsSync(join(customHome, "runtime"))).toBe(true);
		expect(existsSync(join(fakeHome, ".pit"))).toBe(false);

		const cfg = parse(readFileSync(customConfig, "utf8")) as Record<string, unknown>;
		const state = cfg.state as Record<string, string>;
		const roles = (cfg as { roles: unknown }).roles;
		expect(state.reposRoot).toBe(join(customHome, "repos"));
		expect(state.workspacesRoot).toBe(join(customHome, "workspaces"));
		expect(state.runtimeRoot).toBe(join(customHome, "runtime"));
		expect(roles).toEqual(builtInDefaultRoles() as unknown);

		rmSync(fakeHome, { recursive: true, force: true });
	});

	test("second init prints 'already initialised' and leaves config unchanged", () => {
		const fakeHome = tempDir();
		const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
		const cliPath = join(import.meta.dir, "../cli.ts");

		// First init
		Bun.spawnSync(["bun", cliPath, "init"], { cwd: fakeHome, env, stdout: "pipe", stderr: "pipe" });

		const configFile = join(fakeHome, ".pit", "config.yaml");
		const contentBefore = readFileSync(configFile, "utf8");

		// Second init
		const r2 = Bun.spawnSync(["bun", cliPath, "init"], { cwd: fakeHome, env, stdout: "pipe", stderr: "pipe" });
		const stdout2 = Buffer.from(r2.stdout).toString("utf8");

		expect(r2.exitCode).toBe(0);
		expect(stdout2).toContain("already initialised");

		// Config must be unchanged
		const contentAfter = readFileSync(configFile, "utf8");
		expect(contentAfter).toBe(contentBefore);

		rmSync(fakeHome, { recursive: true, force: true });
	});

	test("pit init output lists all four paths", () => {
		const fakeHome = tempDir();
		const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
		const result = Bun.spawnSync(
			["bun", join(import.meta.dir, "../cli.ts"), "init"],
			{ cwd: fakeHome, env, stdout: "pipe", stderr: "pipe" }
		);
		const stdout = Buffer.from(result.stdout).toString("utf8");

		expect(stdout).toContain("config:");
		expect(stdout).toContain("repos:");
		expect(stdout).toContain("workspaces:");
		expect(stdout).toContain("runtime:");

		rmSync(fakeHome, { recursive: true, force: true });
	});
});
