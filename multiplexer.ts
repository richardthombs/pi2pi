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

interface SingleCommandWindowPlan {
	name: string;
	cwd: string;
	command: string;
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

function localBrokerArgs(loaded: LoadedConfig): string[] | null {
	const brokerUrl = loaded.config.orchestration.broker ?? "ws://localhost:7331";
	let parsed: URL;
	try {
		parsed = new URL(brokerUrl);
	} catch {
		return null;
	}
	const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
	if (parsed.protocol !== "ws:" || !localHosts.has(parsed.hostname)) return null;
	const port = parsed.port ? Number(parsed.port) : 7331;
	return ["bun", "broker.ts", "--port", String(Number.isFinite(port) ? port : 7331)];
}

function buildTmuxLikePlan(loaded: LoadedConfig, forWindowsShell: boolean) {
	const sessionName = orchestrationSessionName(loaded.config);
	const leadershipCommand = buildLaunchCommand(loaded, "overlord", buildOverlordArgs(loaded), forWindowsShell);
	const brokerArgs = localBrokerArgs(loaded);
	const brokerWindow = brokerArgs
		? {
			name: "broker",
			cwd: loaded.projectRoot,
			command: buildLaunchCommand(loaded, "broker", brokerArgs, forWindowsShell),
		}
		: null;
	const teamWindows = Object.keys(loaded.config.workspaces).sort().map(name => orderedWorkspaceCommands(loaded, name, forWindowsShell));
	return {
		sessionName,
		leadership: {
			name: "leadership",
			cwd: loaded.projectRoot,
			command: leadershipCommand,
		},
		brokerWindow,
		teamWindows,
	};
}

function tmuxLikeSessionSize(plan: ReturnType<typeof buildTmuxLikePlan>): { width: number; height: number } {
	const widestTeam = Math.max(1, ...plan.teamWindows.map(window => window.commands.length));
	const requiredRightPanes = Math.max(1, widestTeam - 1);
	const minHeight = Math.max(30, requiredRightPanes * 6 + 6);
	const width = Math.max(process.stdout.columns || 0, 160);
	const height = Math.max(process.stdout.rows || 0, minHeight);
	return { width, height };
}

export function buildTmuxLikeCommandSequence(loaded: LoadedConfig, executable: string, kind: "tmux" | "psmux"): string[][] {
	const plan = buildTmuxLikePlan(loaded, kind === "psmux");
	const size = tmuxLikeSessionSize(plan);
	const commands: string[][] = [];
	commands.push([executable, "has-session", "-t", plan.sessionName]);
	commands.push([
		executable,
		"new-session",
		"-d",
		"-s", plan.sessionName,
		"-n", plan.leadership.name,
		"-c", plan.leadership.cwd,
		"-x", String(size.width),
		"-y", String(size.height),
		plan.leadership.command,
	]);
	commands.push([executable, "set-option", "-t", plan.sessionName, "-g", "extended-keys", "on"]);

	if (plan.brokerWindow) {
		commands.push([
			executable,
			"new-window",
			"-t", plan.sessionName,
			"-n", plan.brokerWindow.name,
			"-c", plan.brokerWindow.cwd,
			plan.brokerWindow.command,
		]);
	}

	for (const window of plan.teamWindows) {
		const n = window.commands.length;
		const winTarget = `${plan.sessionName}:${window.name}`;

		// Always create window with leader (first command)
		commands.push([executable, "new-window", "-t", plan.sessionName, "-n", window.name, "-c", window.cwd, window.commands[0]]);

		if (n > 1) {
			// Compute balanced column layout
			const rowsMax = Math.ceil(Math.sqrt(n));
			const cols    = Math.ceil(n / rowsMax);
			const base    = Math.floor(n / cols);
			const extra   = n % cols;
			// leftmost (cols-extra) columns get base panes; rightmost extra columns get base+1
			const colSizes = Array.from({ length: cols }, (_, i) => i < cols - extra ? base : base + 1);

			// Assign commands to columns
			let offset = 0;
			const colCmds = colSizes.map(size => {
				const slice = window.commands.slice(offset, offset + size);
				offset += size;
				return slice;
			});

			// Track pane indices (tmux assigns sequential indices 0, 1, 2, …)
			let nextPane = 1;
			const colAnchor: number[] = [0]; // pane index of first pane in each column

			// Phase 1: carve equal-width columns via horizontal splits
			// p% goes to the NEW right pane; (100-p)% stays with current pane = one column
			let rightmostZone = 0;
			let remainingCols = cols;
			for (let j = 1; j < cols; j++) {
				const p = Math.round((remainingCols - 1) * 100 / remainingCols);
				commands.push([
					executable, "split-window",
					"-t", `${winTarget}.${rightmostZone}`,
					"-h", "-p", String(p),
					"-c", window.cwd,
					colCmds[j][0],
				]);
				colAnchor.push(nextPane);
				rightmostZone = nextPane++;
				remainingCols--;
			}

			// Phase 2: fill each column with its remaining panes via vertical splits
			for (let j = 0; j < cols; j++) {
				const s = colSizes[j];
				let currentPane = colAnchor[j];
				for (let k = 1; k < s; k++) {
					// p% goes to NEW bottom pane; current pane keeps (100-p)% = 1/s of column height
					const p = Math.round((s - k) * 100 / (s - k + 1));
					commands.push([
						executable, "split-window",
						"-t", `${winTarget}.${currentPane}`,
						"-v", "-p", String(p),
						"-c", window.cwd,
						colCmds[j][k],
					]);
					currentPane = nextPane++;
				}
			}

			// Focus leader pane (top-left = pane 0)
			commands.push([executable, "select-pane", "-t", `${winTarget}.0`]);
			// No select-layout — exact layout is set by the splits above
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

export function cmuxLayoutForCommands(commands: string[]) {
	type LayoutNode =
		| { pane: { surfaces: [{ type: "terminal"; command: string }] } }
		| { direction: "horizontal" | "vertical"; split: number; children: [LayoutNode, LayoutNode] };

	function pane(cmd: string): LayoutNode {
		return { pane: { surfaces: [{ type: "terminal", command: cmd }] } };
	}

	// Stack cmds vertically with equal height splits
	function buildColumn(cmds: string[]): LayoutNode {
		if (cmds.length === 1) return pane(cmds[0]);
		return {
			direction: "vertical",
			split: 1 / cmds.length,
			children: [pane(cmds[0]), buildColumn(cmds.slice(1))],
		};
	}

	// Build `cols` equal-width columns from cmds, distributing extras to rightmost
	function buildColumns(cmds: string[], cols: number): LayoutNode {
		const base = Math.floor(cmds.length / cols);
		const extra = cmds.length % cols;
		// leftmost (cols-extra) columns get base panes; rightmost extra get base+1
		const firstSize = cols > extra ? base : base + 1;
		const first = cmds.slice(0, firstSize);
		const rest  = cmds.slice(firstSize);
		if (cols === 1 || rest.length === 0) return buildColumn(first);
		return {
			direction: "horizontal",
			split: 1 / cols,
			children: [buildColumn(first), buildColumns(rest, cols - 1)],
		};
	}

	const n = commands.length;
	if (n === 0) throw new Error("cmuxLayoutForCommands: no commands");
	if (n === 1) return pane(commands[0]);

	const rowsMax = Math.ceil(Math.sqrt(n));
	const cols    = Math.ceil(n / rowsMax);
	return buildColumns(commands, cols);
}

function runCmuxStart(loaded: LoadedConfig, mux: SelectedMultiplexer): void {
	const leadershipCommand = buildLaunchCommand(loaded, "overlord", buildOverlordArgs(loaded), false);
	const brokerArgs = localBrokerArgs(loaded);
	const workspaces = [
		{ name: "leadership", cwd: loaded.projectRoot, commands: [leadershipCommand] },
		...(brokerArgs ? [{ name: "broker", cwd: loaded.projectRoot, commands: [buildLaunchCommand(loaded, "broker", brokerArgs, false)] }] : []),
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
