import { describe, expect, test } from "bun:test";
import { renderBrokerScreen } from "../broker-ui";

describe("broker-ui", () => {
	test("renders member roles in the rooms and agents pane", () => {
		const screen = renderBrokerScreen({
			width: 120,
			height: 24,
			rooms: {
				engineering: [{
					name: "Alice",
					displayName: "Alice",
					role: "manager",
					state: "active",
					model: "gpt-4o",
					contextTokens: 42000,
					contextWindow: 128000,
					contextPercent: 33,
				}],
			},
			logs: [],
			totalAgents: 1,
		});

		expect(screen).toContain("Alice");
		expect(screen).toContain("manager");
	});

	test("renders a full screen without a trailing newline to avoid terminal scroll", () => {
		const screen = renderBrokerScreen({
			width: 80,
			height: 12,
			rooms: {},
			logs: ["one", "two", "three"],
			totalAgents: 0,
		});

		expect(screen.startsWith("\u001B[H\u001B[2J")).toBe(true);
		expect(screen.endsWith("\n")).toBe(false);

		const body = screen.replace(/^\u001B\[H\u001B\[2J/, "");
		expect(body.split("\n")).toHaveLength(12);
	});
});
