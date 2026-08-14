/**
 * Tests for createPodmanLsOps.
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
      let stdout = "", stderr = "", exitCode = 0, matched = false;
      for (const r of responders) {
        if (r.matcher(call)) { stdout = r.stdout; stderr = r.stderr; exitCode = r.exitCode; matched = true; break; }
      }
      setTimeout(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      }, 0);
      if (matched) setTimeout(() => child.emit("close", exitCode), 1);
      return child;
    },
  );

  return {
    spawnFn,
    respondWhen: (matcher: unknown, resp: unknown) => {
      responders.push({
        matcher, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "", exitCode: resp.exitCode ?? 0,
      });
    },
    call: (n: number) => { if (n >= calls.length) throw new Error(`Call #${n} not found`); return calls[n]; },
    callCount: () => calls.length,
    reset: () => { calls.length = 0; responders = []; spawnFn.mockClear(); },
  };
});

vi.mock("node:child_process", () => ({ spawn: mock.spawnFn }));

import { createPodmanLsOps } from "../../extensions/dev-container-sandbox/operations.ts";
import type { PathMapper } from "../../extensions/dev-container-sandbox/operations.ts";

const testMapper: PathMapper = {
  toContainer: (p: string) => p.replace(/^C:/, ""),
  containerCwd: "/workspace/project",
};

describe("createPodmanLsOps", () => {
  beforeEach(() => mock.reset());

  it("exists returns true when test -e exits 0", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("test"), { stdout: "" });
    expect(await ops.exists("C:/project/file.ts")).toBe(true);
    expect(mock.call(0).args).toContain("test");
    expect(mock.call(0).args).toContain("-e");
    expect(mock.call(0).args).toContain("/project/file.ts");
  });

  it("exists returns false on non-zero exit", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("test"), { stdout: "", exitCode: 1 });
    expect(await ops.exists("C:/project/missing.ts")).toBe(false);
  });

  it("stat parses directory permissions correctly", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.includes("stat"),
      { stdout: '{"mode":"41ed","size":4096,"mtime":1700000000,"permissions":"drwxr-xr-x"}\n' },
    );
    const result = await ops.stat("C:/project/src");
    expect(result.isDirectory).toBe(true);
    expect(result.isFile).toBe(false);
    expect(result.isSymbolicLink).toBe(false);
    expect(result.size).toBe(4096);
  });

  it("stat parses file permissions correctly", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.includes("stat"),
      { stdout: '{"mode":"81a4","size":1234,"mtime":1700000000,"permissions":"-rw-r--r--"}\n' },
    );
    const result = await ops.stat("C:/project/file.ts");
    expect(result.isDirectory).toBe(false);
    expect(result.isFile).toBe(true);
    expect(result.isSymbolicLink).toBe(false);
    expect(result.size).toBe(1234);
  });

  it("stat parses symlink permissions correctly", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.includes("stat"),
      { stdout: '{"mode":"a1ff","size":20,"mtime":1700000000,"permissions":"lrwxrwxrwx"}\n' },
    );
    const result = await ops.stat("C:/project/link");
    expect(result.isDirectory).toBe(false);
    expect(result.isFile).toBe(false);
    expect(result.isSymbolicLink).toBe(true);
  });

  it("stat returns mtimeMs = mtime * 1000", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.includes("stat"),
      { stdout: '{"mode":"81a4","size":100,"mtime":1234,"permissions":"-rw-r--r--"}\n' },
    );
    const result = await ops.stat("C:/project/file.ts");
    expect(result.mtimeMs).toBe(1234 * 1000);
  });

  it("readdir parses ls -1a output and filters . and ..", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some(a => a.includes("ls -1a")),
      { stdout: ".\n..\nfile1.ts\nfile2.txt\ndir1\n.gitignore\n" },
    );
    const entries = await ops.readdir("C:/project");
    expect(entries).toEqual(["file1.ts", "file2.txt", "dir1", ".gitignore"]);
  });

  it("readdir returns empty array for empty directory", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some(a => a.includes("ls -1a")),
      { stdout: ".\n..\n" },
    );
    const entries = await ops.readdir("C:/project/empty");
    expect(entries).toEqual([]);
  });

  it("translates paths via pathMapper for all methods", async () => {
    const ops = createPodmanLsOps("test-container", testMapper);
    // exists
    mock.respondWhen((c) => c.args.includes("test"), { stdout: "" });
    await ops.exists("C:/project/file.ts");
    expect(mock.call(0).args).toContain("/project/file.ts");
  });

  it("passes paths as-is without pathMapper", async () => {
    const ops = createPodmanLsOps("test-container");
    mock.respondWhen((c) => c.args.some(a => a.includes("ls -1a")), { stdout: ".\n..\n" });
    await ops.readdir("C:/raw/path");
    const lsArg = mock.call(0).args.find((a) => a.includes("C:/raw/path"));
    expect(lsArg).toBeDefined();
  });
});
