/**
 * Tests for getForwardedEnv.
 *
 * Reads env var names from pi settings (global + project) and SANDBOX_FORWARD_ENV,
 * then resolves their current values from process.env.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock node:fs ─────────────────────────────────────────────────────────────

const mockFs = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockFs.mockExistsSync,
  readFileSync: mockFs.mockReadFileSync,
}));

// ── Mock node:os ─────────────────────────────────────────────────────────────

const mockOs = vi.hoisted(() => ({
  mockHomedir: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: mockOs.mockHomedir,
}));

// ── Import under test ────────────────────────────────────────────────────────

import { getForwardedEnv } from "../extensions/dev-container-sandbox/forward-env.ts";

const ORIG_ENV = { ...process.env };

describe("getForwardedEnv", () => {
  beforeEach(() => {
    mockFs.mockExistsSync.mockReset();
    mockFs.mockReadFileSync.mockReset();
    mockOs.mockHomedir.mockReset();
    mockOs.mockHomedir.mockReturnValue("/home/user");

    // Restore process.env
    // Restore process.env by clearing to ORIG_ENV baseline
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIG_ENV)) {
        Reflect.deleteProperty(process.env, key);
      }
    }
    for (const [key, val] of Object.entries(ORIG_ENV)) {
      process.env[key] = val;
    }
  });

  it("returns empty object when no config exists", () => {
    mockFs.mockExistsSync.mockReturnValue(false);
    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({});
  });

  it("reads env var names from global pi settings", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockImplementation(
      (p: string) => p === "/home/user/.pi/agent/settings.json",
    );
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      expect(p).toBe("/home/user/.pi/agent/settings.json");
      return JSON.stringify({
        "dev-container-sandbox": { forwardEnv: ["MY_API_KEY", "MY_TOKEN"] },
      });
    });

    process.env.MY_API_KEY = "sk-abc123";
    process.env.MY_TOKEN = "tok-xyz";

    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({ MY_API_KEY: "sk-abc123", MY_TOKEN: "tok-xyz" });
  });

  it("reads env var names from project pi settings", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockImplementation(
      (p: string) => p === "/workspaces/project/.pi/settings.json",
    );
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      expect(p).toBe("/workspaces/project/.pi/settings.json");
      return JSON.stringify({
        "dev-container-sandbox": { forwardEnv: ["PROJECT_SECRET"] },
      });
    });

    process.env.PROJECT_SECRET = "proj-val";
    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({ PROJECT_SECRET: "proj-val" });
  });

  it("merges global and project settings", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockImplementation(
      (p: string) =>
        p === "/home/user/.pi/agent/settings.json" ||
        p === "/workspaces/project/.pi/settings.json",
    );
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      if (p === "/home/user/.pi/agent/settings.json") {
        return JSON.stringify({
          "dev-container-sandbox": { forwardEnv: ["GLOBAL_KEY"] },
        });
      }
      if (p === "/workspaces/project/.pi/settings.json") {
        return JSON.stringify({
          "dev-container-sandbox": { forwardEnv: ["PROJECT_KEY"] },
        });
      }
      throw new Error("Unexpected file read");
    });

    process.env.GLOBAL_KEY = "global-val";
    process.env.PROJECT_KEY = "project-val";

    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({ GLOBAL_KEY: "global-val", PROJECT_KEY: "project-val" });
  });

  it("reads env var names from SANDBOX_FORWARD_ENV environment variable", () => {
    mockFs.mockExistsSync.mockReturnValue(false);
    process.env.SANDBOX_FORWARD_ENV = "VAR_ONE, VAR_TWO";
    process.env.VAR_ONE = "val1";
    process.env.VAR_TWO = "val2";

    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({ VAR_ONE: "val1", VAR_TWO: "val2" });
  });

  it("uses PI_CODING_AGENT_DIR for global settings path", () => {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent";
    mockFs.mockExistsSync.mockImplementation(
      (p: string) => p === "/custom/agent/settings.json",
    );
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      expect(p).toBe("/custom/agent/settings.json");
      return JSON.stringify({
        "dev-container-sandbox": { forwardEnv: ["CUSTOM_KEY"] },
      });
    });

    process.env.CUSTOM_KEY = "custom-val";
    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({ CUSTOM_KEY: "custom-val" });
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it("skips env vars not present in process.env", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockReturnValue(true);
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes("settings.json")) {
        return JSON.stringify({
          "dev-container-sandbox": { forwardEnv: ["EXISTING_KEY", "MISSING_KEY"] },
        });
      }
      throw new Error("Unexpected file read");
    });

    process.env.EXISTING_KEY = "exists";
    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({ EXISTING_KEY: "exists" });
  });

  it("handles malformed JSON gracefully", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockReturnValue(true);
    mockFs.mockReadFileSync.mockReturnValue("not valid json");

    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({});
  });

  it("handles missing dev-container-sandbox key", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockReturnValue(true);
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes("settings.json")) return JSON.stringify({ theme: "dark" });
      throw new Error("Unexpected file read");
    });

    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({});
  });

  it("combines SANDBOX_FORWARD_ENV and pi settings", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockReturnValue(true);
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes("settings.json")) {
        return JSON.stringify({
          "dev-container-sandbox": { forwardEnv: ["FROM_SETTINGS"] },
        });
      }
      throw new Error("Unexpected file read");
    });

    process.env.SANDBOX_FORWARD_ENV = "FROM_ENV";
    process.env.FROM_SETTINGS = "settings-val";
    process.env.FROM_ENV = "env-val";

    const result = getForwardedEnv("/workspaces/project");
    expect(result).toEqual({ FROM_SETTINGS: "settings-val", FROM_ENV: "env-val" });
  });

  it("deduplicates when same name appears in multiple sources", () => {
    mockOs.mockHomedir.mockReturnValue("/home/user");
    mockFs.mockExistsSync.mockReturnValue(true);
    mockFs.mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes("settings.json")) {
        return JSON.stringify({
          "dev-container-sandbox": { forwardEnv: ["DUP_KEY"] },
        });
      }
      throw new Error("Unexpected file read");
    });

    process.env.SANDBOX_FORWARD_ENV = "DUP_KEY";
    process.env.DUP_KEY = "dup-val";

    const result = getForwardedEnv("/workspaces/project");
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.DUP_KEY).toBe("dup-val");
  });
});
