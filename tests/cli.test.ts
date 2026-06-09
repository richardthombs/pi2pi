import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
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

function run(args: string[], cwd: string) {
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
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
});
