#!/usr/bin/env bun
/**
 * Pi2Pi Team Launcher
 *
 * Reads a team roster YAML file and launches one pi instance per member
 * in a multiplexed terminal session.
 *
 * Usage:
 *   bun launcher.ts <team.yaml>
 *
 * Multiplexer precedence:
 *   1. cmux  — if cmux is installed and running
 *   2. tmux  — if tmux is installed (macOS / Linux)
 *   3. wt    — Windows Terminal CLI (Windows native)
 *   4. headless — background Bun.spawn processes (Windows fallback, no UI)
 */

import { parse } from "yaml";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Role {
	title: string;
	description?: string;
	model: string;
	systemPrompt: string;
	tools: string[] | "all";
}

interface Member {
	name: string;
	role: string;
	model?: string;          // overrides role model
	systemPrompt?: string;   // appended after role systemPrompt
}

interface TeamConfig {
	team: {
		name: string;
		broker?: string;
	};
	roles: Record<string, Role>;
	members: Member[];
}

// ── Load config ───────────────────────────────────────────────────────────────

const configPath = process.argv[2];
if (!configPath) {
	console.error("Usage: bun launcher.ts <team.yaml>");
	process.exit(1);
}

const configFile = resolve(configPath);
if (!existsSync(configFile)) {
	console.error(`Config file not found: ${configFile}`);
	process.exit(1);
}

const config = parse(readFileSync(configFile, "utf8")) as TeamConfig;

if (!config || typeof config !== "object") {
	console.error("team.name is required");
	process.exit(1);
}

const { team, roles, members } = config;

if (!team?.name) { console.error("team.name is required"); process.exit(1); }
if (!roles || Object.keys(roles).length === 0) { console.error("No roles defined"); process.exit(1); }
if (!members?.length) { console.error("No members defined"); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────

const extensionPath = join(import.meta.dir, "pi2pi.ts");

function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/** Shell-escape a single argument for Unix shells (single-quote wrapping). */
function shellEsc(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell-escape a single argument (single-quote string, '' for internal quotes). */
function psEsc(arg: string): string {
	return `'${arg.replace(/'/g, "''")}'`;
}

/** cmd.exe-escape a single argument using double quotes. */
function cmdEsc(arg: string): string {
	return `"${arg.replace(/"/g, '""')}"`;
}

/** Build the raw args array for a pi invocation (cross-platform, no shell escaping). */
function buildArgs(member: Member, role: Role): string[] {
	const vars = { name: member.name, team: team.name };

	let systemPrompt = interpolate(role.systemPrompt, vars);
	if (member.systemPrompt) {
		systemPrompt += "\n\n" + interpolate(member.systemPrompt, vars);
	}

	const model = member.model ?? role.model;

	const args: string[] = [
		"pi",
		"-e", extensionPath,
		"--agent-name", member.name,
		"--room", team.name,
		"--model", model,
		"--append-system-prompt", systemPrompt,
	];

	if (team.broker) {
		args.push("--broker", team.broker);
	}

	if (role.tools !== "all") {
		args.push("--tools", role.tools.join(","));
	}

	return args;
}

/** Build a Unix shell command string for a pi invocation. */
function buildCommand(member: Member, role: Role): string {
	return "clear && " + buildArgs(member, role).map(shellEsc).join(" ");
}

// ── Validate members ──────────────────────────────────────────────────────────

const commands: { member: Member; role: Role; command: string; args: string[] }[] = [];

for (const member of members) {
	const role = roles[member.role];
	if (!role) {
		console.error(`Unknown role "${member.role}" for member "${member.name}"`);
		process.exit(1);
	}
	commands.push({ member, role, command: buildCommand(member, role), args: buildArgs(member, role) });
}

// ── Multiplexer ──────────────────────────────────────────────────────────────

// Use 'where' on Windows (equivalent of 'which' on Unix).
const isWindows = process.platform === "win32";
const findExe = isWindows ? "where" : "which";

function resolveExecutable(name: string): string | null {
	if (isWindows) {
		const windowsCandidates = [
			process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", `${name}.exe`) : null,
			process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local", "Microsoft", "WindowsApps", `${name}.exe`) : null,
		].filter((path): path is string => !!path);

		for (const candidate of windowsCandidates) {
			if (existsSync(candidate)) return candidate;
		}
	}

	try {
		const result = Bun.spawnSync([findExe, name]);
		if (result.exitCode !== 0) return null;

		const output = Buffer.from(result.stdout).toString("utf8");
		const match = output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
		return match ?? null;
	} catch {
		return null;
	}
}

function decodeOutput(output?: ArrayBufferLike | Uint8Array | null): string {
	if (!output) return "";
	return Buffer.from(output).toString("utf8").trim();
}

function launchHeadless(): void {
	// ── Headless fallback (Windows, no terminal multiplexer) ─────────────────
	// Spawn each agent as an independent background process. No interactive UI,
	// but the agents connect to the broker and operate normally.
	console.log("No terminal multiplexer found — launching agents as background processes.");
	console.log("Install Windows Terminal for an interactive UI: https://aka.ms/terminal\n");

	for (const { member, args } of commands) {
		const proc = Bun.spawn(args, {
			stdio: ["ignore", "ignore", "ignore"],
		});
		proc.unref(); // Allow the launcher to exit without waiting for agents
		console.log(`  ✓ ${member.name} (pid ${proc.pid})`);
	}

	console.log(`\n${commands.length} agents launched in background.`);
	console.log("Use 'tasklist | findstr bun' or Task Manager to locate them.");
}

const cmuxPath = resolveExecutable("cmux");
const cmuxRunning = !!cmuxPath && Bun.spawnSync([cmuxPath, "ping"]).exitCode === 0;
const tmuxPath = !cmuxRunning ? resolveExecutable("tmux") : null;
const wtPath = !cmuxRunning && !tmuxPath && isWindows ? resolveExecutable("wt") : null;

if (!cmuxRunning && !tmuxPath && !isWindows) {
	console.error("cmux or tmux is required to launch a team.\n");
	console.error("To launch agents manually, run each of these in a separate terminal:");
	for (const { command } of commands) console.error(`  ${command}`);
	process.exit(1);
}

console.log(`Launching team "${team.name}" (${commands.length} agents)...`);

if (cmuxRunning) {
	// ── cmux ─────────────────────────────────────────────────────────────────
	// Build a single workspace: first agent occupies the full left half,
	// remaining agents are stacked vertically in the right half.
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

	function buildLayout(cmds: string[]): LayoutNode {
		if (cmds.length === 1) return pane(cmds[0]);
		const [first, ...rest] = cmds;
		return {
			direction: "horizontal",
			split: 0.5,
			children: [pane(first), verticalStack(rest)],
		};
	}

	const layout = buildLayout(commands.map(({ command }) => command));

	Bun.spawnSync([
		cmuxPath!, "new-workspace",
		"--name", team.name,
		"--layout", JSON.stringify(layout),
		"--focus", "true",
	]);

	for (const { member } of commands) console.log(`  ✓ ${member.name}`);
	console.log(`\nAgents launched in cmux workspace "${team.name}".`);

} else if (tmuxPath) {
	// ── tmux ─────────────────────────────────────────────────────────────────
	const sessionName = team.name;
	const inTmux = !!process.env.TMUX;

	if (inTmux) {
		// Already inside tmux — open a new window for each agent.
		for (const { member, command } of commands) {
			Bun.spawnSync([tmuxPath, "new-window", "-n", member.name, command]);
			console.log(`  ✓ ${member.name}`);
		}
		console.log("\nAgents launched in new tmux windows.");
	} else {
		// Not in tmux — create a new named session.
		const sessionCheck = Bun.spawnSync([tmuxPath, "has-session", "-t", sessionName]);
		if (sessionCheck.exitCode === 0) {
			console.error(`A tmux session named "${sessionName}" already exists.`);
			console.error(`Attach with: tmux attach-session -t ${sessionName}`);
			console.error(`Or kill it with: tmux kill-session -t ${sessionName}`);
			process.exit(1);
		}

		const [first, ...rest] = commands;
		Bun.spawnSync([tmuxPath, "new-session", "-d", "-s", sessionName, "-n", first.member.name, first.command]);
		console.log(`  ✓ ${first.member.name}`);

		for (const { member, command } of rest) {
			Bun.spawnSync([tmuxPath, "new-window", "-t", sessionName, "-n", member.name, command]);
			console.log(`  ✓ ${member.name}`);
		}

		console.log(`\nAttaching to tmux session "${sessionName}"...`);
		Bun.spawnSync([tmuxPath, "attach-session", "-t", sessionName], {
			stdio: ["inherit", "inherit", "inherit"],
		});
	}

} else if (isWindows) {
	// ── Windows Terminal ─────────────────────────────────────────────────────
	// Write a temporary PowerShell script file for each agent to sidestep the
	// shell-escaping complexity of embedding complex system prompts in the wt
	// command line. Each .ps1 file simply invokes the pi command directly.
	//
	// All tabs are opened in a single wt invocation with ';'-chained new-tab
	// subcommands. This keeps them in one WT window and avoids race conditions
	// from multiple wt.exe invocations trying to find the same window.
	//
	// Note: wt returns immediately after dispatching commands to the running
	// Windows Terminal process — tabs open asynchronously.
	const scriptPaths: string[] = [];
	const ts = Date.now();
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const powershellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const powershellExe = existsSync(powershellPath) ? powershellPath : "powershell";
	const cmdPath = process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe");

	for (const { member, args } of commands) {
		const scriptPath = join(tmpdir(), `pi2pi-${member.name}-${ts}.ps1`);
		// Clear the console then launch pi. Using & (call operator) so PowerShell
		// treats the first token as a command, not a string literal.
		const psCmd = args.map(psEsc).join(" ");
		writeFileSync(scriptPath, `$Host.UI.RawUI.WindowTitle = ${psEsc(member.name)}\nClear-Host\n& ${psCmd}\n`);
		scriptPaths.push(scriptPath);
	}

	function paneCommandArgs(scriptPath: string): string[] {
		return [
			powershellExe,
			"-NoExit",
			"-NoProfile",
			"-ExecutionPolicy", "Bypass",
			"-File", scriptPath,
		];
	}

	const wtSubcommandArgs: string[] = ["--window", "new"];
	if (commands.length > 0) {
		wtSubcommandArgs.push(
			"new-tab",
			"--title", team.name,
			"--suppressApplicationTitle",
			...paneCommandArgs(scriptPaths[0]),
		);
		if (commands.length > 1) {
			// Windows Terminal uses -V for a vertical divider (left/right panes)
			// and -H for a horizontal divider (top/bottom panes).
			wtSubcommandArgs.push(";", "split-pane", "-V", "-s", "0.5", ...paneCommandArgs(scriptPaths[1]));
		}
		if (commands.length > 2) {
			// After the first split, focus remains on the original (left) pane.
			// Move into the right-hand pane before building the vertical stack.
			wtSubcommandArgs.push(";", "move-focus", "right");
		}
		for (let i = 2; i < commands.length; i++) {
			const remainingRightPanes = commands.length - i + 1;
			const splitSize = ((remainingRightPanes - 1) / remainingRightPanes).toFixed(4);
			wtSubcommandArgs.push(";", "split-pane", "-H", "-s", splitSize, ...paneCommandArgs(scriptPaths[i]));
			if (i < commands.length - 1) {
				wtSubcommandArgs.push(";", "move-focus", "down");
			}
		}
	}

	function logWtSuccess(): void {
		for (const { member } of commands) console.log(`  ✓ ${member.name}`);
		console.log(`\nAgents launched in Windows Terminal (${commands.length} panes).`);
		console.log("Panes open asynchronously — it may take a moment for all agents to appear.");
	}

	let launched = false;
	let failureMessage = "";
	const isWindowsAppsAlias = !!wtPath && /[\\/]WindowsApps[\\/]/i.test(wtPath);

	if (wtPath && !isWindowsAppsAlias) {
		try {
			const directResult = Bun.spawnSync([wtPath, ...wtSubcommandArgs]);
			if (directResult.exitCode === 0) {
				launched = true;
			} else {
				failureMessage = decodeOutput(directResult.stderr) || decodeOutput(directResult.stdout) || `exit code ${directResult.exitCode}`;
			}
		} catch (error) {
			failureMessage = error instanceof Error ? error.message : String(error);
		}
	}

	if (!launched) {
		const cmdLauncherPath = join(tmpdir(), `pi2pi-wt-launch-${ts}.cmd`);
		const cmdLine = ["wt", ...wtSubcommandArgs].map(cmdEsc).join(" ");
		writeFileSync(cmdLauncherPath, `@echo off\r\n${cmdLine}\r\n`);

		const cmdResult = Bun.spawnSync([cmdPath, "/d", "/c", cmdLauncherPath]);
		if (cmdResult.exitCode === 0) {
			launched = true;
		} else {
			const cmdFailure = decodeOutput(cmdResult.stderr) || decodeOutput(cmdResult.stdout) || `exit code ${cmdResult.exitCode}`;
			failureMessage = failureMessage ? `${failureMessage}; ${cmdFailure}` : cmdFailure;
		}
	}

	if (!launched) {
		const launcherScriptPath = join(tmpdir(), `pi2pi-wt-launch-${ts}.ps1`);
		const wtArgLines = wtSubcommandArgs.map(arg => `  ${psEsc(arg)}`).join(",\n");
		writeFileSync(
			launcherScriptPath,
			[
				"$ErrorActionPreference = 'Stop'",
				"$wtArgs = @(",
				wtArgLines,
				")",
				"& wt @wtArgs",
				"exit $LASTEXITCODE",
			].join("\n") + "\n",
		);

		const shellResult = Bun.spawnSync([
			powershellExe,
			"-NoProfile",
			"-ExecutionPolicy", "Bypass",
			"-File", launcherScriptPath,
		]);

		if (shellResult.exitCode === 0) {
			launched = true;
		} else {
			const shellFailure = decodeOutput(shellResult.stderr) || decodeOutput(shellResult.stdout) || `exit code ${shellResult.exitCode}`;
			failureMessage = failureMessage ? `${failureMessage}; ${shellFailure}` : shellFailure;
		}
	}

	if (launched) {
		logWtSuccess();
	} else {
		if (failureMessage) console.warn(`Windows Terminal launch failed (${failureMessage}).`);
		console.warn("Falling back to background processes.\n");
		launchHeadless();
	}

} else {
	launchHeadless();
}
