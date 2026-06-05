/**
 * Launcher YAML validation tests (Priority 3)
 *
 * Tests every validation branch in launcher.ts by spawning it as a real
 * subprocess with temporary YAML files.  We set PATH to /bin:/usr/bin so
 * that `which tmux` and `which cmux` both fail — this means valid configs
 * exit with "cmux or tmux is required" (not a validation error) rather than
 * actually spawning any terminal sessions, keeping tests hermetic.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const LAUNCHER = join(import.meta.dir, "../launcher.ts");

// Minimal PATH: /usr/bin has `which`, /bin covers basic builtins.
// Crucially, Homebrew bins (/opt/homebrew/bin, /usr/local/bin) are excluded,
// so `which tmux` and `which cmux` both return exit code 1.
const SAFE_PATH = "/bin:/usr/bin";

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpFiles: string[] = [];

/** Write a temp YAML file and return its path. Cleaned up in afterEach. */
function tmpYaml(content: string): string {
	const path = join(tmpdir(), `pi2pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
	writeFileSync(path, content, "utf8");
	tmpFiles.push(path);
	return path;
}

afterEach(() => {
	for (const f of tmpFiles.splice(0)) {
		try { unlinkSync(f); } catch { /* already gone */ }
	}
});

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Run the launcher with the given arguments and return its output. */
function runLauncher(args: string[], env: Record<string, string> = {}): RunResult {
	const proc = Bun.spawnSync(
		[process.execPath, LAUNCHER, ...args],
		{
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, PATH: SAFE_PATH, TMUX: "", ...env },
		},
	);
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
	};
}

/** Known validation error strings. A result is a validation error iff stderr
 *  includes at least one of these. */
const VALIDATION_ERRORS = [
	"Usage:",
	"Config file not found",
	"team.name is required",
	"No roles defined",
	"No members defined",
	"Unknown role",
];

function hasValidationError(stderr: string): boolean {
	return VALIDATION_ERRORS.some(msg => stderr.includes(msg));
}

/** Minimal valid YAML — used as a baseline for mutation tests. */
const VALID_YAML = `
team:
  name: engineering

roles:
  engineer:
    title: Software Engineer
    model: gpt-4o
    systemPrompt: You are {{name}} on the {{team}} team.
    tools:
      - bash
      - read

members:
  - name: Alice
    role: engineer
  - name: Bob
    role: engineer
`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing / invalid argument
// ─────────────────────────────────────────────────────────────────────────────

describe("Missing or invalid argument", () => {
	test("no argument prints usage and exits 1", () => {
		const { exitCode, stderr } = runLauncher([]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
		expect(stderr).toContain("launcher.ts");
	});

	test("non-existent file exits 1 with helpful message", () => {
		const { exitCode, stderr } = runLauncher(["/tmp/this-file-does-not-exist-pi2pi.yaml"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Config file not found");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Malformed YAML
// ─────────────────────────────────────────────────────────────────────────────

describe("Malformed YAML", () => {
	test("completely invalid YAML exits 1", () => {
		const f = tmpYaml("{ this is : not : valid yaml {{{{");
		const { exitCode } = runLauncher([f]);
		expect(exitCode).toBe(1);
	});

	test("YAML with bad indentation / tab characters exits 1", () => {
		const f = tmpYaml("team:\n\tname: broken-indent");
		const { exitCode } = runLauncher([f]);
		expect(exitCode).toBe(1);
	});

	test("empty file exits 1 with friendly message", () => {
		const f = tmpYaml("");
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("team.name is required");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Missing team fields
// ─────────────────────────────────────────────────────────────────────────────

describe("Missing team fields", () => {
	test("missing team section exits 1", () => {
		const f = tmpYaml(`
roles:
  eng:
    title: Eng
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: eng
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("team.name is required");
	});

	test("team.name empty string exits 1", () => {
		const f = tmpYaml(`
team:
  name: ""
roles:
  eng:
    title: Eng
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: eng
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("team.name is required");
	});

	test("team section present but name key absent exits 1", () => {
		const f = tmpYaml(`
team:
  broker: ws://localhost:7331
roles:
  eng:
    title: Eng
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: eng
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("team.name is required");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Missing or empty roles
// ─────────────────────────────────────────────────────────────────────────────

describe("Missing or empty roles", () => {
	test("roles section absent exits 1", () => {
		const f = tmpYaml(`
team:
  name: myteam
members:
  - name: Alice
    role: engineer
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("No roles defined");
	});

	test("roles section is an empty map exits 1", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles: {}
members:
  - name: Alice
    role: engineer
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("No roles defined");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Missing or empty members
// ─────────────────────────────────────────────────────────────────────────────

describe("Missing or empty members", () => {
	test("members section absent exits 1", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  eng:
    title: Eng
    model: gpt-4o
    systemPrompt: hi
    tools: all
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("No members defined");
	});

	test("members is an empty array exits 1", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  eng:
    title: Eng
    model: gpt-4o
    systemPrompt: hi
    tools: all
members: []
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("No members defined");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Unknown role reference
// ─────────────────────────────────────────────────────────────────────────────

describe("Unknown role references", () => {
	test("member with undefined role exits 1 with informative message", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  engineer:
    title: Engineer
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: nonexistent-role
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Unknown role");
		expect(stderr).toContain("nonexistent-role");
		expect(stderr).toContain("Alice");
	});

	test("one valid member and one bad role — still exits 1", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  engineer:
    title: Engineer
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: engineer
  - name: Bob
    role: ghost-role
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Unknown role");
		expect(stderr).toContain("ghost-role");
		expect(stderr).toContain("Bob");
	});

	test("role name is case-sensitive", () => {
		// "Engineer" (capital E) ≠ "engineer"
		const f = tmpYaml(`
team:
  name: myteam
roles:
  engineer:
    title: Engineer
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: Engineer
`);
		const { exitCode, stderr } = runLauncher([f]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Unknown role");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Valid configuration — passes all validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Valid configuration", () => {
	test("valid config passes all validation checks (no validation errors in stderr)", () => {
		const f = tmpYaml(VALID_YAML);
		const { exitCode, stderr } = runLauncher([f]);

		// With no tmux/cmux on the restricted PATH it exits 1, but the error
		// must be the multiplexer message — not any YAML validation error.
		expect(hasValidationError(stderr)).toBe(false);
		// Confirms validation was fully passed
		expect(stderr).toContain("cmux or tmux is required");
		expect(exitCode).toBe(1); // no multiplexer available in test env
	});

	test("valid config with tools: all passes validation", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  manager:
    title: Manager
    model: gpt-4o
    systemPrompt: You are {{name}}.
    tools: all
members:
  - name: Alice
    role: manager
`);
		const { stderr } = runLauncher([f]);
		expect(hasValidationError(stderr)).toBe(false);
		expect(stderr).toContain("cmux or tmux is required");
	});

	test("valid config with optional broker field passes validation", () => {
		const f = tmpYaml(`
team:
  name: myteam
  broker: ws://localhost:7331
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: You are {{name}}.
    tools:
      - bash
members:
  - name: Alice
    role: eng
`);
		const { stderr } = runLauncher([f]);
		expect(hasValidationError(stderr)).toBe(false);
	});

	test("member model override is accepted", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: default prompt
    tools: all
members:
  - name: Alice
    role: eng
    model: claude-opus-4   # overrides role model
`);
		const { stderr } = runLauncher([f]);
		expect(hasValidationError(stderr)).toBe(false);
	});

	test("member systemPrompt override is accepted", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: Base prompt for {{name}}.
    tools: all
members:
  - name: Alice
    role: eng
    systemPrompt: Extra context for Alice.
`);
		const { stderr } = runLauncher([f]);
		expect(hasValidationError(stderr)).toBe(false);
	});

	test("multiple members with different roles all pass validation", () => {
		const f = tmpYaml(`
team:
  name: engineering
roles:
  engineer:
    title: Software Engineer
    model: gpt-4o
    systemPrompt: You are {{name}}.
    tools:
      - bash
      - read
  qa:
    title: QA Engineer
    model: gpt-4o
    systemPrompt: You are {{name}}, QA.
    tools:
      - bash
  manager:
    title: Manager
    model: gpt-4o
    systemPrompt: You are {{name}}, PM.
    tools: all
members:
  - name: Alice
    role: manager
  - name: Bob
    role: engineer
  - name: Charlie
    role: qa
`);
		const { stderr } = runLauncher([f]);
		expect(hasValidationError(stderr)).toBe(false);
	});

	test("command output includes correct agent-name and room flags", () => {
		const f = tmpYaml(`
team:
  name: testteam
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: You are {{name}}.
    tools:
      - bash
members:
  - name: Alice
    role: eng
`);
		const { stderr } = runLauncher([f]);
		// The "no multiplexer" error includes the fallback command strings
		expect(stderr).toContain("--agent-name");
		expect(stderr).toContain("Alice");
		expect(stderr).toContain("--room");
		expect(stderr).toContain("testteam");
	});

	test("broker flag appears in command when team.broker is set", () => {
		const f = tmpYaml(`
team:
  name: testteam
  broker: ws://my-broker:9999
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: eng
`);
		const { stderr } = runLauncher([f]);
		expect(stderr).toContain("--broker");
		expect(stderr).toContain("ws://my-broker:9999");
	});

	test("model override appears in command when member model is set", () => {
		const f = tmpYaml(`
team:
  name: testteam
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: hi
    tools: all
members:
  - name: Alice
    role: eng
    model: claude-opus-4
`);
		const { stderr } = runLauncher([f]);
		expect(stderr).toContain("claude-opus-4");
		// Should NOT contain the role's default model
		expect(stderr).not.toContain("gpt-4o");
	});

	test("template interpolation replaces {{name}} and {{team}} in systemPrompt", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: "You are {{name}} on the {{team}} team."
    tools: all
members:
  - name: Alice
    role: eng
`);
		const { stderr } = runLauncher([f]);
		// The interpolated prompt appears in the --append-system-prompt arg
		expect(stderr).toContain("Alice");
		expect(stderr).toContain("myteam");
		// Unreplaced placeholders should NOT appear
		expect(stderr).not.toContain("{{name}}");
		expect(stderr).not.toContain("{{team}}");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Shell-escaping (shellEsc) edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("Shell escaping in generated commands", () => {
	test("single quotes in system prompt are properly escaped", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: "It's a test prompt."
    tools: all
members:
  - name: Alice
    role: eng
`);
		const { stderr } = runLauncher([f]);
		expect(hasValidationError(stderr)).toBe(false);
		// Proper shell-escape: ' → '\''
		expect(stderr).toContain("'\\''");
	});

	test("agent name with spaces is properly quoted in command", () => {
		const f = tmpYaml(`
team:
  name: myteam
roles:
  eng:
    title: Engineer
    model: gpt-4o
    systemPrompt: "hi"
    tools: all
members:
  - name: "Alice Smith"
    role: eng
`);
		const { stderr } = runLauncher([f]);
		expect(hasValidationError(stderr)).toBe(false);
		// The name should appear in the command, quoted safely
		expect(stderr).toContain("Alice Smith");
	});
});
