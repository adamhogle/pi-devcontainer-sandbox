/**
 * Mock podman spawn for testing operation factories.
 *
 * This module exports factory functions intended for use inside vi.hoisted().
 * The recommended pattern for each test file is:
 *
 * ```typescript
 * import { vi } from "vitest";
 *
 * // 1. Create mock state inside vi.hoisted() (runs before any imports)
 * const mock = vi.hoisted(() => createMockPodmanState());
 *
 * // 2. Hoisted vi.mock replaces spawn with the mock
 * vi.mock("node:child_process", () => ({ spawn: mock.spawnFn }));
 *
 * // 3. Now safe to import the module under test
 * import { createPodmanReadOps } from "...";
 * ```
 *
 * The `mock` object provides `respondWhen`, `call`, `callCount`, `reset` for use in tests.
 */

import { vi } from "vitest";
import { EventEmitter } from "node:events";

export interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MockPodmanState {
  /** The mock function to pass as `vi.mock("node:child_process", () => ({ spawn: this.spawnFn }))` */
  spawnFn: ReturnType<typeof vi.fn>;
  /** Configure response for matching spawn calls */
  respondWhen: (
    matcher: (call: SpawnCall) => boolean,
    response: { stdout?: string; stderr?: string; exitCode?: number },
  ) => void;
  /** Get the Nth call (0-indexed) */
  call: (n: number) => SpawnCall;
  /** Number of calls made so far */
  callCount: () => number;
  /** All calls made */
  calls: () => SpawnCall[];
  /** Reset responders and clear call log (call in beforeEach) */
  reset: () => void;
}

/**
 * Create mock podman state inside vi.hoisted(). Example:
 *
 *   const mock = vi.hoisted(() => createMockPodmanState());
 *   vi.mock("node:child_process", () => ({ spawn: mock.spawnFn }));
 */
export function createMockPodmanState(): MockPodmanState {
  const calls: SpawnCall[] = [];
  let responders: Array<{
    matcher: (call: SpawnCall) => boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> = [];

  const spawnFn = vi.fn(
    (command: string, args: readonly string[], options: Record<string, unknown>) => {
      const call: SpawnCall = {
        command,
        args: [...args],
        options: { ...options },
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
      calls.push(call);

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      for (const r of responders) {
        if (r.matcher(call)) {
          stdout = r.stdout;
          stderr = r.stderr;
          exitCode = r.exitCode;
          break;
        }
      }
      call.stdout = stdout;
      call.stderr = stderr;
      call.exitCode = exitCode;

      const child = new EventEmitter() as ReturnType<typeof spawn>;
      (child as Record<string, unknown>).pid = 12345;
      (child as Record<string, unknown>).killed = false;
      (child as Record<string, unknown>).kill = ((_signal?: string) => {
        (child as Record<string, unknown>).killed = true;
        child.emit("close", 9);
      });

      const stdoutEmitter = new EventEmitter();
      (stdoutEmitter as Record<string, unknown>).destroy = () => {};
      (stdoutEmitter as Record<string, unknown>).destroyed = false;
      (stdoutEmitter as Record<string, unknown>).readable = true;
      (child as Record<string, unknown>).stdout = stdoutEmitter as typeof child.stdout;

      const stderrEmitter = new EventEmitter();
      (stderrEmitter as Record<string, unknown>).destroy = () => {};
      (stderrEmitter as Record<string, unknown>).destroyed = false;
      (stderrEmitter as Record<string, unknown>).readable = true;
      (child as Record<string, unknown>).stderr = stderrEmitter as typeof child.stderr;

      setTimeout(() => {
        if (stdout) stdoutEmitter.emit("data", Buffer.from(stdout));
        if (stderr) stderrEmitter.emit("data", Buffer.from(stderr));
      }, 0);

      setTimeout(() => {
        child.emit("close", exitCode);
      }, 1);

      return child;
    },
  );

  return {
    spawnFn,
    respondWhen(matcher, response) {
      responders.push({
        matcher,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
        exitCode: response.exitCode ?? 0,
      });
    },
    call(n) {
      if (n >= calls.length) throw new Error(`Mock call #${n} not found (${calls.length} total)`);
      return calls[n];
    },
    callCount: () => calls.length,
    calls: () => [...calls],
    reset: () => {
      calls.length = 0;
      responders = [];
      spawnFn.mockClear();
    },
  };
}

/**
 * Matcher helper: match by the second argument (podman subcommand, e.g. "exec", "inspect", "ps").
 */
export function matchSubcommand(subcommand: string) {
  return (call: SpawnCall) => call.args[0] === subcommand;
}

/**
 * Matcher helper: match by a substring in any argument.
 */
export function matchArgsContain(substring: string) {
  return (call: SpawnCall) => call.args.some((a) => a.includes(substring));
}
