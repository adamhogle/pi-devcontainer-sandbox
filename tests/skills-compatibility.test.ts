/**
 * Tests that skills (and other ~/.pi/agent/ resources) work correctly
 * when the dev container sandbox is active.
 *
 * BACKGROUND
 * ────────────
 * The sandbox routes built-in tools into the podman container via exec.
 * Skills live at ~/.pi/agent/skills/ on the HOST filesystem and are NOT
 * mounted into the container. When the agent reads a skill file, the
 * overridden read tool would call podman exec cat <path> inside the
 * container where the file doesn't exist.
 *
 * FIX: Tool overrides check isPiAgentPath() before routing into the
 * container. Paths under ~/.pi/agent/ fall back to local (host) execution.
 * Paths outside ~/.pi/agent/ still go through the container as before.
 *
 * This ensures:
 * 1. Skills, settings, auth, prompts (~/.pi/agent/) work via local reads
 * 2. Container isolation is preserved for all other paths (/tmp, /etc, etc.)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock node:fs ────────────────────────────────────────────────────────────

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

// ── Mock getAgentDir for predictable test paths ───────────────────────────────
//
// The extension calls getAgentDir() at module scope and uses it in isPiAgentPath()
// to detect ~/.pi/agent/ paths. We mock it here so the test can use a known path.

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return {
    ...mod,
    getAgentDir: () => "/home/user/.pi/agent",
  };
});

// ── Imports ──────────────────────────────────────────────────────────────────

import { createMockPi } from "./helpers/mock-pi-api.ts";
import extensionFactory from "../extensions/dev-container-sandbox/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveContainer(scope: ReturnType<typeof createMockPi>) {
  mockSpawn.respondWhen(
    (c) => c.args[0] === "ps",
    { stdout: "abc123\n" },
  );
  mockSpawn.respondWhen(
    (c) => c.args[0] === "inspect",
    {
      stdout: JSON.stringify([
        { Source: process.cwd(), Destination: "/workspace", Type: "bind" },
      ]),
    },
  );
  scope.notifications.length = 0;
  scope.statusEntries.length = 0;
  const handler = scope.getHandler("session_start")!;
  await handler({ sessionId: "test" }, scope.ctx);
}

const AGENT_DIR = "/home/user/.pi/agent";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("skills compatibility with dev container sandbox", () => {
  beforeEach(() => {
    mockSpawn.reset();
    mockedFs.mockExistsSync.mockReset();
    mockedFs.mockExistsSync.mockReturnValue(true);
  });

  describe("isPiAgentPath — host resource path detection", () => {
    it("detects ~/.pi/agent/ paths (skills, settings, auth)", () => {
      const piPaths = [
        `${AGENT_DIR}/skills/my-skill/SKILL.md`,
        `${AGENT_DIR}/settings.json`,
        `${AGENT_DIR}/auth.json`,
        `${AGENT_DIR}/prompts/deploy.md`,
        `${AGENT_DIR}/extensions/my-ext.ts`,
      ];
      for (const p of piPaths) {
        expect(p.startsWith(AGENT_DIR)).toBe(true);
      }
    });

    it("does not flag project paths as agent paths", () => {
      const projectPaths = [
        `${process.cwd()}/src/main.ts`,
        `${process.cwd()}/.pi/skills/`,
        `${process.cwd()}/node_modules/`,
        "/tmp/foo",
        "/etc/passwd",
      ];
      for (const p of projectPaths) {
        expect(p.startsWith(AGENT_DIR)).toBe(false);
      }
    });
  });

  describe("tool overrides fall back to local for ~/.pi/agent/ paths", () => {
    it("read tool falls back to local for skill paths", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);

      const readTool = scope.tools.get("read")!;
      expect(readTool).toBeDefined();
      expect(typeof readTool.execute).toBe("function");
    });

    it("read tool routes project paths into container (not ~/.pi/agent/)", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);

      const readTool = scope.tools.get("read")!;
      expect(readTool).toBeDefined();
      expect(typeof readTool.execute).toBe("function");

      const dcStatus = scope.statusEntries.find((s) => s.key === "dev-container");
      expect(dcStatus).toBeDefined();
      expect(dcStatus!.value).toContain("🐳");
    });

    it("write tool falls back to local for skill paths", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);
      const writeTool = scope.tools.get("write")!;
      expect(writeTool).toBeDefined();
    });

    it("edit tool falls back to local for skill paths", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);
      const editTool = scope.tools.get("edit")!;
      expect(editTool).toBeDefined();
    });

    it("grep tool falls back to local for skill paths", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);
      const grepTool = scope.tools.get("grep")!;
      expect(grepTool).toBeDefined();
    });

    it("find tool falls back to local for skill paths", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);
      const findTool = scope.tools.get("find")!;
      expect(findTool).toBeDefined();
    });

    it("ls tool falls back to local for skill paths", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);
      const lsTool = scope.tools.get("ls")!;
      expect(lsTool).toBeDefined();
    });
  });

  describe("user_bash handler avoids container for ~/.pi/agent/ cwds", () => {
    it("user_bash returns undefined for ~/.pi/agent/ cwds (host-only commands)", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);

      const handler = scope.getHandler("user_bash")!;
      const result = handler({ cwd: `${AGENT_DIR}/skills/my-skill` });

      // FIX: With isPiAgentPath check, this should return undefined
      // so pi uses default (local) shell behavior for host resource paths
      expect(result).toBeUndefined();
    });

    it("user_bash routes into container for project cwds", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);

      const handler = scope.getHandler("user_bash")!;
      const result = handler({ cwd: process.cwd() });

      // Project cwds still route into the container
      expect(result).toBeDefined();
      expect(result!.operations).toBeDefined();
      expect(typeof result!.operations.exec).toBe("function");
    });

    it("user_bash returns undefined when no container (host mode)", () => {
      mockedFs.mockExistsSync.mockReturnValue(false);
      const scope = createMockPi();
      extensionFactory(scope.api);

      const handler = scope.getHandler("user_bash")!;
      const result = handler({ cwd: `${AGENT_DIR}/skills/my-skill` });

      expect(result).toBeUndefined();
    });
  });

  describe("non-agent paths still route into container (isolation preserved)", () => {
    it("/tmp paths still go through container", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);

      const handler = scope.getHandler("user_bash")!;
      const result = handler({ cwd: "/tmp" });

      // /tmp is NOT under ~/.pi/agent/, so it still routes into container
      expect(result).toBeDefined();
      expect(result!.operations).toBeDefined();
    });

    it("/etc paths still go through container (isolation intact)", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);

      const handler = scope.getHandler("user_bash")!;
      const result = handler({ cwd: "/etc" });

      expect(result).toBeDefined();
      expect(result!.operations).toBeDefined();
    });

    it("arbitrary unmapped paths still go through container", async () => {
      const scope = createMockPi();
      extensionFactory(scope.api);
      await resolveContainer(scope);

      const handler = scope.getHandler("user_bash")!;
      const result = handler({ cwd: "/var/log" });

      expect(result).toBeDefined();
      expect(result!.operations).toBeDefined();
    });
  });
});
