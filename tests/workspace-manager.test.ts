import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { ensureWorkspaceLayout } from "../workspace-manager";

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
	if (proc.exitCode !== 0) {
		throw new Error(Buffer.from(proc.stderr).toString("utf8"));
	}
	return Buffer.from(proc.stdout).toString("utf8").trim();
}

describe("workspace-manager", () => {
	let root: string;
	let originRepo: string;
	let loaded: LoadedConfig;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi2pi-worktree-"));
		originRepo = join(root, "origin");
		mkdirSync(originRepo, { recursive: true });
		git(["init", "--initial-branch=main"], originRepo);
		writeFileSync(join(originRepo, "README.md"), "# test\n", "utf8");
		git(["add", "."], originRepo);
		git(["commit", "-m", "initial"], originRepo);

		loaded = {
			configPath: join(root, "config.yaml"),
			configDir: root,
			config: defaultConfig(),
		};
		loaded.config.repositories.sample = { url: originRepo, ref: "main" };
		loaded.config.workspaces.alpha = { repositories: ["sample"], members: [] };
		loaded.config.workspaces.beta = { repositories: ["sample"], members: [] };
	});

	test("creates one shared clone and a worktree per workspace", () => {
		const alpha = ensureWorkspaceLayout(loaded, "alpha");
		const beta = ensureWorkspaceLayout(loaded, "beta");

		expect(alpha.workspaceRoot).toContain(join(".pi", "workspaces", "alpha"));
		expect(beta.workspaceRoot).toContain(join(".pi", "workspaces", "beta"));

		const cacheRepo = join(root, ".pi", "repos", "sample");
		expect(Bun.file(join(cacheRepo, ".git", "HEAD")).size).toBeGreaterThan(0);
		expect(Bun.file(join(alpha.repoPaths.sample, ".git")).size).toBeGreaterThan(0);
		expect(Bun.file(join(beta.repoPaths.sample, ".git")).size).toBeGreaterThan(0);

		expect(git(["branch", "--show-current"], alpha.repoPaths.sample)).toBe("team/alpha");
		expect(git(["branch", "--show-current"], beta.repoPaths.sample)).toBe("team/beta");
	});
});
