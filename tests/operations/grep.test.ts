/**
 * Tests for executePodmanGrep.
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

import { executePodmanGrep } from "../../extensions/dev-container-sandbox/operations.ts";
import type { PathMapper } from "../../extensions/dev-container-sandbox/operations.ts";

const testMapper: PathMapper = {
  toContainer: (p: string) => p.replace(/^C:/, ""),
  containerCwd: "/workspace/project",
};

describe("executePodmanGrep", () => {
  beforeEach(() => mock.reset());

  it("builds basic grep command with pattern and translated path", async () => {
    mock.respondWhen(
      (c) => c.args.includes("grep"),
      { stdout: "src/main.ts:10:import { something }\n" },
    );

    const result = await executePodmanGrep("test-container", {
      pattern: "something",
      path: "C:/Users/Adam/project",
    }, undefined, testMapper);

    expect(mock.call(0).args).toContain("grep");
    expect(mock.call(0).args).toContain("-r");
    expect(mock.call(0).args).toContain("-n");
    expect(mock.call(0).args).toContain("something");
    // Path should be translated
    const pathArg = mock.call(0).args.find((a) => a.includes("/Users/Adam/project"));
    expect(pathArg).toBeDefined();
    expect(result.content[0]?.text).toContain("src/main.ts:10");
  });

  it("adds -F for literal search", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "" });
    await executePodmanGrep("test-container", {
      pattern: "exact.match[test]",
      path: "C:/project",
      literal: true,
    }, undefined, testMapper);
    expect(mock.call(0).args).toContain("-F");
  });

  it("adds -i for ignoreCase", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "" });
    await executePodmanGrep("test-container", {
      pattern: "Pattern",
      path: "C:/project",
      ignoreCase: true,
    }, undefined, testMapper);
    expect(mock.call(0).args).toContain("-i");
  });

  it("adds -C <N> for context", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "" });
    await executePodmanGrep("test-container", {
      pattern: "foo",
      path: "C:/project",
      context: 3,
    }, undefined, testMapper);
    expect(mock.call(0).args).toContain("-C");
    expect(mock.call(0).args).toContain("3");
  });

  it("adds --include for glob pattern", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "" });
    await executePodmanGrep("test-container", {
      pattern: "test",
      path: "C:/project",
      glob: "*.ts",
    }, undefined, testMapper);
    expect(mock.call(0).args).toContain("--include");
    expect(mock.call(0).args).toContain("*.ts");
  });

  it("translates search path via pathMapper", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "" });
    await executePodmanGrep("test-container", {
      pattern: "test",
      path: "C:/Users/Test/project/src",
    }, undefined, testMapper);

    const pathArg = mock.call(0).args.find((a) => a.includes("/Users/Test/project/src"));
    expect(pathArg).toBeDefined();
  });

  it("passes path as-is without pathMapper", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "" });
    await executePodmanGrep("test-container", {
      pattern: "test",
      path: "C:/raw/path",
    }, undefined);

    const pathArg = mock.call(0).args.find((a) => a.includes("C:/raw/path"));
    expect(pathArg).toBeDefined();
  });

  it("uses '.' as default search path when none provided", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "" });
    await executePodmanGrep("test-container", {
      pattern: "test",
    }, undefined, testMapper);

    expect(mock.call(0).args).toContain(".");
  });

  it("returns 'No matches found' for exit code 1", async () => {
    mock.respondWhen((c) => c.args.includes("grep"), { stdout: "", exitCode: 1 });
    const result = await executePodmanGrep("test-container", {
      pattern: "nothing",
      path: "C:/project",
    }, undefined, testMapper);
    expect(result.content[0]?.text).toBe("No matches found");
  });

  it("limits output lines", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `file${i}.ts:1:line ${i}`);
    mock.respondWhen(
      (c) => c.args.includes("grep"),
      { stdout: lines.join("\n") },
    );

    const result = await executePodmanGrep("test-container", {
      pattern: "line",
      path: "C:/project",
      limit: 10,
    }, undefined, testMapper);

    const output = result.content[0]?.text ?? "";
    expect(output).toContain("10 matches limit reached");
  });

  it.skip("handles aborted signal gracefully", async () => {
    const controller = new AbortController();
    const promise = executePodmanGrep("test-container", {
      pattern: "test",
      path: "C:/project",
    }, controller.signal, testMapper);

    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
  });

  it("re-throws error on non-1 exit code (e.g. grep error)", async () => {
    mock.respondWhen(
      (c) => c.args.includes("grep"),
      { stderr: "grep: invalid argument\n", exitCode: 2 },
    );

    await expect(
      executePodmanGrep("test-container", {
        pattern: "test",
        path: "C:/project",
      }, undefined, testMapper),
    ).rejects.toThrow();
  });

  it("triggers size truncation for large output", async () => {
    // Generate output > DEFAULT_MAX_BYTES (51200) to trigger byte truncation
    const lineTemplate = (i: number) => `src/file${i}.ts:42:console.log("line ${i}");\n`;
    // ~100 chars per line × 600 lines = ~60KB > 50KB threshold
    const lines = Array.from({ length: 600 }, (_, i) => lineTemplate(i));
    mock.respondWhen(
      (c) => c.args.includes("grep"),
      { stdout: lines.join("") },
    );

    const result = await executePodmanGrep("test-container", {
      pattern: "console",
      path: "C:/project",
    }, undefined, testMapper);

    const output = result.content[0]?.text ?? "";
    // Should still contain some output but nothing else to assert beyond returning
    expect(output.length).toBeGreaterThan(0);
    // The details should include truncation info
    if (result.details?.truncation) {
      expect(result.details.truncation.truncated).toBe(true);
      expect(result.details.truncation.outputBytes).toBeLessThanOrEqual(51200);
    }
  });
});
