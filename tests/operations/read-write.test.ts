/**
 * Tests for createPodmanReadOps, createPodmanWriteOps, createPodmanEditOps.
 *
 * Uses vi.hoisted + vi.mock to intercept node:child_process spawn calls.
 * The mock state is created inside vi.hoisted because vi.mock factories run
 * at hoist time, before module imports are resolved.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mock for node:child_process ─────────────────────────────────────

const mock = vi.hoisted(() => {
  type SpawnCall = {
    command: string;
    args: string[];
    stdout: string;
    stderr: string;
    exitCode: number;
  };

  const calls: SpawnCall[] = [];
  let responders: Array<{
    matcher: (call: SpawnCall) => boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> = [];

  const spawnFn = vi.fn(
    (command: string, args: readonly string[], _options: Record<string, unknown>) => {
      const call: SpawnCall = {
        command,
        args: [...args],
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
      calls.push(call);

      let stdout = "", stderr = "", exitCode = 0;
      for (const r of responders) {
        if (r.matcher(call)) { stdout = r.stdout; stderr = r.stderr; exitCode = r.exitCode; break; }
      }
      call.stdout = stdout;
      call.stderr = stderr;
      call.exitCode = exitCode;

       
      const EventEmitter = require("node:events").EventEmitter;
      const child = new EventEmitter();
      child.pid = 12345;
      child.killed = false;
      child.kill = () => { child.killed = true; };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

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
    respondWhen: (
      matcher: (call: SpawnCall) => boolean,
      resp: { stdout?: string; stderr?: string; exitCode?: number },
    ) => {
      responders.push({
        matcher,
        stdout: resp.stdout ?? "",
        stderr: resp.stderr ?? "",
        exitCode: resp.exitCode ?? 0,
      });
    },
    call: (n: number) => {
      if (n >= calls.length) throw new Error(`Call #${n} not found (${calls.length} total)`);
      return calls[n];
    },
    callCount: () => calls.length,
    reset: () => { calls.length = 0; responders = []; spawnFn.mockClear(); },
    allCalls: () => [...calls],
  };
});

vi.mock("node:child_process", () => ({ spawn: mock.spawnFn }));

// ── Now safe to import the module under test ────────────────────────────────

import {
  createPodmanReadOps,
  createPodmanWriteOps,
  createPodmanEditOps,
} from "../../extensions/dev-container-sandbox/operations.ts";
import type { PathMapper } from "../../extensions/dev-container-sandbox/operations.ts";

// Simple path mapper that strips "C:" for testing
const testMapper: PathMapper = {
  toContainer: (hostPath: string) => {
    if (!hostPath) return "/";
    return hostPath.replace(/^C:/, "").replace(/\\/g, "/");
  },
  containerCwd: "/workspace/project",
};

const noopMapper: PathMapper = {
  toContainer: (p: string) => p,
  containerCwd: "C:/Users/Test/project",
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createPodmanReadOps", () => {
  beforeEach(() => mock.reset());

  it("readFile calls podman exec cat with translated path", async () => {
    const ops = createPodmanReadOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("cat"), { stdout: "file contents" });
    const result = await ops.readFile("C:/Users/Test/project/src/main.ts");

    expect(result.toString()).toBe("file contents");
    expect(mock.call(0).command).toBe("podman");
    expect(mock.call(0).args).toContain("exec");
    expect(mock.call(0).args).toContain("test-container");
    expect(mock.call(0).args).toContain("cat");
    expect(mock.call(0).args).toContain("/Users/Test/project/src/main.ts");
  });

  it("readFile passes path as-is without pathMapper", async () => {
    const ops = createPodmanReadOps("test-container");
    mock.respondWhen((c) => c.args.includes("cat"), { stdout: "content" });
    await ops.readFile("C:/raw/path/file.txt");
    expect(mock.call(0).args).toContain("C:/raw/path/file.txt");
  });

  it("access calls podman exec test -r with translated path", async () => {
    const ops = createPodmanReadOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("test") && c.args.includes("-r"), { stdout: "" });
    await ops.access("C:/Users/Test/project/file.ts");
    expect(mock.call(0).args).toContain("test");
    expect(mock.call(0).args).toContain("-r");
    expect(mock.call(0).args).toContain("/Users/Test/project/file.ts");
  });

  it("access throws on non-zero exit", async () => {
    const ops = createPodmanReadOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("test") && c.args.includes("-r"), { stdout: "", exitCode: 1 });
    await expect(ops.access("C:/Users/Test/project/missing.ts")).rejects.toThrow();
  });

  it("detectImageMimeType uses file command for unknown extensions", async () => {
    const ops = createPodmanReadOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("file"), { stdout: "image/png\n" });
    expect(await ops.detectImageMimeType("C:/Users/Test/project/image.unknown")).toBe("image/png");
    expect(mock.call(0).args).toContain("file");
    expect(mock.call(0).args).toContain("--mime-type");
  });

  it("detectImageMimeType returns null on podman error", async () => {
    const ops = createPodmanReadOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("file"), { stdout: "", exitCode: 1 });
    expect(await ops.detectImageMimeType("C:/Users/Test/project/image.unknown")).toBeNull();
  });

  it("detectImageMimeType returns null for non-image mime", async () => {
    const ops = createPodmanReadOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("file"), { stdout: "text/plain\n" });
    expect(await ops.detectImageMimeType("C:/Users/Test/project/file.unknown")).toBeNull();
  });

  describe("detectImageMimeType extension shortcuts", () => {
    it("returns image/png for .png without calling podman", async () => {
      const ops = createPodmanReadOps("test-container", testMapper);
      expect(await ops.detectImageMimeType("test.png")).toBe("image/png");
      expect(mock.callCount()).toBe(0);
    });
    it("returns image/jpeg for .jpg", async () => {
      const ops = createPodmanReadOps("test-container", testMapper);
      expect(await ops.detectImageMimeType("test.jpg")).toBe("image/jpeg");
    });
    it("returns image/jpeg for .jpeg", async () => {
      const ops = createPodmanReadOps("test-container", testMapper);
      expect(await ops.detectImageMimeType("test.jpeg")).toBe("image/jpeg");
    });
    it("returns image/gif for .gif", async () => {
      const ops = createPodmanReadOps("test-container", testMapper);
      expect(await ops.detectImageMimeType("test.gif")).toBe("image/gif");
    });
    it("returns image/webp for .webp", async () => {
      const ops = createPodmanReadOps("test-container", testMapper);
      expect(await ops.detectImageMimeType("test.webp")).toBe("image/webp");
    });
  });
});

describe("createPodmanWriteOps", () => {
  beforeEach(() => mock.reset());

  it("writeFile base64-encodes content and pipes through base64 -d", async () => {
    const ops = createPodmanWriteOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.some((a) => a.includes("base64")), { stdout: "" });
    await ops.writeFile("C:/Users/Test/project/output.txt", "hello world");

    expect(mock.call(0).command).toBe("podman");
    expect(mock.call(0).args).toContain("exec");
    const shArg = mock.call(0).args.find((a) => a.includes("base64"));
    expect(shArg).toBeDefined();
    expect(shArg).toContain("/Users/Test/project/output.txt");
    const encoded = Buffer.from("hello world", "utf-8").toString("base64");
    expect(shArg).toContain(encoded);
  });

  it("writeFile passes path as-is without pathMapper", async () => {
    const ops = createPodmanWriteOps("test-container");
    mock.respondWhen((c) => c.args.some((a) => a.includes("base64")), { stdout: "" });
    await ops.writeFile("C:/raw/path/output.txt", "data");
    const shArg = mock.call(0).args.find((a) => a.includes("base64"));
    expect(shArg).toContain("C:/raw/path/output.txt");
  });

  it("writeFile handles Buffer content", async () => {
    const ops = createPodmanWriteOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.some((a) => a.includes("base64")), { stdout: "" });
    const buf = Buffer.from("binary data", "utf-8");
    await ops.writeFile("C:/Users/Test/project/output.bin", buf);
    const shArg = mock.call(0).args.find((a) => a.includes("base64"));
    expect(shArg).toContain(Buffer.from("binary data", "utf-8").toString("base64"));
  });

  it("mkdir calls podman exec mkdir -p with translated path", async () => {
    const ops = createPodmanWriteOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("mkdir"), { stdout: "" });
    await ops.mkdir("C:/Users/Test/project/newdir");
    expect(mock.call(0).args).toContain("mkdir");
    expect(mock.call(0).args).toContain("-p");
    expect(mock.call(0).args).toContain("/Users/Test/project/newdir");
  });

  it("mkdir passes path as-is without pathMapper", async () => {
    const ops = createPodmanWriteOps("test-container");
    mock.respondWhen((c) => c.args.includes("mkdir"), { stdout: "" });
    await ops.mkdir("C:/raw/path/newdir");
    expect(mock.call(0).args.join(" ")).toContain("C:/raw/path/newdir");
  });
});

describe("createPodmanEditOps", () => {
  beforeEach(() => mock.reset());

  it("editOps.readFile delegates to readOps with path translation", async () => {
    const ops = createPodmanEditOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("cat"), { stdout: "read via edit" });
    const result = await ops.readFile("C:/Users/Test/project/file.ts");

    expect(result.toString()).toBe("read via edit");
    expect(mock.call(0).args).toContain("cat");
    expect(mock.call(0).args).toContain("/Users/Test/project/file.ts");
  });

  it("editOps.writeFile delegates to writeOps", async () => {
    const ops = createPodmanEditOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.some((a) => a.includes("base64")), { stdout: "" });
    await ops.writeFile("C:/Users/Test/project/file.ts", "edit content");
    const shArg = mock.call(0).args.find((a) => a.includes("base64"));
    expect(shArg).toContain("/Users/Test/project/file.ts");
  });

  it("editOps.access delegates to readOps.access", async () => {
    const ops = createPodmanEditOps("test-container", testMapper);
    mock.respondWhen((c) => c.args.includes("test") && c.args.includes("-r"), { stdout: "" });
    await ops.access("C:/Users/Test/project/file.ts");
    expect(mock.call(0).args).toContain("test");
    expect(mock.call(0).args).toContain("-r");
  });

  it("editOps forwards pathMapper to child ops", async () => {
    const ops = createPodmanEditOps("test-container", noopMapper);
    mock.respondWhen((c) => c.args.includes("cat"), { stdout: "content" });
    await ops.readFile("C:/passthrough/path/file.txt");
    expect(mock.call(0).args).toContain("C:/passthrough/path/file.txt");
  });
});
