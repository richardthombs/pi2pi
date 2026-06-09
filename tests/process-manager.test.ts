import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../config-store";
import { defaultConfig } from "../config-store";
import { buildOverlordArgs, createWorkspaceLaunchSpecs } from "../process-manager";

describe("process-manager", () => {
	test("leader joins both leadership and team rooms while teammates join only the team room", () => {
		const root = mkdtempSync(join(tmpdir(), "pi2pi-launch-"));
		const loaded: LoadedConfig = {
			configPath: join(root, "config.yaml"),
			configDir: root,
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

		const leader = specs.find(spec => spec.memberName === "Alice");
		const engineer = specs.find(spec => spec.memberName === "Bob");
		expect(leader?.agentHandle).toBe("engineering.lead");
		expect(leader?.roomBindings).toEqual([
			{ alias: "team", room: "engineering" },
			{ alias: "leadership", room: "leadership" },
		]);
		expect(leader?.args).toContain("--rooms");
		expect(leader?.args).toContain("team=engineering,leadership=leadership");

		expect(engineer?.agentHandle).toBe("Bob");
		expect(engineer?.roomBindings).toEqual([{ alias: "team", room: "engineering" }]);
		expect(engineer?.args).toContain("team=engineering");
	});

	test("overlord args target the leadership room", () => {
		const root = mkdtempSync(join(tmpdir(), "pi2pi-launch-"));
		const loaded: LoadedConfig = {
			configPath: join(root, "config.yaml"),
			configDir: root,
			config: defaultConfig(),
		};
		loaded.config.orchestration.leadershipRoom = "leadership";
		loaded.config.orchestration.overlordName = "overlord";
		const args = buildOverlordArgs(loaded);
		expect(args).toContain("--rooms");
		expect(args).toContain("leadership=leadership");
		expect(args).toContain("--agent-name");
		expect(args).toContain("overlord");
	});
});
