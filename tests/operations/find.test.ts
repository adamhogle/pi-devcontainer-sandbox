/**
 * Tests for createPodmanFindOps.
 *
 * This includes a regression test for Bug 15: find glob must return paths
 * RELATIVE to the search root, because the SDK's relativizeFindResultPath
 * receives searchPath as a host Windows path and resultPath as a container
 * Linux path — path.relative() can't compute a valid relative between them.
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

import { createPodmanFindOps } from "../../extensions/dev-container-sandbox/operations.ts";
import type { PathMapper } from "../../extensions/dev-container-sandbox/operations.ts";

const testMapper: PathMapper = {
  toContainer: (p: string) => p.replace(/^C:/, ""),
  containerCwd: "/Users/Adam/project",
};

describe("createPodmanFindOps", () => {
  beforeEach(() => mock.reset());

  it("glob builds correct find command with translated searchRoot", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      { stdout: "/Users/Adam/project/src/main.ts\n/Users/Adam/project/src/utils.ts\n" },
    );

    const _results = await ops.glob("*.ts", "C:/Users/Adam", { limit: 100 });

    // Should have called podman exec with a find command
    expect(mock.call(0).args).toContain("exec");
    expect(mock.call(0).args).toContain("test-container");
    const findCmd = mock.call(0).args.find((a) => a.startsWith("find"));
    expect(findCmd).toBeDefined();
    // searchRoot should be translated
    expect(findCmd).toContain("/Users/Adam"); // translated from C:/Users/Adam
    expect(findCmd).toContain("-name");
    expect(findCmd).toContain("'*.ts'");
    expect(findCmd).toContain("-print");
    expect(findCmd).toContain("head -100");
  });

  it("glob returns results relative to searchRoot (Bug 15 regression)", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    // Simulate find returning absolute container paths
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      {
        stdout: [
          "/Users/Adam/project/src/main.ts",
          "/Users/Adam/project/src/utils.ts",
          "/Users/Adam/project/tests/test.ts",
        ].join("\n"),
      },
    );

    const results = await ops.glob("*.ts", "C:/Users/Adam/project", {
      limit: 100,
      cwd: "C:/Users/Adam/project",
    });

    // Results MUST be relative to the searchRoot to avoid corrupt relativization
    // in the SDK's relativizeFindResultPath on Windows.
    // After prefix stripping: "src/main.ts", "src/utils.ts", "tests/test.ts"
    expect(results).toEqual([
      "src/main.ts",
      "src/utils.ts",
      "tests/test.ts",
    ]);
  });

  it("glob strips searchRoot prefix when results have trailing slash", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      { stdout: "/Users/Adam/project/my.dir/\n/Users/Adam/project/other/\n" },
    );

    const results = await ops.glob("*", "C:/Users/Adam/project", { limit: 100 });

    expect(results).toContain("my.dir/");
    expect(results).toContain("other/");
  });

  it("glob returns exact match as '.' when result equals searchRoot", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      { stdout: "/Users/Adam/project\n" },
    );

    const results = await ops.glob("*", "C:/Users/Adam/project", { limit: 100 });

    expect(results).toEqual(["."]);
  });

  it("glob builds prune clauses for ignore patterns", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      { stdout: "" },
    );

    await ops.glob("*.ts", "C:/Users/Adam/project", {
      limit: 100,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    const findCmd = mock.call(0).args.find((a) => a.startsWith("find"));
    expect(findCmd).toBeDefined();
    // Should contain prune clauses for node_modules and .git
    expect(findCmd).toContain("node_modules");
    expect(findCmd).toContain(".git");
    expect(findCmd).toContain("-prune");
  });

  it("glob does not include prune clause when ignore is empty", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      { stdout: "" },
    );

    await ops.glob("*.ts", "C:/Users/Adam/project", { limit: 100 });

    const findCmd = mock.call(0).args.find((a) => a.startsWith("find"));
    expect(findCmd).not.toContain("-prune");
  });

  it("glob passes path as-is without pathMapper", async () => {
    const ops = createPodmanFindOps("test-container");
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      { stdout: "" },
    );

    await ops.glob("*.ts", "C:/raw/path", { limit: 100 });

    const findCmd = mock.call(0).args.find((a) => a.startsWith("find"));
    expect(findCmd).toContain("C:/raw/path");
  });

  it("exists delegates to test -e", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("test") && c.args.includes("-e"), { stdout: "" });
    expect(await ops.exists("C:/project/file.ts")).toBe(true);
    expect(mock.call(0).args).toContain("-e");
    expect(mock.call(0).args).toContain("/project/file.ts");
  });

  it("exists returns false on non-zero exit", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("test") && c.args.includes("-e"), { stdout: "", exitCode: 1 });
    expect(await ops.exists("C:/project/missing.ts")).toBe(false);
  });
});

  it("glob passes through results that don't match searchRoot (fallback)", async () => {
    const ops = createPodmanFindOps("test-container", testMapper);
    mock.respondWhen(
      (c) => c.args.some((a) => a.startsWith("find")),
      { stdout: "/some/random/path\n/another/random/file.ts\n" },
    );

    const results = await ops.glob("*.ts", "C:/Users/Adam/project", { limit: 100 });

    // These paths don't match the searchRoot prefix, so they fall through unchanged
    expect(results).toEqual(["/some/random/path", "/another/random/file.ts"]);
  });
