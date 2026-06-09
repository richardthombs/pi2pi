import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { deriveRepoName, loadConfig, saveConfig } from "../config-store";

describe("config-store", () => {
	test("deriveRepoName strips .git and normalizes separators", () => {
		expect(deriveRepoName("https://github.com/richardthombs/pi2pi.git")).toBe("pi2pi");
		expect(deriveRepoName("git@github.com:org/my repo.git")).toBe("my-repo");
	});

	test("loadConfig returns defaults when config file is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "pi2pi-config-"));
		const loaded = loadConfig(join(root, "config.yaml"));
		expect(loaded.config.version).toBe(1);
		expect(loaded.config.orchestration.leadershipRoom).toBe("leadership");
		expect(loaded.config.orchestration.overlordName).toBe("overlord");
		expect(loaded.config.orchestration.sessionName).toBe("pi2pi");
		expect(loaded.config.repositories).toEqual({});
		expect(loaded.config.workspaces).toEqual({});
	});

	test("saveConfig persists shared roles and workspaces", () => {
		const root = mkdtempSync(join(tmpdir(), "pi2pi-config-"));
		const configPath = join(root, "config.yaml");
		const loaded = loadConfig(configPath);
		loaded.config.roles.engineer = {
			title: "Engineer",
			model: "gpt-4o",
			systemPrompt: "You are {{name}}.",
			tools: ["bash"],
		};
		loaded.config.repositories.pi2pi = {
			url: "https://github.com/richardthombs/pi2pi.git",
			ref: "main",
		};
		loaded.config.workspaces.engineering = {
			room: "engineering",
			leader: "Alice",
			repositories: ["pi2pi"],
			members: [{ name: "Alice", role: "engineer" }],
		};

		saveConfig(loaded);
		const raw = readFileSync(configPath, "utf8");
		expect(raw).toContain("orchestration:");
		expect(raw).toContain("roles:");
		expect(raw).toContain("workspaces:");
		expect(raw).toContain("engineering:");
	});
});
