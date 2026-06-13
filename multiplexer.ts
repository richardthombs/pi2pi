import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import embeddedBrokerSource from "./broker.ts" with { type: "text" };
import embeddedBrokerUiSource from "./broker-ui.ts" with { type: "text" };
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

interface PaneLaunchCommand {
	cwd: string;
	gitCeilingDir?: string;
	command: string;
	title?: string;
}

interface TeamWindowPlan {
	name: string;
	cwd: string;
	commands: PaneLaunchCommand[];
}

interface SingleCommandWindowPlan {
	name: string;
	cwd: string;
	command: string;
	title?: string;
}

function shellEsc(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function psEsc(arg: string): string {
	return `'${arg.replace(/'/g, "''")}'`;
}

function psMultilineLiteral(text: string): string {
	if (!text.includes("\n") && !text.includes("\r")) return psEsc(text);
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n").map(psEsc);
	return `(@(${lines.join(", ")}) -join [Environment]::NewLine)`;
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
		commands: orderedSpecs.map(spec => ({
			cwd: spec.cwd,
			gitCeilingDir: spec.gitCeilingDir,
			command: buildLaunchCommand(loaded, `${workspaceName}-${spec.memberName}`, spec.args, forWindowsShell, spec.cwd, spec.gitCeilingDir),
			title: spec.memberName,
		})),
	};
}

function buildLaunchCommand(
	loaded: LoadedConfig,
	key: string,
	args: string[],
	forWindowsShell: boolean,
	cwd?: string,
	gitCeilingDir?: string,
): string {
	if (!forWindowsShell) {
		const steps: string[] = [];
		if (gitCeilingDir) steps.push(`export GIT_CEILING_DIRECTORIES=${shellEsc(gitCeilingDir)}`);
		if (cwd) steps.push(`cd ${shellEsc(cwd)}`);
		steps.push("clear");
		steps.push(args.map(shellEsc).join(" "));
		return steps.join(" && ");
	}

	const appendPromptIndex = args.indexOf("--append-system-prompt");
	const commandEntries = args.map(psEsc);
	if (commandEntries.length > 0) commandEntries[0] = `& ${commandEntries[0]}`;
	const setupLines = [
		"$ErrorActionPreference = 'Stop'",
		...(gitCeilingDir ? [`$env:GIT_CEILING_DIRECTORIES = ${psEsc(gitCeilingDir)}`] : []),
		...(cwd ? [`Set-Location -LiteralPath ${psEsc(cwd)}`] : []),
	];
	if (appendPromptIndex !== -1 && appendPromptIndex + 1 < args.length) {
		setupLines.push(`$appendSystemPrompt = ${psMultilineLiteral(args[appendPromptIndex + 1])}`);
		commandEntries[appendPromptIndex + 1] = "$appendSystemPrompt";
	}
	setupLines.push("Clear-Host");
	setupLines.push(commandEntries.join(" "));
	
	return setupLines.join("; ");
}

function normalizePaneCommands(commands: Array<PaneLaunchCommand | string>, defaultCwd = "."): PaneLaunchCommand[] {
	return commands.map(command => typeof command === "string" ? { cwd: defaultCwd, command } : command);
}

function paneTitleCommands(executable: string, target: string, title?: string): string[][] {
	return title ? [[executable, "select-pane", "-t", target, "-T", title]] : [];
}

export function ensureBrokerEntrypoint(loaded: LoadedConfig): string {
	const brokerPath = join(loaded.configDir, "broker.ts");
	const brokerUiPath = join(loaded.configDir, "broker-ui.ts");
	mkdirSync(loaded.configDir, { recursive: true });
	const currentBroker = existsSync(brokerPath) ? readFileSync(brokerPath, "utf8") : null;
	if (currentBroker !== embeddedBrokerSource) {
		writeFileSync(brokerPath, embeddedBrokerSource, "utf8");
	}
	const currentBrokerUi = existsSync(brokerUiPath) ? readFileSync(brokerUiPath, "utf8") : null;
	if (currentBrokerUi !== embeddedBrokerUiSource) {
		writeFileSync(brokerUiPath, embeddedBrokerUiSource, "utf8");
	}
	return brokerPath;
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
	const brokerPath = ensureBrokerEntrypoint(loaded);
	return ["bun", brokerPath, "--port", String(Number.isFinite(port) ? port : 7331)];
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
			title: "broker",
		}
		: null;
	const teamWindows = Object.keys(loaded.config.workspaces).sort().map(name => orderedWorkspaceCommands(loaded, name, forWindowsShell));
	return {
		sessionName,
		leadership: {
			name: "leadership",
			cwd: loaded.projectRoot,
			command: leadershipCommand,
			title: "overlord",
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

/**
 * Pure function: returns the split-window and select-pane commands needed to
 * arrange agentCommands into a balanced grid inside an already-created window.
 * Does NOT include new-session or new-window — caller creates those.
 */
export function buildColumnSplitCommands(
	executable: string,
	sessionName: string,
	windowName: string,
	agentCommands: Array<PaneLaunchCommand | string>,
): string[][] {
	const normalizedCommands = normalizePaneCommands(agentCommands);
	const n = normalizedCommands.length;
	if (n <= 1) return []; // single pane — nothing to split

	const winTarget = `${sessionName}:${windowName}`;
	const result: string[][] = [];

	// Compute balanced column layout
	const rowsMax = Math.ceil(Math.sqrt(n));
	const cols    = Math.ceil(n / rowsMax);
	const base    = Math.floor(n / cols);
	const extra   = n % cols;
	// leftmost (cols-extra) columns get base panes; rightmost extra get base+1
	const colSizes = Array.from({ length: cols }, (_, i) => i < cols - extra ? base : base + 1);

	// Assign commands to columns
	let cmdOffset = 0;
	const colCmds = colSizes.map(size => {
		const slice = normalizedCommands.slice(cmdOffset, cmdOffset + size);
		cmdOffset += size;
		return slice;
	});

	// offsets[j] = sum of colSizes[0..j-1] = positional index of col j's anchor pane during Phase 2.
	// V-splits insert at position anchor+k, renumbering later panes, so offsets correctly tracks anchors.
	let cumulative = 0;
	const offsets = colSizes.map(s => { const o = cumulative; cumulative += s; return o; });

	// Phase 1: horizontal splits to carve equal-width columns.
	// H-splits don't renumber earlier panes; after j H-splits the rightmost zone is pane j.
	let rightmostZone = 0;
	let remainingCols = cols;
	for (let j = 1; j < cols; j++) {
		const p = Math.round((remainingCols - 1) * 100 / remainingCols);
		result.push([
			executable, "split-window",
			"-t", `${winTarget}.${rightmostZone}`,
			"-h", "-p", String(p),
			"-c", colCmds[j][0].cwd,
			colCmds[j][0].command,
		]);
		result.push(...paneTitleCommands(executable, `${winTarget}.${rightmostZone + 1}`, colCmds[j][0].title));
		rightmostZone = j;
		remainingCols--;
	}

	// Phase 2: vertical fills.
	// Column j's anchor is offsets[j]; each V-split k targets offsets[j]+(k-1).
	for (let j = 0; j < cols; j++) {
		const s = colSizes[j];
		for (let k = 1; k < s; k++) {
			const target = offsets[j] + (k - 1);
			const p = Math.round((s - k) * 100 / (s - k + 1));
			result.push([
				executable, "split-window",
				"-t", `${winTarget}.${target}`,
				"-v", "-p", String(p),
				"-c", colCmds[j][k].cwd,
				colCmds[j][k].command,
			]);
			result.push(...paneTitleCommands(executable, `${winTarget}.${target + 1}`, colCmds[j][k].title));
		}
	}

	result.unshift(...paneTitleCommands(executable, `${winTarget}.0`, colCmds[0][0]?.title));

	// Focus leader pane (top-left = pane 0)
	result.push([executable, "select-pane", "-t", `${winTarget}.0`]);
	return result;
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
	commands.push(...paneTitleCommands(executable, `${plan.sessionName}:${plan.leadership.name}.0`, plan.leadership.title));
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
		commands.push(...paneTitleCommands(executable, `${plan.sessionName}:${plan.brokerWindow.name}.0`, plan.brokerWindow.title));
	}

	for (const window of plan.teamWindows) {
		// Always create window with leader (first command)
		commands.push([executable, "new-window", "-t", plan.sessionName, "-n", window.name, "-c", window.commands[0].cwd, window.commands[0].command]);
		commands.push(...paneTitleCommands(executable, `${plan.sessionName}:${window.name}.0`, window.commands[0].title));
		// Append split-window + select-pane commands from the shared helper
		for (const cmd of buildColumnSplitCommands(executable, plan.sessionName, window.name, window.commands)) {
			commands.push(cmd);
		}
	}

	return commands;
}

function debugEcho(command: string[]): void {
	console.log(command.map(a => /[\s'"\\]/.test(a) ? shellEsc(a) : a).join(" "));
}

function runTmuxLikeStart(loaded: LoadedConfig, mux: SelectedMultiplexer, debug = false): void {
	const sessionName = orchestrationSessionName(loaded.config);
	const commands = buildTmuxLikeCommandSequence(loaded, mux.executable, mux.kind as "tmux" | "psmux");
	if (debug) {
		for (const command of commands) debugEcho(command);
		return;
	}
	const hasSession = Bun.spawnSync(commands[0], { stdout: "ignore", stderr: "ignore" });
	if (hasSession.exitCode === 0) {
		throw new Error(`A ${mux.kind} session named \"${sessionName}\" already exists.`);
	}
	for (const command of commands.slice(1)) runOrThrow(command);
	attachOrchestration(loaded, mux);
}

export function cmuxLayoutForCommands(commands: Array<PaneLaunchCommand | string>) {
	type NormalizedLayoutCommand = PaneLaunchCommand;
	const normalizedCommands = normalizePaneCommands(commands);
	type LayoutNode =
		| { pane: { surfaces: [{ type: "terminal"; command: string }] } }
		| { direction: "horizontal" | "vertical"; split: number; children: [LayoutNode, LayoutNode] };

	function pane(cmd: NormalizedLayoutCommand): LayoutNode {
		return { pane: { surfaces: [{ type: "terminal", command: cmd.command }] } };
	}

	// Stack cmds vertically with equal height splits
	function buildColumn(cmds: NormalizedLayoutCommand[]): LayoutNode {
		if (cmds.length === 1) return pane(cmds[0]);
		return {
			direction: "vertical",
			split: 1 / cmds.length,
			children: [pane(cmds[0]), buildColumn(cmds.slice(1))],
		};
	}

	// Build `cols` equal-width columns from cmds, distributing extras to rightmost
	function buildColumns(cmds: NormalizedLayoutCommand[], cols: number): LayoutNode {
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

	const n = normalizedCommands.length;
	if (n === 0) throw new Error("cmuxLayoutForCommands: no commands");
	if (n === 1) return pane(normalizedCommands[0]);

	const rowsMax = Math.ceil(Math.sqrt(n));
	const cols    = Math.ceil(n / rowsMax);
	return buildColumns(normalizedCommands, cols);
}

function writeCmuxLaunchScript(loaded: LoadedConfig, key: string, shellCommand: string): string {
	const { runtimeRoot } = ensureStateDirectories(loaded);
	const scriptDir = join(runtimeRoot, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	const scriptPath = join(scriptDir, `${key}.sh`);
	writeFileSync(scriptPath, `#!/bin/sh\n${shellCommand}\n`, "utf8");
	chmodSync(scriptPath, 0o755);
	return shellEsc(scriptPath);
}

/**
 * Writes per-agent launch scripts and returns the workspace plan ready to
 * pass to `cmux new-workspace`. Exported so tests can inspect outputs without
 * needing a real cmux installation.
 */
export function buildCmuxWorkspaces(loaded: LoadedConfig, writeScripts = true): Array<{ name: string; cwd: string; commands: Array<{ cwd: string; command: string; title?: string; gitCeilingDir?: string }> }> {
	function script(key: string, shellCommand: string): string {
		// In dry-run / debug mode callers pass writeScripts=false to avoid side-effects.
		if (!writeScripts) return shellCommand;
		return writeCmuxLaunchScript(loaded, key, shellCommand);
	}
	const leadershipCommand = script("orchestration-overlord", buildLaunchCommand(loaded, "overlord", buildOverlordArgs(loaded), false));
	const brokerArgs = localBrokerArgs(loaded);
	return [
		{ name: "leadership", cwd: loaded.projectRoot, commands: [{ cwd: loaded.projectRoot, command: leadershipCommand }] },
		...(brokerArgs ? [{ name: "broker", cwd: loaded.projectRoot, commands: [{ cwd: loaded.projectRoot, command: script("broker", buildLaunchCommand(loaded, "broker", brokerArgs, false)) }] }] : []),
		...Object.keys(loaded.config.workspaces).sort().map(name => {
			const windowPlan = orderedWorkspaceCommands(loaded, name, false);
			return {
				...windowPlan,
				commands: windowPlan.commands.map(cmd => ({
					...cmd,
					command: script(`${name}-${cmd.title ?? "agent"}`, cmd.command),
				})),
			};
		}),
	];
}

/**
 * Parse the output of `cmux list-workspaces` into a list of {ref, name} pairs.
 * Lines look like: `* workspace:1  leadership  [selected]`
 * Strips leading `*`, trailing annotations like `[selected]`, and surrounding whitespace.
 */
function parseCmuxWorkspaceList(output: string): Array<{ ref: string; name: string }> {
	return output.split("\n")
		.map(line => {
			const match = line.trim().match(/^[*\s]*(workspace:\d+)\s+(.+)/);
			if (!match) return null;
			const ref = match[1];
			const name = match[2].replace(/\s+\[[\w\s]+\]\s*$/, "").trim();
			return { ref, name };
		})
		.filter((w): w is { ref: string; name: string } => !!w);
}

/** Returns the set of workspace names that belong to this orchestration session. */
function orchestrationWorkspaceNames(loaded: LoadedConfig): Set<string> {
	const names = new Set<string>(["leadership"]);
	if (localBrokerArgs(loaded)) names.add("broker");
	for (const name of Object.keys(loaded.config.workspaces)) names.add(name);
	return names;
}

function runCmuxStart(loaded: LoadedConfig, mux: SelectedMultiplexer, debug = false): void {
	const workspaces = buildCmuxWorkspaces(loaded, !debug);

	// Guard: bail if any planned workspace already exists,
	// mirroring the tmux has-session check. Prevents duplicate workspace creation.
	if (!debug) {
		const existing = parseCmuxWorkspaceList(runOrThrow([mux.executable, "list-workspaces"]));
		const existingNames = new Set(existing.map(w => w.name));
		const conflicts = workspaces.map(w => w.name).filter(n => existingNames.has(n));
		if (conflicts.length > 0) {
			throw new Error(
				`Orchestration workspace(s) already exist: ${conflicts.join(", ")}. ` +
				`Run 'pit orchestration stop' or close them in cmux manually before starting again.`
			);
		}
	}

	const exec = (command: string[]): string => {
		if (debug) { debugEcho(command); return ""; }
		return runOrThrow(command);
	};

	// When invoked from outside cmux (no CMUX_WORKSPACE_ID / CMUX_SURFACE_ID),
	// new-workspace has no window context and opens a separate OS window per call.
	// Create one dedicated window upfront and route every workspace into it.
	// cmux new-window prints "OK <uuid>" — parse out just the UUID.
	const outsideCmux = !process.env.CMUX_WORKSPACE_ID && !process.env.CMUX_SURFACE_ID;
	let targetWindow: string | undefined;
	if (outsideCmux) {
		const output = exec([mux.executable, "new-window"]);
		if (debug) {
			targetWindow = "<new-window-id>";
		} else {
			const uuid = output.startsWith("OK ") ? output.slice(3).trim() : output.trim();
			if (!uuid) throw new Error("cmux new-window did not return a window ID");
			targetWindow = uuid;
		}
	}

	for (let i = 0; i < workspaces.length; i++) {
		const workspace = workspaces[i];
		exec([
			mux.executable,
			"new-workspace",
			"--name", workspace.name,
			"--cwd", workspace.cwd,
			"--layout", JSON.stringify(cmuxLayoutForCommands(workspace.commands)),
			...(targetWindow ? ["--window", targetWindow] : []),
			// Focus the first workspace (leadership) so it is visible on arrival;
			// remaining workspaces are created as background tabs.
			"--focus", i === 0 ? "true" : "false",
		]);
	}
}

export function startOrchestration(loaded: LoadedConfig, options?: { debug?: boolean }): SelectedMultiplexer {
	const debug = options?.debug ?? false;
	const mux = resolveMultiplexer();
	if (mux.kind === "cmux") {
		runCmuxStart(loaded, mux, debug);
		return mux;
	}
	runTmuxLikeStart(loaded, mux, debug);
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

function runCmuxStop(loaded: LoadedConfig, mux: SelectedMultiplexer): void {
	const existing = parseCmuxWorkspaceList(runOrThrow([mux.executable, "list-workspaces"]));
	const orchNames = orchestrationWorkspaceNames(loaded);
	const toClose = existing.filter(w => orchNames.has(w.name));
	if (toClose.length === 0) {
		throw new Error("No orchestration workspaces found in cmux.");
	}
	for (const workspace of toClose) {
		runOrThrow([mux.executable, "close-workspace", "--workspace", workspace.ref]);
	}
}

export function stopOrchestration(loaded: LoadedConfig): SelectedMultiplexer {
	const mux = resolveMultiplexer();
	if (mux.kind === "cmux") {
		runCmuxStop(loaded, mux);
		return mux;
	}
	runOrThrow([mux.executable, "kill-session", "-t", orchestrationSessionName(loaded.config)]);
	return mux;
}

export function orchestrationStatus(loaded: LoadedConfig): { backend: MultiplexerKind; available: boolean; sessionName: string } {
	const mux = resolveMultiplexer();
	if (mux.kind === "cmux") {
		try {
			const existing = parseCmuxWorkspaceList(runOrThrow([mux.executable, "list-workspaces"]));
			const orchNames = orchestrationWorkspaceNames(loaded);
			const available = existing.some(w => orchNames.has(w.name));
			return { backend: mux.kind, available, sessionName: orchestrationSessionName(loaded.config) };
		} catch {
			return { backend: mux.kind, available: false, sessionName: orchestrationSessionName(loaded.config) };
		}
	}
	const result = Bun.spawnSync([mux.executable, "has-session", "-t", orchestrationSessionName(loaded.config)], { stdout: "ignore", stderr: "ignore" });
	return { backend: mux.kind, available: result.exitCode === 0, sessionName: orchestrationSessionName(loaded.config) };
}
