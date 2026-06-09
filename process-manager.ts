import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { LoadedConfig, MemberDefinition, RoleDefinition, WorkspaceDefinition } from "./config-store";
import {
	brokerUrlForWorkspace,
	ensureStateDirectories,
	leadershipRoomName,
	overlordName,
	overlordPrompt,
	workspaceRoomName,
} from "./config-store";
import { ensureWorkspaceLayout, workspaceRootPath } from "./workspace-manager";

interface RuntimeMemberState {
	pid: number;
	role: string;
	cwd: string;
	startedAt: string;
	agentHandle: string;
	rooms: string[];
}

interface RuntimeWorkspaceState {
	members: Record<string, RuntimeMemberState>;
}

interface RuntimeState {
	workspaces: Record<string, RuntimeWorkspaceState>;
}

export interface RoomBinding {
	alias: string;
	room: string;
}

export interface LaunchSpec {
	workspaceName: string;
	memberName: string;
	roleName: string;
	agentHandle: string;
	isLeader: boolean;
	workspaceRoot: string;
	brokerUrl: string;
	roomBindings: RoomBinding[];
	args: string[];
}

const extensionPath = join(import.meta.dir, "pi2pi.ts");

function runtimeStatePath(loaded: LoadedConfig): string {
	const { runtimeRoot } = ensureStateDirectories(loaded);
	return join(runtimeRoot, "processes.json");
}

function readRuntimeState(loaded: LoadedConfig): RuntimeState {
	const path = runtimeStatePath(loaded);
	if (!existsSync(path)) return { workspaces: {} };
	return JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
}

function saveRuntimeState(loaded: LoadedConfig, state: RuntimeState): void {
	const path = runtimeStatePath(loaded);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function roleForMember(loaded: LoadedConfig, member: MemberDefinition): RoleDefinition {
	const role = loaded.config.roles[member.role];
	if (!role) {
		throw new Error(`Unknown role \"${member.role}\" for member \"${member.name}\"`);
	}
	return role;
}

function leaderNameOrThrow(workspaceName: string, workspace: WorkspaceDefinition): string {
	const leader = workspace.leader?.trim();
	if (!leader) throw new Error(`Workspace ${workspaceName} does not have a leader configured`);
	if (!workspace.members.some(member => member.name === leader)) {
		throw new Error(`Workspace ${workspaceName} leader ${leader} is not present in members`);
	}
	return leader;
}

function leaderHandle(workspaceName: string): string {
	return `${workspaceName}.lead`;
}

function agentSessionDir(loaded: LoadedConfig, scope: string, agentKey: string): string {
	const { runtimeRoot } = ensureStateDirectories(loaded);
	return join(runtimeRoot, "pi-sessions", scope, agentKey);
}

function agentSessionName(memberName: string, roleName: string, workspaceName: string): string {
	return `${memberName} (${roleName}) — ${workspaceName}`;
}

function roomBindingsForMember(loaded: LoadedConfig, workspaceName: string, workspace: WorkspaceDefinition, member: MemberDefinition): RoomBinding[] {
	const bindings: RoomBinding[] = [{ alias: "team", room: workspaceRoomName(workspaceName, workspace) }];
	if (workspace.leader === member.name) {
		bindings.push({ alias: "leadership", room: leadershipRoomName(loaded.config) });
	}
	return bindings;
}

function buildPrompt(
	workspaceName: string,
	workspace: WorkspaceDefinition,
	member: MemberDefinition,
	role: RoleDefinition,
	handle: string,
	repos: string[],
	bindings: RoomBinding[],
	leadershipRoom: string,
): string {
	const vars = {
		name: member.name,
		team: workspaceName,
		workspace: workspaceName,
		handle,
		leaderHandle: leaderHandle(workspaceName),
		teamRoom: workspaceRoomName(workspaceName, workspace),
		leadershipRoom,
	};

	let systemPrompt = interpolate(role.systemPrompt, vars);
	const repoSummary = repos.length > 0
		? `\n\nWorkspace repositories available at your cwd root: ${repos.join(", ")}.`
		: "\n\nYour workspace currently has no repositories.";
	systemPrompt += repoSummary;

	const teamRoster = workspace.members.map(m => `${m.name} (${m.role})`).join(", ");
	const bindingSummary = bindings.map(binding => `${binding.alias}=#${binding.room}`).join(", ");

	if (workspace.leader === member.name) {
		systemPrompt += `\n\nYou are the leader of the ${workspaceName} team.` +
			` Your agent handle is ${handle}.` +
			` You are connected to rooms ${bindingSummary}.` +
			` Receive top-level work in the leadership room, delegate into the team room, and return final synthesised results back upward.` +
			` Your mixed-specialty team members are: ${teamRoster}.`;
	} else {
		systemPrompt += `\n\nYou are part of the ${workspaceName} mixed-specialty team.` +
			` Your leader is ${leaderHandle(workspaceName)}.` +
			` You are connected to rooms ${bindingSummary}.` +
			` Accept delegation from your team leader and collaborate with your specialist teammates in the team room.`;
	}

	if (member.systemPrompt) {
		systemPrompt += "\n\n" + interpolate(member.systemPrompt, vars);
	}

	return systemPrompt;
}

export function createWorkspaceLaunchSpecs(loaded: LoadedConfig, workspaceName: string): LaunchSpec[] {
	const workspace = loaded.config.workspaces[workspaceName];
	if (!workspace) throw new Error(`Unknown workspace: ${workspaceName}`);
	leaderNameOrThrow(workspaceName, workspace);

	const workspaceRoot = workspaceRootPath(loaded, workspaceName);
	const brokerUrl = brokerUrlForWorkspace(loaded.config, workspace);
	const repoList = [...workspace.repositories];
	const leadershipRoom = leadershipRoomName(loaded.config);

	return workspace.members.map(member => {
		const role = roleForMember(loaded, member);
		const isLeader = workspace.leader === member.name;
		const handle = isLeader ? leaderHandle(workspaceName) : member.name;
		const roomBindings = roomBindingsForMember(loaded, workspaceName, workspace, member);
		const roomBindingArg = roomBindings.map(binding => `${binding.alias}=${binding.room}`).join(",");
		const systemPrompt = buildPrompt(workspaceName, workspace, member, role, handle, repoList, roomBindings, leadershipRoom);
		const model = member.model ?? role.model;
		const sessionDir = agentSessionDir(loaded, workspaceName, member.name);
		const sessionName = agentSessionName(member.name, member.role, workspaceName);
		const args: string[] = [
			"pi",
			"-c",
			"--session-dir", sessionDir,
			"--name", sessionName,
			"-e", extensionPath,
			"--agent-name", handle,
			"--display-name", member.name,
			"--agent-role", member.role,
			"--rooms", roomBindingArg,
			"--default-room", "team",
			"--model", model,
			"--append-system-prompt", systemPrompt,
			"--broker", brokerUrl,
		];

		if (role.tools !== "all") args.push("--tools", role.tools.join(","));

		return {
			workspaceName,
			memberName: member.name,
			roleName: member.role,
			agentHandle: handle,
			isLeader,
			workspaceRoot,
			brokerUrl,
			roomBindings,
			args,
		};
	});
}

export function buildOverlordArgs(loaded: LoadedConfig): string[] {
	const leadershipRoom = leadershipRoomName(loaded.config);
	const brokerUrl = loaded.config.orchestration.broker ?? "ws://localhost:7331";
	const name = overlordName(loaded.config);
	const sessionDir = agentSessionDir(loaded, "orchestration", name);
	const sessionName = `${name} (overlord)`;
	const systemPrompt = interpolate(overlordPrompt(loaded.config), {
		name,
		leadershipRoom,
	});

	return [
		"pi",
		"-c",
		"--session-dir", sessionDir,
		"--name", sessionName,
		"-e", extensionPath,
		"--agent-name", name,
		"--display-name", name,
		"--agent-role", "overlord",
		"--rooms", `leadership=${leadershipRoom}`,
		"--default-room", "leadership",
		"--broker", brokerUrl,
		"--append-system-prompt", systemPrompt,
	];
}

export interface WorkspaceProcessStatus {
	workspaceName: string;
	workspaceRoot: string;
	members: Array<{
		name: string;
		handle: string;
		role: string;
		leader: boolean;
		rooms: string[];
		pid: number | null;
		running: boolean;
		cwd: string;
	}>;
}

export function getWorkspaceProcessStatus(loaded: LoadedConfig, workspaceName: string): WorkspaceProcessStatus {
	const workspace = loaded.config.workspaces[workspaceName];
	if (!workspace) throw new Error(`Unknown workspace: ${workspaceName}`);
	const workspaceRoot = workspaceRootPath(loaded, workspaceName);
	const runtime = readRuntimeState(loaded);
	const runtimeMembers = runtime.workspaces[workspaceName]?.members ?? {};
	const specs = createWorkspaceLaunchSpecs(loaded, workspaceName);

	return {
		workspaceName,
		workspaceRoot,
		members: specs.map(spec => {
			const state = runtimeMembers[spec.memberName];
			const pid = state?.pid ?? null;
			return {
				name: spec.memberName,
				handle: spec.agentHandle,
				role: spec.roleName,
				leader: spec.isLeader,
				rooms: spec.roomBindings.map(binding => `${binding.alias}=#${binding.room}`),
				pid,
				running: pid !== null ? isProcessRunning(pid) : false,
				cwd: workspaceRoot,
			};
		}),
	};
}

export function startWorkspaceProcesses(loaded: LoadedConfig, workspaceName: string): WorkspaceProcessStatus {
	const { workspaceRoot } = ensureWorkspaceLayout(loaded, workspaceName);
	const runtime = readRuntimeState(loaded);
	const specs = createWorkspaceLaunchSpecs(loaded, workspaceName);
	const membersState = runtime.workspaces[workspaceName]?.members ?? {};

	for (const spec of specs) {
		const existing = membersState[spec.memberName];
		if (existing && isProcessRunning(existing.pid)) {
			continue;
		}

		const child = Bun.spawn(spec.args, {
			cwd: workspaceRoot,
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.unref();
		membersState[spec.memberName] = {
			pid: child.pid,
			role: spec.roleName,
			cwd: workspaceRoot,
			startedAt: new Date().toISOString(),
			agentHandle: spec.agentHandle,
			rooms: spec.roomBindings.map(binding => binding.room),
		};
	}

	runtime.workspaces[workspaceName] = { members: membersState };
	saveRuntimeState(loaded, runtime);
	return getWorkspaceProcessStatus(loaded, workspaceName);
}

export function stopWorkspaceProcesses(loaded: LoadedConfig, workspaceName: string): WorkspaceProcessStatus {
	const workspace = loaded.config.workspaces[workspaceName];
	if (!workspace) throw new Error(`Unknown workspace: ${workspaceName}`);
	const runtime = readRuntimeState(loaded);
	const membersState = runtime.workspaces[workspaceName]?.members ?? {};

	for (const member of Object.values(membersState)) {
		if (!isProcessRunning(member.pid)) continue;
		try {
			process.kill(member.pid);
		} catch {
			// Ignore already-exited processes.
		}
	}

	delete runtime.workspaces[workspaceName];
	saveRuntimeState(loaded, runtime);
	return getWorkspaceProcessStatus(loaded, workspaceName);
}
