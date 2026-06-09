import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { LoadedConfig } from "./config-store";
import { ensureStateDirectories, orchestrationSessionName } from "./config-store";
import { buildOverlordArgs, createWorkspaceLaunchSpecs } from "./process-manager";
import { ensureWorkspaceLayout } from "./workspace-manager";

export type MultiplexerKind = "psmux" | "tmux" | "cmux";

export interface MultiplexerAvailability {
	psmux?: boolean;
	tmux?: boolean;
	cmux?: boolean;
	cmuxResponsive?: boolean;
}

export interface SelectedMultiplexer {
	kind: MultiplexerKind;
	executable: string;
}

interface TeamWindowPlan {
	name: string;
	cwd: string;
	commands: string[];
}

function shellEsc(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function psEsc(arg: string): string {
	return `'${arg.replace(/'/g, "''")}'`;
}

function findExecutable(name: string): string | null {
	const isWindows = process.platform === "win32";
	const findExe = isWindows ? "where" : "which";
	try {
		const result = Bun.spawnSync([findExe, name], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		const output = Buffer.from(result.stdout).toString("utf8");
		return output.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
	} catch {
		return null;
	}
}

function runOrThrow(command: string[], cwd?: string): string {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const stderr = Buffer.from(result.stderr).toString("utf8").trim();
		const stdout = Buffer.from(result.stdout).toString("utf8").trim();
		throw new Error(stderr || stdout || `${command[0]} exited with code ${result.exitCode}`);
	}
	return Buffer.from(result.stdout).toString("utf8").trim();
}

function commandExists(name: string): boolean {
	return !!findExecutable(name);
}

function cmuxResponsive(executable: string): boolean {
	try {
		return Bun.spawnSync([executable, "ping"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

export function selectMultiplexerKind(platform: NodeJS.Platform, availability: MultiplexerAvailability): MultiplexerKind {
	if (platform === "win32") {
		if (availability.psmux) return "psmux";
		throw new Error("psmux is required on Windows but was not found in PATH.");
	}
	if (platform === "darwin") {
		if (availability.cmux && availability.cmuxResponsive) return "cmux";
		if (availability.tmux) return "tmux";
		throw new Error("On macOS, pi2pi requires cmux (running and responsive) or tmux.");
	}
	if (platform === "linux") {
		if (availability.tmux) return "tmux";
		throw new Error("tmux is required on Linux but was not found in PATH.");
	}
	throw new Error(`Unsupported platform: ${platform}`);
}

export function resolveMultiplexer(): SelectedMultiplexer {
	const psmux = findExecutable("psmux") ?? findExecutable("pmux");
	const tmux = findExecutable("tmux");
	const cmux = findExecutable("cmux");
	const kind = selectMultiplexerKind(process.platform, {
		psmux: !!psmux,
		tmux: !!tmux,
		cmux: !!cmux,
		cmuxResponsive: cmux ? cmuxResponsive(cmux) : false,
	});

	if (kind === "psmux") return { kind, executable: psmux! };
	if (kind === "tmux") return { kind, executable: tmux! };
	return { kind, executable: cmux! };
}

function orderedWorkspaceCommands(loaded: LoadedConfig, workspaceName: string, forWindowsShell: boolean): TeamWindowPlan {
	const layout = ensureWorkspaceLayout(loaded, workspaceName);
	const specs = createWorkspaceLaunchSpecs(loaded, workspaceName);
	const orderedSpecs = [...specs].sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
	return {
		name: workspaceName,
		cwd: layout.workspaceRoot,
		commands: orderedSpecs.map(spec => buildLaunchCommand(loaded, `${workspaceName}-${spec.memberName}`, spec.args, forWindowsShell)),
	};
}

function buildLaunchCommand(loaded: LoadedConfig, key: string, args: string[], forWindowsShell: boolean): string {
	if (!forWindowsShell) {
		return "clear && " + args.map(shellEsc).join(" ");
	}

	const { runtimeRoot } = ensureStateDirectories(loaded);
	const scriptsDir = join(runtimeRoot, "launch-scripts");
	mkdirSync(scriptsDir, { recursive: true });
	const scriptPath = join(scriptsDir, `${key}.ps1`);
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Clear-Host",
		`& ${args.map(psEsc).join(" ")}`,
	].join("\n") + "\n";
	writeFileSync(scriptPath, script, "utf8");

	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const powershellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const powershellExe = existsSync(powershellPath) ? powershellPath : "powershell";
	return `& ${psEsc(powershellExe)} -NoExit -NoProfile -ExecutionPolicy Bypass -File ${psEsc(scriptPath)}`;
}

function buildTmuxLikePlan(loaded: LoadedConfig, forWindowsShell: boolean) {
	const sessionName = orchestrationSessionName(loaded.config);
	const leadershipCommand = buildLaunchCommand(loaded, "overlord", buildOverlordArgs(loaded), forWindowsShell);
	const teamWindows = Object.keys(loaded.config.workspaces).sort().map(name => orderedWorkspaceCommands(loaded, name, forWindowsShell));
	return {
		sessionName,
		leadership: {
			name: "leadership",
			cwd: loaded.configDir,
			command: leadershipCommand,
		},
		teamWindows,
	};
}

export function buildTmuxLikeCommandSequence(loaded: LoadedConfig, executable: string, kind: "tmux" | "psmux"): string[][] {
	const plan = buildTmuxLikePlan(loaded, kind === "psmux");
	const commands: string[][] = [];
	commands.push([executable, "has-session", "-t", plan.sessionName]);
	commands.push([executable, "new-session", "-d", "-s", plan.sessionName, "-n", plan.leadership.name, "-c", plan.leadership.cwd, plan.leadership.command]);

	for (const window of plan.teamWindows) {
		const [leader, ...others] = window.commands;
		commands.push([executable, "new-window", "-t", plan.sessionName, "-n", window.name, "-c", window.cwd, leader]);
		for (const command of others) {
			commands.push([executable, "split-window", "-t", `${plan.sessionName}:${window.name}`, "-c", window.cwd, command]);
		}
		if (others.length > 0) {
			commands.push([executable, "select-pane", "-t", `${plan.sessionName}:${window.name}.0`]);
			commands.push([executable, "select-layout", "-t", `${plan.sessionName}:${window.name}`, "main-vertical"]);
		}
	}

	return commands;
}

function runTmuxLikeStart(loaded: LoadedConfig, mux: SelectedMultiplexer): void {
	const sessionName = orchestrationSessionName(loaded.config);
	const commands = buildTmuxLikeCommandSequence(loaded, mux.executable, mux.kind as "tmux" | "psmux");
	const hasSession = Bun.spawnSync(commands[0], { stdout: "ignore", stderr: "ignore" });
	if (hasSession.exitCode === 0) {
		throw new Error(`A ${mux.kind} session named \"${sessionName}\" already exists.`);
	}
	for (const command of commands.slice(1)) runOrThrow(command);
	attachOrchestration(loaded, mux);
}

function cmuxLayoutForCommands(commands: string[]) {
	type LayoutNode =
		| { pane: { surfaces: [{ type: "terminal"; command: string }] } }
		| { direction: "horizontal" | "vertical"; split: number; children: [LayoutNode, LayoutNode] };

	function pane(cmd: string): LayoutNode {
		return { pane: { surfaces: [{ type: "terminal", command: cmd }] } };
	}

	function verticalStack(cmds: string[]): LayoutNode {
		if (cmds.length === 1) return pane(cmds[0]);
		return {
			direction: "vertical",
			split: 1 / cmds.length,
			children: [pane(cmds[0]), verticalStack(cmds.slice(1))],
		};
	}

	if (commands.length === 1) return pane(commands[0]);
	const [first, ...rest] = commands;
	return {
		direction: "horizontal",
		split: 0.5,
		children: [pane(first), verticalStack(rest)],
	};
}

function runCmuxStart(loaded: LoadedConfig, mux: SelectedMultiplexer): void {
	const leadershipCommand = buildLaunchCommand(loaded, "overlord", buildOverlordArgs(loaded), false);
	const workspaces = [
		{ name: "leadership", cwd: loaded.configDir, commands: [leadershipCommand] },
		...Object.keys(loaded.config.workspaces).sort().map(name => orderedWorkspaceCommands(loaded, name, false)),
	];

	for (const workspace of workspaces) {
		runOrThrow([mux.executable, "new-window"]);
		runOrThrow([
			mux.executable,
			"new-workspace",
			"--name", workspace.name,
			"--cwd", workspace.cwd,
			"--layout", JSON.stringify(cmuxLayoutForCommands(workspace.commands)),
			"--focus", "true",
		]);
	}
}

export function startOrchestration(loaded: LoadedConfig): SelectedMultiplexer {
	const mux = resolveMultiplexer();
	if (mux.kind === "cmux") {
		runCmuxStart(loaded, mux);
		return mux;
	}
	runTmuxLikeStart(loaded, mux);
	return mux;
}

export function attachOrchestration(loaded: LoadedConfig, muxOverride?: SelectedMultiplexer): SelectedMultiplexer {
	const mux = muxOverride ?? resolveMultiplexer();
	if (mux.kind === "cmux") {
		if (process.platform === "darwin") {
			Bun.spawnSync(["open", "-a", "cmux"]);
		}
		return mux;
	}
	const sessionName = orchestrationSessionName(loaded.config);
	const insideMux = !!process.env.TMUX;
	const command = insideMux
		? [mux.executable, "switch-client", "-t", sessionName]
		: [mux.executable, "attach-session", "-t", sessionName];
	runOrThrow(command);
	return mux;
}

export function stopOrchestration(loaded: LoadedConfig): SelectedMultiplexer {
	const mux = resolveMultiplexer();
	if (mux.kind === "cmux") {
		throw new Error("Stopping cmux-created windows is not yet supported; close them in cmux manually.");
	}
	runOrThrow([mux.executable, "kill-session", "-t", orchestrationSessionName(loaded.config)]);
	return mux;
}

export function orchestrationStatus(loaded: LoadedConfig): { backend: MultiplexerKind; available: boolean; sessionName: string } {
	const mux = resolveMultiplexer();
	if (mux.kind === "cmux") {
		return { backend: mux.kind, available: true, sessionName: orchestrationSessionName(loaded.config) };
	}
	const result = Bun.spawnSync([mux.executable, "has-session", "-t", orchestrationSessionName(loaded.config)], { stdout: "ignore", stderr: "ignore" });
	return { backend: mux.kind, available: result.exitCode === 0, sessionName: orchestrationSessionName(loaded.config) };
}
