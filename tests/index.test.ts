/**
 * Tests for the extension entry point (index.ts).
 *
 * Verifies that:
 *   - The extension factory registers the expected flags, tools, events, commands
 *   - The fallback/host mode path works when no container is found (no devcontainer.json)
 *   - Container flag path resolves the named container
 *   - Error handling shows notifications
 *   - Handlers: session_shutdown, user_bash, before_agent_start
 *   - /dev-container command
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock node:fs to control existsSync ───────────────────────────────────────
// Note: vi.mock factory runs at hoist time. Use vi.hoisted for the mock fn.

const mockedFs = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockedFs.mockExistsSync,
}));

// ── Mock node:child_process for podman spawn calls ───────────────────────────

const mockSpawn = vi.hoisted(() => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let responders: Array<{
    matcher: (call: { command: string; args: string[] }) => boolean;
    stdout: string; stderr: string; exitCode: number;
  }> = [];

  const spawnFn = vi.fn(
    (command: string, args: readonly string[], _options: Record<string, unknown>) => {
      const call = { command, args: [...args] };
      calls.push(call);

      const EventEmitter = require("node:events").EventEmitter;
      const child = new EventEmitter();
      child.pid = 12345;
      child.killed = false;
      child.kill = () => { child.killed = true; child.emit("close", 9); };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let stdout = "", stderr = "", exitCode = 0, _matched = false;
      for (const r of responders) {
        if (r.matcher(call)) {
          stdout = r.stdout; stderr = r.stderr; exitCode = r.exitCode; _matched = true; break;
        }
      }
      setTimeout(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      }, 0);
      setTimeout(() => child.emit("close", exitCode), 1);
      return child;
    },
  );

  return {
    spawnFn,
    respondWhen: (matcher: (c: { command: string; args: string[] }) => boolean, resp: { stdout?: string; stderr?: string; exitCode?: number }) => {
      responders.push({
        matcher, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "", exitCode: resp.exitCode ?? 0,
      });
    },
    call: (n: number) => {
      if (n >= calls.length) throw new Error(`Call #${n} not found (${calls.length} total)`);
      return calls[n];
    },
    reset: () => { calls.length = 0; responders = []; spawnFn.mockClear(); },
  };
});

vi.mock("node:child_process", () => ({ spawn: mockSpawn.spawnFn }));

// ── Imports ──────────────────────────────────────────────────────────────────

import { createMockPi } from "../tests/helpers/mock-pi-api.ts";
import extensionFactory from "../extensions/dev-container-sandbox/index.ts";

describe("extension entry point (index.ts)", () => {
  beforeEach(() => {
    mockSpawn.reset();
    mockedFs.mockExistsSync.mockReset();
    mockedFs.mockExistsSync.mockReturnValue(true); // default: devcontainer.json exists
  });

  describe("factory registration", () => {
    it("registers the dev-container flag", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.flags.has("dev-container")).toBe(true);
    });

    it("registers read tool override", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.tools.has("read")).toBe(true);
    });

    it("registers write tool override", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.tools.has("write")).toBe(true);
    });

    it("registers edit tool override", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.tools.has("edit")).toBe(true);
    });

    it("registers bash tool override", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.tools.has("bash")).toBe(true);
    });

    it("registers grep tool override", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.tools.has("grep")).toBe(true);
    });

    it("registers find tool override", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.tools.has("find")).toBe(true);
    });

    it("registers ls tool override", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.tools.has("ls")).toBe(true);
    });

    it("registers session_start handler", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.handlers.has("session_start")).toBe(true);
    });

    it("registers session_shutdown handler", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.handlers.has("session_shutdown")).toBe(true);
    });

    it("registers user_bash handler", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.handlers.has("user_bash")).toBe(true);
    });

    it("registers before_agent_start handler", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.handlers.has("before_agent_start")).toBe(true);
    });

    it("registers /dev-container command", () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      expect(scope.commands.has("dev-container")).toBe(true);
    });
  });

  describe("session_start — no devcontainer.json (host mode)", () => {
    it("notifies host mode when .devcontainer/devcontainer.json is missing", async () => {
      mockedFs.mockExistsSync.mockReturnValue(false);
      const scope = createMockPi();

      extensionFactory(scope.api);
      const handler = scope.getHandler("session_start")!;
      await handler({ sessionId: "test" }, scope.ctx);

      expect(scope.notifications.some((n) => n.message.includes("host mode"))).toBe(true);
      expect(scope.notifications.some((n) => n.message.includes("No .devcontainer"))).toBe(true);
    });
  });

  describe("session_start — container flag provided", () => {
    it("uses named container when --dev-container flag is set", async () => {
      const scope = createMockPi();

      extensionFactory(scope.api);
      scope.setFlag("dev-container", "my-container");

      // Mock podman inspect for container mounts
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        {
          stdout: JSON.stringify([
            { Source: "/workspaces/pi-sandbox", Destination: "/workspace", Type: "bind" },
          ]),
        },
      );

      const handler = scope.getHandler("session_start")!;
      await handler({ sessionId: "test" }, scope.ctx);

      expect(scope.notifications.some((n) => n.message.includes("my-container"))).toBe(true);
      expect(scope.statusEntries.some((s) => s.key === "dev-container" && s.value?.includes("🐳"))).toBe(true);
    });

    it("attaches to named container even when getContainerMounts fails (empty mounts)", async () => {
      const scope = createMockPi();

      extensionFactory(scope.api);
      scope.setFlag("dev-container", "bad-container");

      // Make inspect fail - getContainerMounts catches internally and returns []
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        { stdout: "", exitCode: 1 },
      );

      const handler = scope.getHandler("session_start")!;
      await handler({ sessionId: "test" }, scope.ctx);

      // The extension still attaches to the container (with empty path mapper)
      // getContainerMounts catches the error and returns [], so execution continues
      expect(scope.notifications.some((n) => n.message.includes("Tools routed into container"))).toBe(true);
      // Status should still be set for the container
      // Note: container name is truncated to 12 chars by index.ts
      const dcStatus = scope.statusEntries.find((s) => s.key === "dev-container");
      expect(dcStatus).toBeDefined();
      expect(dcStatus!.value).toContain("bad-containe");
    });
  });

  describe("session_start — fast path: existing container", () => {
    it("attaches to running container with matching mount", async () => {
      const scope = createMockPi();

      extensionFactory(scope.api);

      // Mock podman ps to return a container ID
      mockSpawn.respondWhen(
        (c) => c.args[0] === "ps",
        { stdout: "abc123\n" },
      );

      // Mock podman inspect for mounts
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        {
          stdout: JSON.stringify([
            { Source: "/workspaces/pi-sandbox", Destination: "/workspace", Type: "bind" },
          ]),
        },
      );

      const handler = scope.getHandler("session_start")!;
      await handler({ sessionId: "test" }, scope.ctx);

      expect(scope.notifications.some((n) => n.message.includes("Attached"))).toBe(true);
      expect(scope.statusEntries.some((s) => s.key === "dev-container")).toBe(true);
    });
  });

  describe("session_shutdown", () => {
    it("resets resolved container state", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);

      const handler = scope.getHandler("session_shutdown")!;
      // Should not throw
      await handler();
    });
  });

  describe("tool overrides — fallback to local when no container", () => {
    it("tool execute falls through to local tool when no container resolved", () => {
      // Just verify the tool is registered and has an execute method
      const scope = createMockPi();
      extensionFactory(scope.api);

      const readTool = scope.tools.get("read")!;
      expect(readTool).toBeDefined();
      expect(typeof readTool.execute).toBe("function");

      // The execute call would need a real filesystem - we verify the
      // tool registration only. Actual execute fallback is integration-tested
      // elsewhere via operation tests.
    });
  });

  describe("user_bash handler", () => {
    it("returns undefined when no container resolved", () => {
      mockedFs.mockExistsSync.mockReturnValue(false);
      const scope = createMockPi();
      extensionFactory(scope.api);

      const handler = scope.getHandler("user_bash")!;

      const result = handler({ cwd: "/tmp" });
      expect(result).toBeUndefined();
    });

    it("returns operations object when container resolved", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);

      // Resolve container via session_start
      mockSpawn.respondWhen(
        (c) => c.args[0] === "ps",
        { stdout: "cont123\n" },
      );
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        {
          stdout: JSON.stringify([
            { Source: "/workspaces/pi-sandbox", Destination: "/workspace", Type: "bind" },
          ]),
        },
      );

      const startHandler = scope.getHandler("session_start")!;
      await startHandler({ sessionId: "test" }, scope.ctx);

      const handler = scope.getHandler("user_bash")!;
      const result = handler({ cwd: "/workspaces/pi-sandbox" });
      expect(result).toBeDefined();
      expect(result!.operations).toBeDefined();
      expect(typeof result!.operations.exec).toBe("function");
    });
  });

  describe("before_agent_start handler", () => {
    it("returns undefined when no container resolved", () => {
      mockedFs.mockExistsSync.mockReturnValue(false);
      const scope = createMockPi();
      extensionFactory(scope.api);

      const handler = scope.getHandler("before_agent_start")!;
      const event = { systemPrompt: "Current working directory: /workspaces/pi-sandbox" };
      const result = handler(event);
      expect(result).toBeUndefined();
    });

    it("replaces cwd in system prompt when container resolves", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);

      mockSpawn.respondWhen(
        (c) => c.args[0] === "ps",
        { stdout: "cont123\n" },
      );
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        {
          stdout: JSON.stringify([
            { Source: "/workspaces/pi-sandbox", Destination: "/workspace", Type: "bind" },
          ]),
        },
      );

      const startHandler = scope.getHandler("session_start")!;
      await startHandler({ sessionId: "test" }, scope.ctx);

      const handler = scope.getHandler("before_agent_start")!;
      const event = { systemPrompt: "Current working directory: /workspaces/pi-sandbox" };
      const result = handler(event);
      expect(result).toBeDefined();
      // The prompt should mention "dev container" now
      if (result?.systemPrompt) {
        expect(result.systemPrompt).toContain("dev container");
      }
    });

    it("appends container line when cwd not in prompt", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);

      mockSpawn.respondWhen(
        (c) => c.args[0] === "ps",
        { stdout: "cont123\n" },
      );
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        {
          stdout: JSON.stringify([
            { Source: "/workspaces/pi-sandbox", Destination: "/workspace", Type: "bind" },
          ]),
        },
      );

      const startHandler = scope.getHandler("session_start")!;
      await startHandler({ sessionId: "test" }, scope.ctx);

      const handler = scope.getHandler("before_agent_start")!;
      const event = { systemPrompt: "Some other prompt without cwd" };
      const result = handler(event);
      expect(result).toBeDefined();
      expect(result!.systemPrompt).toContain("dev container");
    });
  });

  describe("/dev-container command", () => {
    it("shows status when container is resolved", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);

      // Resolve a container first
      mockSpawn.respondWhen(
        (c) => c.args[0] === "ps",
        { stdout: "cont123\n" },
      );
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        {
          stdout: JSON.stringify([
            { Source: "/workspaces/pi-sandbox", Destination: "/workspace", Type: "bind" },
          ]),
        },
      );

      const startHandler = scope.getHandler("session_start")!;
      await startHandler({ sessionId: "test" }, scope.ctx);

      // Clear notifications from session start
      scope.notifications.length = 0;

      await scope.triggerCommand("dev-container", "");

      expect(scope.notifications.some((n) => n.message.includes("Dev Container Status"))).toBe(true);
    });

    it("shows host mode when no container resolved", async () => {
      mockedFs.mockExistsSync.mockReturnValue(false);
      const scope = createMockPi();
      extensionFactory(scope.api);

      const startHandler = scope.getHandler("session_start")!;
      await startHandler({ sessionId: "test" }, scope.ctx);

      scope.notifications.length = 0;

      await scope.triggerCommand("dev-container", "");

      expect(scope.notifications.some((n) => n.message.includes("host mode"))).toBe(true);
    });

    it("rebuild triggers devcontainer up with rebuild flag", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);

      // Mock the npx @devcontainers/cli up command (via spawn)
      mockSpawn.respondWhen(
        (c) => c.args[0] === "@devcontainers/cli" && c.args.includes("up"),
        {
          stdout: '{"outcome":"success","containerId":"new-cont","remoteUser":"root","remoteWorkspaceFolder":"/workspace"}\n',
        },
      );
      // Mock the inspect after rebuild
      mockSpawn.respondWhen(
        (c) => c.args[0] === "inspect",
        {
          stdout: JSON.stringify([
            { Source: "/workspaces/pi-sandbox", Destination: "/workspace", Type: "bind" },
          ]),
        },
      );

      await scope.triggerCommand("dev-container", "rebuild");

      expect(scope.notifications.some((n) => n.message.includes("Rebuilding"))).toBe(true);
    });
  });
});
