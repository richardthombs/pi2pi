import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { LoadedConfig } from "./config-store";
import { assertSimpleKey, ensureStateDirectories } from "./config-store";

export interface WorkspaceLayout {
	workspaceRoot: string;
	repoPaths: Record<string, string>;
}

function runGit(args: string[], cwd?: string): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	if (proc.exitCode !== 0) {
		const stderr = Buffer.from(proc.stderr).toString("utf8").trim();
		const stdout = Buffer.from(proc.stdout).toString("utf8").trim();
		const detail = stderr || stdout || `git exited with code ${proc.exitCode}`;
		throw new Error(`git ${args.join(" ")} failed${cwd ? ` (cwd: ${cwd})` : ""}: ${detail}`);
	}

	return Buffer.from(proc.stdout).toString("utf8").trim();
}

function localRepoPath(loaded: LoadedConfig, repoName: string): string {
	const { reposRoot } = ensureStateDirectories(loaded);
	return join(reposRoot, repoName);
}

export function workspaceRootPath(loaded: LoadedConfig, workspaceName: string): string {
	const { workspacesRoot } = ensureStateDirectories(loaded);
	return join(workspacesRoot, workspaceName);
}

export function workspaceBranchName(workspaceName: string): string {
	assertSimpleKey("workspace name", workspaceName);
	return `team/${workspaceName}`;
}

export function ensureRepoCache(loaded: LoadedConfig, repoName: string): string {
	assertSimpleKey("repository name", repoName);
	const repo = loaded.config.repositories[repoName];
	if (!repo) throw new Error(`Unknown repository: ${repoName}`);

	const repoPath = localRepoPath(loaded, repoName);
	if (!existsSync(repoPath)) {
		runGit(["clone", repo.url, repoPath]);
	}

	runGit(["fetch", "--all", "--prune"], repoPath);
	return repoPath;
}

export function ensureWorkspaceRepoWorktree(loaded: LoadedConfig, workspaceName: string, repoName: string): string {
	assertSimpleKey("workspace name", workspaceName);
	assertSimpleKey("repository name", repoName);
	const repo = loaded.config.repositories[repoName];
	if (!repo) throw new Error(`Unknown repository: ${repoName}`);

	const repoPath = ensureRepoCache(loaded, repoName);
	const workspaceRoot = workspaceRootPath(loaded, workspaceName);
	const worktreePath = join(workspaceRoot, repoName);
	const branch = workspaceBranchName(workspaceName);
	const baseRef = repo.ref ?? "main";
	const remoteRef = `origin/${baseRef}`;

	mkdirSync(workspaceRoot, { recursive: true });

	if (existsSync(worktreePath)) {
		return worktreePath;
	}

	const localBranchExists = Bun.spawnSync([
		"git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`,
	], { cwd: repoPath }).exitCode === 0;

	if (localBranchExists) {
		runGit(["worktree", "add", worktreePath, branch], repoPath);
	} else {
		runGit(["worktree", "add", "-b", branch, worktreePath, remoteRef], repoPath);
	}

	return worktreePath;
}

export function ensureWorkspaceLayout(loaded: LoadedConfig, workspaceName: string): WorkspaceLayout {
	assertSimpleKey("workspace name", workspaceName);
	const workspace = loaded.config.workspaces[workspaceName];
	if (!workspace) throw new Error(`Unknown workspace: ${workspaceName}`);

	const workspaceRoot = workspaceRootPath(loaded, workspaceName);
	mkdirSync(workspaceRoot, { recursive: true });

	const repoPaths: Record<string, string> = {};
	for (const repoName of workspace.repositories) {
		repoPaths[repoName] = ensureWorkspaceRepoWorktree(loaded, workspaceName, repoName);
	}

	return { workspaceRoot, repoPaths };
}
