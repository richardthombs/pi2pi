# Pi2Pi Testing Strategy

## Philosophy

Pi2Pi orchestrates real processes across multiple platforms using external
tools (tmux, psmux, cmux), a WebSocket broker, and the pi CLI. Its failure
modes are unusual: bugs often only surface at the moment a multiplexer session
is launched or when a broker message is delivered. The standard approach of
"run the code and see what happens" is not sufficient — by the time a failure
is visible, a user is staring at a broken terminal session.

The strategy has two principles:

**Catch errors as early as possible.** A bug caught by the type checker is
better than one caught by a unit test. A bug caught by a unit test is better
than one caught by an integration test. Prefer fast, deterministic checks over
slow, environment-dependent ones.

**Every execution path must be exercised before it reaches a user.** If a
function writes files, calls an external tool, or sends data over a socket, it
must have a test that exercises the complete path — even if that means creating
a fake version of the external tool. Untested code paths are bugs waiting to
happen.

---

## Test Layers

Pi2Pi uses four layers. Each has a specific scope and a specific reason to
exist.

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 4 — Live platform integration                         │
│  Real tmux / psmux / cmux / broker, skipped if not present  │
├──────────────────────────────────────────────────────────────┤
│  Layer 3 — Subprocess integration                            │
│  Real broker process, fake multiplexer executables,          │
│  real CLI subprocess                                         │
├──────────────────────────────────────────────────────────────┤
│  Layer 2 — Unit + mock                                       │
│  Pure functions, mock WebSocket, mock pi ExtensionAPI        │
├──────────────────────────────────────────────────────────────┤
│  Layer 1 — Static analysis                                   │
│  TypeScript type checker (tsc --noEmit)                      │
└──────────────────────────────────────────────────────────────┘
```

Lower layers are faster, more reliable, and should cover more ground. Higher
layers exist to validate things lower layers cannot reach.

---

## Layer 1 — Static Analysis

```bash
bun run typecheck   # runs: tsc --noEmit
```

This is the highest-value check in the entire suite relative to its cost. It
catches missing imports, wrong argument types, and structural mismatches when
an interface changes and call sites are not updated — entire categories of
runtime error that have no other early-warning mechanism.

**`bun run typecheck` must pass before any merge.** Bun's test runner
transpiles TypeScript without type-checking it, so type errors are completely
silent during `bun test`. The typecheck step is the only thing standing between
a structural mistake and a runtime crash.

New code must not introduce new type errors. Fixing a type error with
`as unknown as X` or `// @ts-ignore` is not acceptable unless the underlying
type definition is genuinely wrong and a corresponding fix is not feasible.

---

## Layer 2 — Unit and Mock Tests

These tests run in milliseconds. Every pure function and every module with
injectable dependencies should be covered here.

### Pure functions

Pure functions are the highest-value unit test targets because they are
completely deterministic and require no setup. A function that takes inputs and
returns outputs with no side effects should always have direct unit tests.

Examples of the kind of functions that belong here: multiplexer selection
logic, layout algorithms, command sequence builders, argument constructors,
config serialisation, string escaping, prompt interpolation.

### Mock-based tests

Some code has side effects but those effects are on injected dependencies. Test
these with mocks that record what they received and inject controlled responses.

The canonical pattern in this codebase is `tests/pi2pi-extension.test.ts`:
`FakeWebSocket` simulates the broker connection and `MockPi` captures all
registered handlers, tools, and flags. The extension's full message delivery
lifecycle is tested without a network or a real pi process. This is the correct
approach for any code that uses WebSockets, the broker protocol, or the pi
`ExtensionAPI`.

```typescript
// Pattern: fake external dependency, drive internal logic directly
const ws = new FakeWebSocket();
ws.triggerOpen();
ws.inject(JSON.stringify({ type: "incoming", from: "Alice", content: "hello" }));
expect(ws.sent).toContainEqual(expect.stringContaining('"type":"ack"'));
```

---

## Layer 3 — Subprocess Integration Tests

These tests spawn real processes or use fake executable binaries on the PATH.
They validate the complete call chain from a public entry point down to file
writes and process invocations.

### The fake-executable pattern

This is the central technique for testing code that calls external tools such
as tmux, psmux, or cmux. The approach:

1. Write a small shell script (or `.ps1` on Windows) that records its
   arguments to a file and exits successfully.
2. Place it in a temp directory prepended to `PATH` so it shadows the real
   tool.
3. Call the production function under test.
4. Assert on what was recorded and what files were written to disk.

```typescript
const fakeDir = mkdtempSync(join(tmpdir(), "fake-bins-"));
const logPath  = join(fakeDir, "invocations.log");
const fakeBin  = join(fakeDir, "cmux");

writeFileSync(fakeBin, [
  "#!/bin/sh",
  `echo "$@" >> '${logPath}'`,
  'if [ "$1" = "ping" ]; then echo PONG; fi',
].join("\n"), "utf8");
chmodSync(fakeBin, 0o755);

const savedPath = process.env.PATH;
process.env.PATH = `${fakeDir}:${savedPath}`;
try {
  startOrchestration(loaded);
} finally {
  process.env.PATH = savedPath;
}

const calls = readFileSync(logPath, "utf8").trim().split("\n");
// assert on calls...
```

This pattern ensures the function under test executes its entire code path —
file writes, argument construction, external tool invocation — without
requiring the real tool to be installed.

### Real CLI subprocess tests

The `pit` CLI is tested by spawning `bun cli.ts` as a real subprocess. This
validates argument parsing, error handling, and output formatting end-to-end.
Every CLI command must have at least a happy-path test and a test for the most
likely error case.

```typescript
const result = run(["--config", configPath, "orchestration", "start"], cwd);
expect(result.exitCode).toBe(0);
expect(result.stdout).toContain("Started orchestration");
```

For commands that call external tools, combine this with the fake-executable
pattern: prepend a fake binary to `PATH` in the subprocess environment.

### Real broker tests

`tests/broker.test.ts` spins up a real broker subprocess on a dedicated port.
This is the correct approach for testing the broker wire protocol: any change
to message types, routing logic, or connection handling must be accompanied by
a test that exercises the actual broker process over a real WebSocket.

### Restricted-PATH pattern

When testing that validation logic fires *before* an external tool is invoked,
strip the PATH down to the minimum:

```typescript
const SAFE_PATH = "/bin:/usr/bin";
const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
  env: { ...process.env, PATH: SAFE_PATH },
  stdout: "pipe", stderr: "pipe",
});
// If validation is correct, error occurs before any tool is called
```

This ensures validation errors are actually caught early rather than being
shadowed by a tool-not-found error.

---

## Layer 4 — Live Platform Integration Tests

These tests require real tools on the machine and skip gracefully when not
present. They validate things that cannot be asserted from the outside: actual
pane geometry, real WebSocket behaviour under load, genuine OS-level process
creation.

The pattern from `tests/psmux-integration.test.ts` is the model for all live
tests:

```typescript
const skip = !toolAvailable("tmux");
const maybeTest = skip ? test.skip : test;

maybeTest("n=5 agents produce correct pane geometry on live tmux", () => {
  // ...
});
```

A live test must never fail with an ambiguous error when the tool is simply
absent. Use `test.skip` (or the `maybeTest` pattern) explicitly.

---

## The Development Loop

Every change must pass these checks before merging:

```bash
bun run typecheck   # must produce zero errors
bun test            # must produce zero failures
```

The order matters. Run `typecheck` first. Type errors indicate structural
problems that may make tests meaningless. Fix type errors before writing tests.

When changing code in `multiplexer.ts` or `process-manager.ts`, also manually
verify that `pit orchestration start` produces a working session on your
platform, since these modules ultimately depend on a real terminal multiplexer
that no fake can fully replicate.

---

## Rules for New Code

**Adding a pure function**: add unit tests covering the happy path and the
primary error case before the PR is complete.

**Adding a side-effecting function** that writes files, spawns processes, or
calls an external tool: add a subprocess integration test using the
fake-executable pattern. The test must assert on what was written to disk and
what the external tool received.

**Changing a function's signature**: run `bun run typecheck` first and fix all
new type errors before writing tests.

**Adding a CLI command**: add a test in `tests/cli.test.ts` covering the happy
path, at least one error case, and — if the command touches the filesystem or
an external tool — using a temp directory and the fake-executable pattern.

**Adding a broker message type**: add a test in `tests/broker.test.ts` that
sends the message and asserts on the expected response or side effect using a
real broker subprocess.

**Adding a pi2pi extension tool or event handler**: add a test in
`tests/pi2pi-extension.test.ts` using `MockPi` and `FakeWebSocket`.

**Adding a new platform path** (e.g. a new multiplexer): add a live integration
test that skips gracefully when the tool is absent, following
`tests/psmux-integration.test.ts`.

---

## File Reference

| File | Covers | Pattern |
|---|---|---|
| `tests/cli.test.ts` | `pit` CLI commands end-to-end | Real CLI subprocess |
| `tests/broker.test.ts` | Broker WebSocket protocol | Real broker subprocess |
| `tests/multiplexer.test.ts` | Selection, layout, command sequences | Pure function + fake git |
| `tests/psmux-integration.test.ts` | psmux pane geometry | Live psmux, graceful skip |
| `tests/pi2pi-extension.test.ts` | Extension message delivery | `MockPi` + `FakeWebSocket` |
| `tests/pi2pi-footer-format.test.ts` | Footer rendering | Pure function |
| `tests/process-manager.test.ts` | Launch spec generation, overlord args | Pure function |
| `tests/config-store.test.ts` | Config serialisation, role loading | Pure function |
| `tests/workspace-manager.test.ts` | Worktree clone layout | Real git subprocess |
| `tests/launcher.test.ts` | YAML validation | Real subprocess, restricted PATH |
| `tests/pit-init.test.ts` | `pit init` directory structure | Real subprocess |
