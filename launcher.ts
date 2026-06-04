#!/usr/bin/env bun
/**
 * Pi2Pi Team Launcher
 *
 * Reads a team roster YAML file and launches one pi instance per member
 * in a tmux session, each with their role's model, system prompt, and
 * allowed tools.
 *
 * Usage:
 *   bun launcher.ts <team.yaml>
 *
 * Requires tmux. Each agent runs in its own named tmux window.
 * If already inside a tmux session, windows are added to the current session.
 * Otherwise a new tmux session named after the team is created and attached.
 */

import { parse } from "yaml";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

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
const { team, roles, members } = config;

if (!team?.name) { console.error("team.name is required"); process.exit(1); }
if (!roles || Object.keys(roles).length === 0) { console.error("No roles defined"); process.exit(1); }
if (!members?.length) { console.error("No members defined"); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────

const extensionPath = join(import.meta.dir, "pi2pi.ts");

function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/** Shell-escape a single argument (single-quote wrapping). */
function shellEsc(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Build the pi command args for a given member + role. */
function buildCommand(member: Member, role: Role): string {
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

	return "clear && " + args.map(shellEsc).join(" ");
}

// ── Validate members ──────────────────────────────────────────────────────────

const commands: { member: Member; role: Role; command: string }[] = [];

for (const member of members) {
	const role = roles[member.role];
	if (!role) {
		console.error(`Unknown role "${member.role}" for member "${member.name}"`);
		process.exit(1);
	}
	commands.push({ member, role, command: buildCommand(member, role) });
}

// ── Multiplexer ──────────────────────────────────────────────────────────────

const hasCmux = Bun.spawnSync(["which", "cmux"]).exitCode === 0;
const cmuxRunning = hasCmux && Bun.spawnSync(["cmux", "ping"]).exitCode === 0;
const hasTmux = !cmuxRunning && Bun.spawnSync(["which", "tmux"]).exitCode === 0;

if (!cmuxRunning && !hasTmux) {
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
		"cmux", "new-workspace",
		"--name", team.name,
		"--layout", JSON.stringify(layout),
		"--focus", "true",
	]);

	for (const { member } of commands) console.log(`  ✓ ${member.name}`);
	console.log(`\nAgents launched in cmux workspace "${team.name}".`);

} else {
	// ── tmux ─────────────────────────────────────────────────────────────────
	const sessionName = team.name;
	const inTmux = !!process.env.TMUX;

	if (inTmux) {
		// Already inside tmux — open a new window for each agent.
		for (const { member, command } of commands) {
			Bun.spawnSync(["tmux", "new-window", "-n", member.name, command]);
			console.log(`  ✓ ${member.name}`);
		}
		console.log("\nAgents launched in new tmux windows.");
	} else {
		// Not in tmux — create a new named session.
		const sessionCheck = Bun.spawnSync(["tmux", "has-session", "-t", sessionName]);
		if (sessionCheck.exitCode === 0) {
			console.error(`A tmux session named "${sessionName}" already exists.`);
			console.error(`Attach with: tmux attach-session -t ${sessionName}`);
			console.error(`Or kill it with: tmux kill-session -t ${sessionName}`);
			process.exit(1);
		}

		const [first, ...rest] = commands;
		Bun.spawnSync(["tmux", "new-session", "-d", "-s", sessionName, "-n", first.member.name, first.command]);
		console.log(`  ✓ ${first.member.name}`);

		for (const { member, command } of rest) {
			Bun.spawnSync(["tmux", "new-window", "-t", sessionName, "-n", member.name, command]);
			console.log(`  ✓ ${member.name}`);
		}

		console.log(`\nAttaching to tmux session "${sessionName}"...`);
		Bun.spawnSync(["tmux", "attach-session", "-t", sessionName], {
			stdio: ["inherit", "inherit", "inherit"],
		});
	}
}
