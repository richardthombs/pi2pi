#!/usr/bin/env bun
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

import {
	assertSimpleKey,
	builtInDefaultRoles,
	defaultConfig,
	deriveRepoName,
	ensureStateDirectories,
	globalConfigPath,
	leadershipRoomName,
	loadConfig,
	orchestrationSessionName,
	overlordName,
	saveConfig,
	stringifyConfig,
	type LoadedConfig,
} from "./config-store";
import { buildOverlordArgs, ensurePi2PiExtension, getWorkspaceProcessStatus } from "./process-manager";
import { attachOrchestration, ensureBrokerEntrypoint, orchestrationStatus, startOrchestration, stopOrchestration } from "./multiplexer";
import { ensureWorkspaceLayout } from "./workspace-manager";

interface ParsedCli {
	configPath?: string;
	debug: boolean;
	args: string[];
}

function parseCli(argv: string[]): ParsedCli {
	const args: string[] = [];
	let configPath: string | undefined;
	let debug = false;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--config") {
			configPath = argv[i + 1];
			i += 1;
			continue;
		}
		if (argv[i] === "--debug") {
			debug = true;
			continue;
		}
		args.push(argv[i]);
	}

	return { configPath, debug, args };
}

function usage(): never {
	console.error(`Usage:
  pit init
  pit repos add <url> [name]
  pit repos list
  pit roles add <name> <model> [title]
  pit roles list
  pit orchestration show
  pit orchestration set broker <url>
  pit orchestration set leadership-room <room>
  pit orchestration set overlord-name <name>
  pit orchestration set session-name <name>
  pit orchestration start [--debug]
  pit orchestration restart
  pit orchestration attach
  pit orchestration stop
  pit orchestration status
  pit overlord command
  pit overlord start
  pit workspace create <name>
  pit workspace list
  pit workspace <name> add repo <repo>
  pit workspace <name> add member <member-name> <role>
  pit workspace <name> set broker <url>
  pit workspace <name> set room <room>
  pit workspace <name> set leader <member-name>
  pit workspace <name> init
  pit workspace <name> status

Optional:
  --config <path>   Use a different config file
                    (for 'pit init', pass either a config file path or a config directory)
                    (default: .pi/config.yaml if present, else ~/.pit/config.yaml)`);
	process.exit(1);
}

function handleInit(configPath?: string): void {
	const resolvedConfig = resolve(configPath ?? globalConfigPath());
	const configIsDirectory = configPath
		? (existsSync(resolvedConfig) && statSync(resolvedConfig).isDirectory()) || !/\.ya?ml$/i.test(resolvedConfig)
		: false;
	const homeDir = configIsDirectory ? resolvedConfig : dirname(resolvedConfig);
	const configFile = configIsDirectory ? join(homeDir, "config.yaml") : resolvedConfig;
	const reposRoot      = join(homeDir, "repos");
	const workspacesRoot = join(homeDir, "workspaces");
	const runtimeRoot    = join(homeDir, "runtime");

	const alreadyExists = existsSync(configFile);

	// Create directories
	mkdirSync(reposRoot,      { recursive: true });
	mkdirSync(workspacesRoot, { recursive: true });
	mkdirSync(runtimeRoot,    { recursive: true });

	if (!alreadyExists) {
		// Write a config with explicit absolute state paths
		const initial = defaultConfig();
		initial.state.reposRoot      = reposRoot;
		initial.state.workspacesRoot = workspacesRoot;
		initial.state.runtimeRoot    = runtimeRoot;
		initial.roles = builtInDefaultRoles();
		writeFileSync(configFile, stringifyConfig(initial), "utf8");
		console.log(`Initialised pit at ${homeDir}`);
	} else {
		console.log(`pit already initialised at ${homeDir} (config unchanged)`);
	}

	console.log(`  config:     ${configFile}`);
	console.log(`  repos:      ${reposRoot}`);
	console.log(`  workspaces: ${workspacesRoot}`);
	console.log(`  runtime:    ${runtimeRoot}`);
}

function requireWorkspace(loaded: LoadedConfig, workspaceName: string) {
	const workspace = loaded.config.workspaces[workspaceName];
	if (!workspace) throw new Error(`Unknown workspace: ${workspaceName}`);
	return workspace;
}

function printStatus(workspaceName: string, status: ReturnType<typeof getWorkspaceProcessStatus>): void {
	console.log(`Workspace: ${workspaceName}`);
	console.log(`Root: ${status.workspaceRoot}`);
	for (const member of status.members) {
		const state = member.running ? `running (pid ${member.pid})` : "stopped";
		const leader = member.leader ? " leader" : "";
		console.log(`- ${member.name}${leader} -> ${member.handle} [${member.role}] ${state} rooms=${member.rooms.join(", ")}`);
	}
}

function handleRepos(loaded: LoadedConfig, args: string[]): void {
	const action = args[0];
	if (action === "add") {
		const url = args[1];
		if (!url) usage();
		const name = args[2] ?? deriveRepoName(url);
		assertSimpleKey("repository name", name);
		if (loaded.config.repositories[name]) throw new Error(`Repository already exists: ${name}`);
		loaded.config.repositories[name] = { url, ref: "main" };
		saveConfig(loaded);
		console.log(`Added repository ${name} -> ${url}`);
		return;
	}

	if (action === "list") {
		const repos = Object.entries(loaded.config.repositories);
		if (repos.length === 0) {
			console.log("No repositories configured.");
			return;
		}
		for (const [name, repo] of repos) {
			console.log(`- ${name}: ${repo.url}${repo.ref ? ` @ ${repo.ref}` : ""}`);
		}
		return;
	}

	usage();
}

function handleRoles(loaded: LoadedConfig, args: string[]): void {
	if (args[0] === "add") {
		const roleName = args[1];
		const model = args[2];
		const title = args.slice(3).join(" ") || roleName;
		if (!roleName || !model) usage();
		assertSimpleKey("role name", roleName);
		if (loaded.config.roles[roleName]) throw new Error(`Role already exists: ${roleName}`);
		loaded.config.roles[roleName] = {
			title,
			model,
			systemPrompt: "You are {{name}} working in the {{team}} workspace.",
			tools: "all",
		};
		saveConfig(loaded);
		console.log(`Added role ${roleName} (${model}). Edit the config file to refine tools and system prompt.`);
		return;
	}

	if (args[0] !== "list") usage();
	const roles = Object.entries(loaded.config.roles);
	if (roles.length === 0) {
		console.log("No roles configured.");
		return;
	}
	for (const [name, role] of roles) {
		console.log(`- ${name}: ${role.title} (${role.model})`);
	}
}

function handleOrchestration(loaded: LoadedConfig, args: string[], debug = false): void {
	if (args[0] === "show") {
		console.log(`Broker: ${loaded.config.orchestration.broker}`);
		console.log(`Leadership room: ${leadershipRoomName(loaded.config)}`);
		console.log(`Overlord name: ${overlordName(loaded.config)}`);
		console.log(`Session name: ${orchestrationSessionName(loaded.config)}`);
		console.log(`Config directory: ${loaded.configDir}`);
		console.log(`Pi2Pi extension: ${ensurePi2PiExtension(loaded)}`);
		console.log(`Broker script: ${ensureBrokerEntrypoint(loaded)}`);
		return;
	}

	if (args[0] === "set") {
		const target = args[1];
		const value = args[2];
		if (!target || !value) usage();
		if (target === "broker") {
			loaded.config.orchestration.broker = value;
		} else if (target === "leadership-room") {
			assertSimpleKey("leadership room", value);
			loaded.config.orchestration.leadershipRoom = value;
		} else if (target === "overlord-name") {
			assertSimpleKey("overlord name", value);
			loaded.config.orchestration.overlordName = value;
		} else if (target === "session-name") {
			assertSimpleKey("session name", value);
			loaded.config.orchestration.sessionName = value;
		} else {
			usage();
		}
		saveConfig(loaded);
		console.log(`Updated orchestration ${target} to ${value}`);
		return;
	}

	if (args[0] === "start") {
		if (debug) console.log("[debug] The following cmux commands would be executed:");
		const mux = startOrchestration(loaded, { debug });
		if (!debug) console.log(`Started orchestration using ${mux.kind}.`);
		return;
	}

	if (args[0] === "restart") {
		const status = orchestrationStatus(loaded);
		if (status.available) stopOrchestration(loaded);
		const mux = startOrchestration(loaded);
		console.log(`${status.available ? "Restarted" : "Started"} orchestration using ${mux.kind}.`);
		return;
	}

	if (args[0] === "attach") {
		const mux = attachOrchestration(loaded);
		console.log(`Attached via ${mux.kind}.`);
		return;
	}

	if (args[0] === "stop") {
		const mux = stopOrchestration(loaded);
		console.log(`Stopped orchestration using ${mux.kind}.`);
		return;
	}

	if (args[0] === "status") {
		const status = orchestrationStatus(loaded);
		console.log(`Backend: ${status.backend}`);
		console.log(`Session: ${status.sessionName}`);
		console.log(`Available: ${status.available ? "yes" : "no"}`);
		return;
	}

	usage();
}

function handleOverlord(loaded: LoadedConfig, args: string[]): void {
	const action = args[0];
	const command = buildOverlordArgs(loaded);

	if (action === "command") {
		console.log(command.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" "));
		return;
	}

	if (action === "start") {
		const proc = Bun.spawnSync(command, {
			cwd: loaded.projectRoot,
			stdio: ["inherit", "inherit", "inherit"],
		});
		process.exit(proc.exitCode ?? 0);
	}

	usage();
}

function handleWorkspace(loaded: LoadedConfig, args: string[]): void {
	if (args[0] === "create") {
		const workspaceName = args[1];
		if (!workspaceName) usage();
		assertSimpleKey("workspace name", workspaceName);
		if (loaded.config.workspaces[workspaceName]) throw new Error(`Workspace already exists: ${workspaceName}`);
		loaded.config.workspaces[workspaceName] = { room: workspaceName, repositories: [], members: [] };
		saveConfig(loaded);
		ensureStateDirectories(loaded);
		console.log(`Created workspace ${workspaceName}`);
		return;
	}

	if (args[0] === "list") {
		const workspaces = Object.entries(loaded.config.workspaces);
		if (workspaces.length === 0) {
			console.log("No workspaces configured.");
			return;
		}
		for (const [name, workspace] of workspaces) {
			const leader = workspace.leader ? ` leader=${workspace.leader}` : "";
			console.log(`- ${name}: room=${workspace.room ?? name}, ${workspace.repositories.length} repos, ${workspace.members.length} members${leader}`);
		}
		return;
	}

	const workspaceName = args[0];
	if (!workspaceName) usage();
	const workspace = requireWorkspace(loaded, workspaceName);
	const action = args[1];

	if (action === "add") {
		const target = args[2];
		if (target === "repo") {
			const repoName = args[3];
			if (!repoName) usage();
			if (!loaded.config.repositories[repoName]) throw new Error(`Unknown repository: ${repoName}`);
			if (!workspace.repositories.includes(repoName)) workspace.repositories.push(repoName);
			saveConfig(loaded);
			console.log(`Added repository ${repoName} to workspace ${workspaceName}`);
			return;
		}

		if (target === "member") {
			const memberName = args[3];
			const roleName = args[4];
			if (!memberName || !roleName) usage();
			if (!loaded.config.roles[roleName]) throw new Error(`Unknown role: ${roleName}`);
			if (workspace.members.some(member => member.name === memberName)) throw new Error(`Member already exists: ${memberName}`);
			workspace.members.push({ name: memberName, role: roleName });
			saveConfig(loaded);
			console.log(`Added member ${memberName} (${roleName}) to workspace ${workspaceName}`);
			return;
		}
	}

	if (action === "set") {
		const target = args[2];
		const value = args[3];
		if (!target || !value) usage();
		if (target === "broker") {
			workspace.broker = value;
		} else if (target === "room") {
			assertSimpleKey("workspace room", value);
			workspace.room = value;
		} else if (target === "leader") {
			if (!workspace.members.some(member => member.name === value)) throw new Error(`Unknown member for leader: ${value}`);
			workspace.leader = value;
		} else {
			usage();
		}
		saveConfig(loaded);
		console.log(`Set ${target} for workspace ${workspaceName} to ${value}`);
		return;
	}

	if (action === "init") {
		const layout = ensureWorkspaceLayout(loaded, workspaceName);
		console.log(`Initialised workspace ${workspaceName} at ${layout.workspaceRoot}`);
		for (const [repoName, repoPath] of Object.entries(layout.repoPaths)) {
			console.log(`- ${repoName}: ${repoPath}`);
		}
		return;
	}

	if (action === "start" || action === "stop") {
		throw new Error(`Workspace ${action} is no longer supported directly. Use \"bun cli.ts orchestration ${action}\" instead.`);
	}

	if (action === "status") {
		const status = getWorkspaceProcessStatus(loaded, workspaceName);
		printStatus(workspaceName, status);
		return;
	}

	usage();
}

try {
	const parsed = parseCli(process.argv.slice(2));
	if (parsed.args.length === 0) usage();
	const [entity, ...args] = parsed.args;

	if (entity === "init") {
		handleInit(parsed.configPath);
	} else {
		const loaded = loadConfig(parsed.configPath);
		_dispatchCommand(entity, loaded, args, parsed.debug);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

function _dispatchCommand(entity: string, loaded: ReturnType<typeof loadConfig>, args: string[], debug = false): void {
	if (entity === "repos") {
		handleRepos(loaded, args);
	} else if (entity === "roles") {
		handleRoles(loaded, args);
	} else if (entity === "orchestration") {
		handleOrchestration(loaded, args, debug);
	} else if (entity === "overlord") {
		handleOverlord(loaded, args);
	} else if (entity === "workspace") {
		handleWorkspace(loaded, args);
	} else {
		usage();
	}
}
