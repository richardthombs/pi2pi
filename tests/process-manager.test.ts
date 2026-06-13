import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { buildOverlordArgs, createWorkspaceLaunchSpecs } from "../process-manager";
import _embeddedPi2PiExtensionSource from "../pi2pi.ts" with { type: "text" };
const embeddedPi2PiExtensionSource = _embeddedPi2PiExtensionSource as unknown as string;

describe("process-manager", () => {
	test("leader joins both leadership and team rooms while teammates join only the team room", () => {
		const root = mkdtempSync(join(tmpdir(), "pi2pi-launch-"));
		const loaded: LoadedConfig = {
			configPath: join(root, "config.yaml"),
			configDir: root,
			projectRoot: root,
			config: defaultConfig(),
		};
		loaded.config.roles.manager = {
			title: "Manager",
			model: "gpt-4o",
			systemPrompt: "You are {{name}}.",
			tools: ["tell", "who"],
		};
		loaded.config.roles.engineer = {
			title: "Engineer",
			model: "gpt-4o",
			systemPrompt: "You are {{name}}.",
			tools: ["tell", "who"],
		};
		loaded.config.repositories.pi2pi = { url: "https://github.com/richardthombs/pi2pi.git", ref: "main" };
		loaded.config.workspaces.engineering = {
			room: "engineering",
			leader: "Alice",
			repositories: ["pi2pi"],
			members: [
				{ name: "Alice", role: "manager" },
				{ name: "Bob", role: "engineer" },
			],
		};

		const specs = createWorkspaceLaunchSpecs(loaded, "engineering");
		expect(specs).toHaveLength(2);
		const extensionPath = join(root, "pi2pi.ts");
		expect(existsSync(extensionPath)).toBe(true);
		expect(readFileSync(extensionPath, "utf8")).toBe(embeddedPi2PiExtensionSource);

		const leader = specs.find(spec => spec.memberName === "Alice");
		const engineer = specs.find(spec => spec.memberName === "Bob");
		expect(leader?.agentHandle).toBe("engineering.lead");
		expect(leader?.roomBindings).toEqual([
			{ alias: "team", room: "engineering" },
			{ alias: "leadership", room: "leadership" },
		]);
		expect(leader?.args).toContain("-c");
		expect(leader?.args).toContain("-e");
		expect(leader?.args).toContain(extensionPath);
		expect(leader?.args).toContain("--session-dir");
		expect(leader?.args).toContain("--name");
		expect(leader?.args).toContain("Alice (manager) — engineering");
		expect(leader?.args).toContain("--display-name");
		expect(leader?.args).toContain("Alice");
		expect(leader?.args).toContain("--room-display-names");
		expect(leader?.args).toContain("team=Alice,leadership=engineering team");
		expect(leader?.args).toContain("--rooms");
		expect(leader?.args).toContain("team=engineering,leadership=leadership");
		expect(leader?.cwd).toBe(join(root, ".pi", "workspaces", "engineering", "pi2pi"));
		expect(leader?.gitCeilingDir).toBe(join(root, ".pi", "workspaces", "engineering"));

		expect(engineer?.agentHandle).toBe("Bob");
		expect(engineer?.cwd).toBe(join(root, ".pi", "workspaces", "engineering", "pi2pi"));
		expect(engineer?.roomBindings).toEqual([{ alias: "team", room: "engineering" }]);
		expect(engineer?.args).toContain("team=engineering");
	});

	test("overlord args target the leadership room", () => {
		const root = mkdtempSync(join(tmpdir(), "pi2pi-launch-"));
		const loaded: LoadedConfig = {
			configPath: join(root, "config.yaml"),
			configDir: root,
			projectRoot: root,
			config: defaultConfig(),
		};
		loaded.config.orchestration.leadershipRoom = "leadership";
		loaded.config.orchestration.overlordName = "overlord";
		const args = buildOverlordArgs(loaded);
		const extensionPath = join(root, "pi2pi.ts");
		expect(existsSync(extensionPath)).toBe(true);
		expect(readFileSync(extensionPath, "utf8")).toBe(embeddedPi2PiExtensionSource);
		expect(args).toContain("-c");
		expect(args).toContain("-e");
		expect(args).toContain(extensionPath);
		expect(args).toContain("--session-dir");
		expect(args).toContain("--name");
		expect(args).toContain("overlord (overlord)");
		expect(args).toContain("--rooms");
		expect(args).toContain("leadership=leadership");
		expect(args).toContain("--agent-name");
		expect(args).toContain("overlord");
		const prompt = args[args.indexOf("--append-system-prompt") + 1];
		expect(prompt).toContain("You are overlord, the interactive overlord coordinating team leaders.");
		expect(prompt).toContain("leadership=#leadership");
		expect(prompt).toContain("Each non-overlord agent in the leadership room is the team leader for exactly one team");
		expect(prompt).toContain("'ask the blackbird team to ...'");
	});

	test("overlord prompt can be configured from orchestration settings", () => {
		const root = mkdtempSync(join(tmpdir(), "pi2pi-launch-"));
		const loaded: LoadedConfig = {
			configPath: join(root, "config.yaml"),
			configDir: root,
			projectRoot: root,
			config: defaultConfig(),
		};
		loaded.config.orchestration.leadershipRoom = "ops";
		loaded.config.orchestration.overlordName = "coordinator";
		loaded.config.orchestration.overlordPrompt = "You are {{name}} in room #{{leadershipRoom}}.";
		const args = buildOverlordArgs(loaded);
		const prompt = args[args.indexOf("--append-system-prompt") + 1];
		expect(prompt).toBe("You are coordinator in room #ops.");
	});
});
