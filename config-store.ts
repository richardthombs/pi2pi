import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { parse, stringify } from "yaml";

const DEFAULT_BROKER_URL = "ws://localhost:7331";
const DEFAULT_LEADERSHIP_ROOM = "leadership";
const DEFAULT_OVERLORD_NAME = "overlord";
const DEFAULT_OVERLORD_PROMPT = [
	"You are {{name}}, the interactive overlord coordinating team leaders.",
	"You are connected to leadership=#{{leadershipRoom}}.",
	"Use who to discover currently running team leaders.",
	"Leader handles follow the convention <workspace>.lead.",
	"Send top-level tasks to the appropriate team leader, wait for their synthesised result, and coordinate across teams.",
].join(" ");

export interface RoleDefinition {
	title: string;
	description?: string;
	model: string;
	systemPrompt: string;
	tools: string[] | "all";
}

export interface MemberDefinition {
	name: string;
	role: string;
	model?: string;
	systemPrompt?: string;
}

export interface RepositoryDefinition {
	url: string;
	ref?: string;
}

export interface WorkspaceDefinition {
	broker?: string;
	room?: string;
	leader?: string;
	repositories: string[];
	members: MemberDefinition[];
}

export interface StateDefinition {
	reposRoot?: string;
	workspacesRoot?: string;
	runtimeRoot?: string;
}

export interface OrchestrationDefinition {
	broker?: string;
	leadershipRoom?: string;
	overlordName?: string;
	overlordPrompt?: string;
	sessionName?: string;
}

export interface Pi2PiConfig {
	version: number;
	state: StateDefinition;
	orchestration: OrchestrationDefinition;
	roles: Record<string, RoleDefinition>;
	repositories: Record<string, RepositoryDefinition>;
	workspaces: Record<string, WorkspaceDefinition>;
}

export interface LoadedConfig {
	configPath: string;
	configDir: string;
	projectRoot: string;
	config: Pi2PiConfig;
}

export interface ResolvedStatePaths {
	reposRoot: string;
	workspacesRoot: string;
	runtimeRoot: string;
}

const DEFAULT_CONFIG_PATH = ".pi/config.yaml";

function deriveProjectRoot(configDir: string): string {
	return basename(configDir).toLowerCase() === ".pi" ? dirname(configDir) : configDir;
}

export function defaultConfig(): Pi2PiConfig {
	return {
		version: 1,
		state: {
			reposRoot: ".pi/repos",
			workspacesRoot: ".pi/workspaces",
			runtimeRoot: ".pi/runtime",
		},
		orchestration: {
			broker: DEFAULT_BROKER_URL,
			leadershipRoom: DEFAULT_LEADERSHIP_ROOM,
			overlordName: DEFAULT_OVERLORD_NAME,
			overlordPrompt: DEFAULT_OVERLORD_PROMPT,
			sessionName: "pi2pi",
		},
		roles: {},
		repositories: {},
		workspaces: {},
	};
}

export function loadConfig(configPath?: string): LoadedConfig {
	const resolvedPath = resolve(configPath ?? DEFAULT_CONFIG_PATH);
	const configDir = dirname(resolvedPath);
	const projectRoot = deriveProjectRoot(configDir);

	if (!existsSync(resolvedPath)) {
		return { configPath: resolvedPath, configDir, projectRoot, config: defaultConfig() };
	}

	const raw = readFileSync(resolvedPath, "utf8");
	const parsed = parse(raw) as Partial<Pi2PiConfig> | null;
	const defaults = defaultConfig();

	return {
		configPath: resolvedPath,
		configDir,
		projectRoot,
		config: {
			version: parsed?.version ?? defaults.version,
			state: { ...defaults.state, ...(parsed?.state ?? {}) },
			orchestration: { ...defaults.orchestration, ...(parsed?.orchestration ?? {}) },
			roles: parsed?.roles ?? {},
			repositories: parsed?.repositories ?? {},
			workspaces: parsed?.workspaces ?? {},
		},
	};
}

export function saveConfig(loaded: LoadedConfig): void {
	mkdirSync(dirname(loaded.configPath), { recursive: true });
	writeFileSync(loaded.configPath, stringify(loaded.config), "utf8");
}

export function resolveStatePaths(loaded: LoadedConfig): ResolvedStatePaths {
	return {
		reposRoot: resolve(loaded.projectRoot, loaded.config.state.reposRoot ?? ".pi/repos"),
		workspacesRoot: resolve(loaded.projectRoot, loaded.config.state.workspacesRoot ?? ".pi/workspaces"),
		runtimeRoot: resolve(loaded.projectRoot, loaded.config.state.runtimeRoot ?? ".pi/runtime"),
	};
}

export function ensureStateDirectories(loaded: LoadedConfig): ResolvedStatePaths {
	const statePaths = resolveStatePaths(loaded);
	mkdirSync(statePaths.reposRoot, { recursive: true });
	mkdirSync(statePaths.workspacesRoot, { recursive: true });
	mkdirSync(statePaths.runtimeRoot, { recursive: true });
	return statePaths;
}

export function deriveRepoName(url: string): string {
	const trimmed = url.trim().replace(/[\\/]+$/, "");
	const last = trimmed.split(/[\\/]/).pop() ?? trimmed;
	const withoutGit = last.replace(/\.git$/i, "");
	const normalized = withoutGit.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	if (!normalized) {
		throw new Error(`Could not derive a repository name from: ${url}`);
	}
	return normalized;
}

export function assertSimpleKey(kind: string, value: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new Error(`${kind} must match /^[A-Za-z0-9._-]+$/ (received: ${value})`);
	}
}

export function workspaceRoomName(workspaceName: string, workspace: WorkspaceDefinition): string {
	return workspace.room?.trim() || workspaceName;
}

export function leadershipRoomName(config: Pi2PiConfig): string {
	return config.orchestration.leadershipRoom?.trim() || DEFAULT_LEADERSHIP_ROOM;
}

export function brokerUrlForWorkspace(config: Pi2PiConfig, workspace: WorkspaceDefinition): string {
	return workspace.broker?.trim() || config.orchestration.broker?.trim() || DEFAULT_BROKER_URL;
}

export function overlordName(config: Pi2PiConfig): string {
	return config.orchestration.overlordName?.trim() || DEFAULT_OVERLORD_NAME;
}

export function overlordPrompt(config: Pi2PiConfig): string {
	return config.orchestration.overlordPrompt?.trim() || DEFAULT_OVERLORD_PROMPT;
}

export function orchestrationSessionName(config: Pi2PiConfig): string {
	return config.orchestration.sessionName?.trim() || "pi2pi";
}
