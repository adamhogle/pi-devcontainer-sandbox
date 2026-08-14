/**
 * Tests for getContainerWorkingDir and getContainerMounts.
 *
 * These functions use spawn internally (podman exec / podman inspect),
 * so we mock node:child_process.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mock = vi.hoisted(() => {
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
      child.kill = () => { child.killed = true; };
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
    callCount: () => calls.length,
    reset: () => { calls.length = 0; responders = []; spawnFn.mockClear(); },
  };
});

vi.mock("node:child_process", () => ({ spawn: mock.spawnFn }));

import {
  getContainerWorkingDir,
  getContainerMounts,
} from "../../extensions/dev-container-sandbox/operations.ts";

describe("getContainerWorkingDir", () => {
  beforeEach(() => mock.reset());

  it("returns the container's working directory", async () => {
    mock.respondWhen(
      (c) => c.args.includes("sh") && c.args.includes("-c"),
      { stdout: "/workspace/project\n" },
    );

    const dir = await getContainerWorkingDir("test-container");
    expect(dir).toBe("/workspace/project");
  });

  it("returns / when podman returns empty string", async () => {
    mock.respondWhen(
      (c) => c.args.includes("sh") && c.args.includes("-c"),
      { stdout: "" },
    );

    const dir = await getContainerWorkingDir("test-container");
    expect(dir).toBe("/");
  });

  it("trims trailing newline from result", async () => {
    mock.respondWhen(
      (c) => c.args.includes("sh") && c.args.includes("-c"),
      { stdout: "/workspace\n" },
    );

    const dir = await getContainerWorkingDir("test-container");
    expect(dir).toBe("/workspace");
  });
});

describe("getContainerMounts", () => {
  beforeEach(() => mock.reset());

  it("returns bind mounts from podman inspect", async () => {
    mock.respondWhen(
      (c) => c.args[0] === "inspect",
      {
        stdout: JSON.stringify([
          { Source: "/host/path", Destination: "/container/path", Type: "bind" },
        ]),
      },
    );

    const mounts = await getContainerMounts("test-container");
    expect(mounts).toEqual([
      { source: "/host/path", destination: "/container/path" },
    ]);
  });

  it("includes volume mounts alongside bind mounts", async () => {
    mock.respondWhen(
      (c) => c.args[0] === "inspect",
      {
        stdout: JSON.stringify([
          { Source: "/host/data", Destination: "/data", Type: "bind" },
          { Source: "my-volume", Destination: "/volume", Type: "volume" },
        ]),
      },
    );

    const mounts = await getContainerMounts("test-container");
    expect(mounts).toHaveLength(2);
    expect(mounts).toContainEqual({ source: "/host/data", destination: "/data" });
    expect(mounts).toContainEqual({ source: "my-volume", destination: "/volume" });
  });

  it("filters out non-bind non-volume types", async () => {
    mock.respondWhen(
      (c) => c.args[0] === "inspect",
      {
        stdout: JSON.stringify([
          { Source: "/host/path", Destination: "/container/path", Type: "bind" },
          { Source: "tmpfs", Destination: "/tmp", Type: "tmpfs" },
          { Source: "pipe", Destination: "/pipe", Type: "pipe" },
        ]),
      },
    );

    const mounts = await getContainerMounts("test-container");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toEqual({ source: "/host/path", destination: "/container/path" });
  });

  it("returns empty array on podman inspect failure (catch path)", async () => {
    mock.respondWhen(
      (c) => c.args[0] === "inspect",
      { stdout: "", exitCode: 1 },
    );

    const mounts = await getContainerMounts("bad-container");
    expect(mounts).toEqual([]);
  });

  it("returns empty array on JSON parse error (catch path)", async () => {
    mock.respondWhen(
      (c) => c.args[0] === "inspect",
      { stdout: "not valid json" },
    );

    const mounts = await getContainerMounts("test-container");
    expect(mounts).toEqual([]);
  });
});
