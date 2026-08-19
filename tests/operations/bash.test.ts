/**
 * Tests for createPodmanBashOps.
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
      child.kill = () => { child.killed = true; child.emit("close", 9); };
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
      responders.push({ matcher, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "", exitCode: resp.exitCode ?? 0 });
    },
    call: (n: number) => { if (n >= calls.length) throw new Error(`Call #${n} not found`); return calls[n]; },
    callCount: () => calls.length,
    reset: () => { calls.length = 0; responders = []; spawnFn.mockClear(); },
  };
});

vi.mock("node:child_process", () => ({ spawn: mock.spawnFn }));

import { createPodmanBashOps } from "../../extensions/dev-container-sandbox/operations.ts";
import type { PathMapper } from "../../extensions/dev-container-sandbox/operations.ts";

const testMapper: PathMapper = {
  toContainer: (p: string) => p.replace(/^C:/, ""),
  containerCwd: "/workspace/project",
};

const dummyOnData = () => {};

describe("createPodmanBashOps", () => {
  beforeEach(() => mock.reset());

  it("prepends cd with translated cwd to command", async () => {
    const ops = createPodmanBashOps("test-container", testMapper);
    mock.respondWhen(() => true, { stdout: "hello\n" });

    const result = await ops.exec("echo hello", "C:/Users/Test/project", {
      onData: dummyOnData,
    });

    expect(result.exitCode).toBe(0);
    const call = mock.call(0);
    expect(call.command).toBe("podman");
    expect(call.args).toContain("exec");
    expect(call.args).toContain("test-container");
    expect(call.args).toContain("bash");
    expect(call.args).toContain("-lc");

    const cmdArg = call.args.find((a) => a.includes("echo hello"));
    expect(cmdArg).toBeDefined();
    expect(cmdArg).toContain("cd");
    expect(cmdArg).toContain("/Users/Test/project"); // translated cwd
    expect(cmdArg).toContain("echo hello");
  });

  it("passes cwd as-is without pathMapper", async () => {
    const ops = createPodmanBashOps("test-container");
    mock.respondWhen(() => true, { stdout: "ok\n" });

    await ops.exec("echo ok", "C:/raw/path", {
      onData: dummyOnData,
    });

    const cmdArg = mock.call(0).args.find((a) => a.includes("echo ok"));
    expect(cmdArg).toContain("C:/raw/path");
  });

  it("streams stdout data via onData callback", async () => {
    const ops = createPodmanBashOps("test-container", testMapper);
    const chunks: string[] = [];
    mock.respondWhen(() => true, { stdout: "line1\nline2\n" });

    await ops.exec("echo lines", "C:/project", {
      onData: (chunk: Buffer) => chunks.push(chunk.toString()),
    });

    expect(chunks.join("")).toBe("line1\nline2\n");
  });

  it("streams stderr data via onData callback", async () => {
    const ops = createPodmanBashOps("test-container", testMapper);
    const chunks: string[] = [];
    mock.respondWhen(() => true, { stderr: "warning: something\n" });

    await ops.exec("cmd", "C:/project", {
      onData: (chunk: Buffer) => chunks.push(chunk.toString()),
    });

    expect(chunks.join("")).toBe("warning: something\n");
  });

  it("resolves with exitCode on completion", async () => {
    const ops = createPodmanBashOps("test-container", testMapper);
    mock.respondWhen(() => true, { stdout: "done", exitCode: 0 });

    const result = await ops.exec("true", "C:/project", {
      onData: dummyOnData,
    });
    expect(result.exitCode).toBe(0);
  });

  it("resolves with exitCode even on non-zero exit", async () => {
    const ops = createPodmanBashOps("test-container", testMapper);
    mock.respondWhen(() => true, { stderr: "error", exitCode: 1 });

    const result = await ops.exec("false", "C:/project", {
      onData: dummyOnData,
    });
    expect(result.exitCode).toBe(1);
  });

  it("abort signal kills child process", async () => {
    const ops = createPodmanBashOps("test-container", testMapper);
    const controller = new AbortController();
    mock.respondWhen(() => true, { stdout: "never", exitCode: 0 });

    const promise = ops.exec("sleep 60", "C:/project", {
      onData: dummyOnData,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
  });

  it("timeout rejects when execution exceeds timeout (no close emitted)", async () => {
    const ops = createPodmanBashOps("test-container", testMapper);
    // Deliberately NOT calling respondWhen — mock spawn receives no matcher,
    // so `matched` stays false and `close` is never emitted.
    // The timeout will fire and kill the child.
    await expect(
      ops.exec("slow-command", "C:/project", {
        onData: dummyOnData,
        timeout: 0.01, // 10ms — enough to set up, short enough to test
      }),
    ).rejects.toThrow("timeout");
  }, 5000);
});


  describe("env var forwarding", () => {
    beforeEach(() => mock.reset());

    it("includes --env args when envVars provided", async () => {
      const ops = createPodmanBashOps("test-container", testMapper, {
        API_KEY: "sk-123",
        TOKEN: "abc",
      });
      mock.respondWhen(() => true, { stdout: "ok\n" });

      await ops.exec("echo ok", "C:/project", { onData: dummyOnData });

      const call = mock.call(0);
      const execIndex = call.args.indexOf("exec");
      const containerIndex = call.args.indexOf("test-container");
      const envArgs = call.args.slice(execIndex + 1, containerIndex);
      expect(envArgs).toContain("--env");
      const envVals = envArgs.filter((a) => a !== "--env");
      expect(envVals).toContain("API_KEY=sk-123");
      expect(envVals).toContain("TOKEN=abc");
    });

    it("does not include --env when envVars is empty", async () => {
      const ops = createPodmanBashOps("test-container", testMapper, {});
      mock.respondWhen(() => true, { stdout: "ok\n" });

      await ops.exec("echo ok", "C:/project", { onData: dummyOnData });

      const call = mock.call(0);
      expect(call.args).not.toContain("--env");
    });

    it("does not include --env when envVars is undefined", async () => {
      const ops = createPodmanBashOps("test-container", testMapper);
      mock.respondWhen(() => true, { stdout: "ok\n" });

      await ops.exec("echo ok", "C:/project", { onData: dummyOnData });

      const call = mock.call(0);
      expect(call.args).not.toContain("--env");
    });

    it("passes multiple env vars correctly", async () => {
      const ops = createPodmanBashOps("test-container", undefined, {
        ONE: "1",
        TWO: "2",
        THREE: "3",
      });
      mock.respondWhen(() => true, { stdout: "ok\n" });

      await ops.exec("echo ok", "/path", { onData: dummyOnData });

      const call = mock.call(0);
      const execIndex = call.args.indexOf("exec");
      const containerIndex = call.args.indexOf("test-container");
      const envArgs = call.args.slice(execIndex + 1, containerIndex);
      const envVals = envArgs.filter((a) => a !== "--env" && a !== "-i");
      expect(envVals).toEqual(
        expect.arrayContaining(["ONE=1", "TWO=2", "THREE=3"]),
      );
      expect(envVals).toHaveLength(3);
    });

    it("env vars appear in correct position before container and command", async () => {
      const ops = createPodmanBashOps("test-container", undefined, {
        KEY: "val",
      });
      mock.respondWhen(() => true, { stdout: "ok\n" });

      await ops.exec("echo ok", "/path", { onData: dummyOnData });

      const call = mock.call(0);
      expect(call.args).toEqual([
        "exec",
        "-i",
        "--env",
        "KEY=val",
        "test-container",
        "bash",
        "-lc",
        expect.stringContaining("echo ok"),
      ]);
    });
  });
