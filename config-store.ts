import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { Document, isScalar, parse, visit } from "yaml";
import defaultRolePromptsYaml from "./default-role-prompts.yaml" with { type: "text" };

const DEFAULT_BROKER_URL = "ws://localhost:7331";
const DEFAULT_LEADERSHIP_ROOM = "leadership";
const DEFAULT_OVERLORD_NAME = "overlord";
const DEFAULT_OVERLORD_PROMPT = [
	"You are {{name}}, the interactive overlord coordinating team leaders.",
	"You are connected to leadership=#{{leadershipRoom}}.",
	"Use who to discover currently running team leaders.",
	"Each non-overlord agent in the leadership room is the team leader for exactly one team and represents that whole team.",
	"Team leaders appear using the display name '<team name> team'.",
	"Leader handles follow the convention <workspace>.lead.",
	"When asked to contact a team, such as 'ask the blackbird team to ...', delegate to that team's leader in the leadership room.",
	"Send top-level tasks to the appropriate team leader, wait for their synthesised result when needed, and coordinate across teams.",
].join(" ");

const DEFAULT_ROLE_MODEL = "github-copilot/claude-sonnet-4.6";
const DEFAULT_ROLE_KEY_MAP: Record<string, string> = {
	"team-leader": "leader",
	"software-engineer": "dev",
	architect: "architect",
	"quality-assurance": "qa",
	"user-experience": "ux",
	"product-manager": "product",
	critic: "critic",
};

const DEFAULT_ROLE_METADATA: Record<string, { title: string; description: string }> = {
	leader: {
		title: "Team Leader",
		description: "Coordinates the team, delegates work, and synthesizes outcomes.",
	},
	dev: {
		title: "Software Engineer",
		description: "Implements and debugs software changes.",
	},
	architect: {
		title: "Architect",
		description: "Shapes design upfront and reviews engineering changes.",
	},
	qa: {
		title: "Quality Assurance",
		description: "Verifies behavior, risk, and delivery confidence.",
	},
	ux: {
		title: "User Experience",
		description: "Improves flows, usability, and interaction quality.",
	},
	product: {
		title: "Product Manager",
		description: "Clarifies scope, priorities, and product tradeoffs.",
	},
	critic: {
		title: "Critic",
		description: "Challenges weak reasoning, risks, and unsupported conclusions.",
	},
};

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

export function pitHomeDir(): string {
	return join(homedir(), ".pit");
}

export function globalConfigPath(): string {
	return join(pitHomeDir(), "config.yaml");
}

function resolveDefaultConfigPath(): string {
	// 1. Local project config takes priority if it exists
	const local = resolve(".pi/config.yaml");
	if (existsSync(local)) return local;
	// 2. Fall back to global home-dir config
	return globalConfigPath();
}

function deriveProjectRoot(configDir: string): string {
	const base = basename(configDir).toLowerCase();
	return (base === ".pi" || base === ".pit") ? dirname(configDir) : configDir;
}

export function builtInDefaultRoles(model = DEFAULT_ROLE_MODEL): Record<string, RoleDefinition> {
	const parsed = parse(defaultRolePromptsYaml) as { roles?: Record<string, string> } | null;
	const promptRoles = parsed?.roles ?? {};
	const roles: Record<string, RoleDefinition> = {};

	for (const [promptKey, prompt] of Object.entries(promptRoles)) {
		const key = DEFAULT_ROLE_KEY_MAP[promptKey] ?? promptKey;
		const meta = DEFAULT_ROLE_METADATA[key] ?? { title: key, description: undefined as string | undefined };
		roles[key] = {
			title: meta.title,
			description: meta.description,
			model,
			systemPrompt: prompt,
			tools: "all",
		};
	}

	return roles;
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
	const resolvedPath = resolve(configPath ?? resolveDefaultConfigPath());
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

export function stringifyConfig(config: Pi2PiConfig): string {
	const doc = new Document(config);
	visit(doc, (_key, node) => {
		if (isScalar(node) && typeof node.value === "string" && node.value.includes("\n")) {
			node.type = "BLOCK_LITERAL";
		}
	});
	return String(doc);
}

export function saveConfig(loaded: LoadedConfig): void {
	mkdirSync(dirname(loaded.configPath), { recursive: true });
	writeFileSync(loaded.configPath, stringifyConfig(loaded.config), "utf8");
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
