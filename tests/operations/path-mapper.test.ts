/**
 * Tests for createPathMapper — the host→container path translation engine.
 *
 * These tests are pure logic: no podman, no filesystem, no mocking needed.
 */

import { describe, it, expect } from "vitest";
import { createPathMapper } from "../../extensions/dev-container-sandbox/operations.ts";
import type { MountInfo } from "../../extensions/dev-container-sandbox/operations.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function mount(source: string, destination: string): MountInfo {
  return { source, destination };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createPathMapper — mount selection", () => {
  it("matches Windows host path with Windows mount source", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:/Users/Adam/project", "/workspace/project"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/project/src/main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });

  it("matches Windows host path with WSL mount source", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("/mnt/c/Users/Adam/project", "/workspace/project"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/project/src/main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });

  it("matches WSL host path with WSL mount source", () => {
    const mapper = createPathMapper("/mnt/c/Users/Adam/project", [
      mount("/mnt/c/Users/Adam/project", "/workspace/project"),
    ]);
    expect(mapper.toContainer("/mnt/c/Users/Adam/project/src/main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });

  it("selects deepest matching mount when multiple mounts exist", () => {
    const mapper = createPathMapper("C:/Users/Adam/project/subdir", [
      mount("C:/Users/Adam", "/home/user"),
      mount("C:/Users/Adam/project", "/workspace/project"),
    ]);
    // The deeper mount (project) should win
    expect(mapper.toContainer("C:/Users/Adam/project/subdir/file.ts")).toBe(
      "/workspace/project/subdir/file.ts",
    );
  });

  it("selects deepest prefix even when cwd matches both", () => {
    const mapper = createPathMapper("C:/Users/Adam/project/app", [
      mount("C:/Users/Adam/project", "/workspace/project"),
      mount("C:/Users/Adam/project/app", "/workspace/app"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/project/app/routes.ts")).toBe(
      "/workspace/app/routes.ts",
    );
  });

  it("returns hostCwd as containerCwd when no mount matches", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:/Other/path", "/other"),
    ]);
    // containerCwd falls back to normalized hostCwd
    expect(mapper.containerCwd).toBe("C:/Users/Adam/project");
  });

  it("returns null bestMount when no mount matches project path", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:/Other/path", "/other"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/project/src/main.ts")).toBe(
      "C:/Users/Adam/project/src/main.ts",
    );
  });

  it("handles empty mounts array", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", []);
    expect(mapper.toContainer("C:/Users/Adam/project/src/main.ts")).toBe(
      "C:/Users/Adam/project/src/main.ts",
    );
    expect(mapper.containerCwd).toBe("C:/Users/Adam/project");
  });

  it("normalizes backslashes in mount sources", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:\\Users\\Adam\\project", "/workspace/project"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/project/src/main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });
});

describe("createPathMapper().toContainer", () => {
  const mapper = createPathMapper("C:/Users/Adam/project", [
    mount("C:/Users/Adam/project", "/workspace/project"),
  ]);

  it("translates host path to container path with file", () => {
    expect(mapper.toContainer("C:/Users/Adam/project/src/main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });

  it("translates host path to container path with subdirectory", () => {
    expect(mapper.toContainer("C:/Users/Adam/project/src/utils/helper.ts")).toBe(
      "/workspace/project/src/utils/helper.ts",
    );
  });

  it("translates host path to container path (directory, no trailing slash)", () => {
    expect(mapper.toContainer("C:/Users/Adam/project/src")).toBe(
      "/workspace/project/src",
    );
  });

  it("translates root mount path to container destination", () => {
    expect(mapper.toContainer("C:/Users/Adam/project")).toBe("/workspace/project");
  });

  it("returns WSL input unchanged when mount source is Windows-format", () => {
    // When the mapper was created with Windows-format mount sources, WSL-format
    // input paths don't match and fall through unchanged. In practice, if podman
    // returns Windows-format sources, process.cwd() also returns Windows paths,
    // so this scenario doesn't arise during normal operation.
    expect(mapper.toContainer("/mnt/c/Users/Adam/project/src/main.ts")).toBe(
      "/mnt/c/Users/Adam/project/src/main.ts",
    );
  });

  it("handles backslashes in input path", () => {
    expect(mapper.toContainer("C:\\Users\\Adam\\project\\src\\main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });

  it("handles trailing slash in input", () => {
    expect(mapper.toContainer("C:/Users/Adam/project/src/")).toBe(
      "/workspace/project/src",
    );
  });

  it("returns / for empty input", () => {
    expect(mapper.toContainer("")).toBe("/");
  });

  it("returns path unchanged (normalized) when path is outside mount", () => {
    expect(mapper.toContainer("D:/other/path/file.txt")).toBe("D:/other/path/file.txt");
  });

  it("returns path unchanged for already-container paths (no double-translation)", () => {
    // If a container path like /workspace/project/src is passed to toContainer,
    // it won't match any mount source (since mount source is a host path), so it
    // falls back to returning the normalized input unchanged. This prevents
    // double-translation when operations receive already-translated paths.
    expect(mapper.toContainer("/workspace/project/src/main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });
});

describe("createPathMapper().containerCwd", () => {
  it("returns container path corresponding to hostCwd when mount matches", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:/Users/Adam/project", "/workspace/project"),
    ]);
    expect(mapper.containerCwd).toBe("/workspace/project");
  });

  it("returns container path with subdirectory when cwd is nested", () => {
    const mapper = createPathMapper("C:/Users/Adam/project/src", [
      mount("C:/Users/Adam/project", "/workspace/project"),
    ]);
    expect(mapper.containerCwd).toBe("/workspace/project/src");
  });

  it("falls back to normalized hostCwd when no mount matches", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:/Other/path", "/other"),
    ]);
    expect(mapper.containerCwd).toBe("C:/Users/Adam/project");
  });

  it("matches WSL cwd with WSL mount source for containerCwd", () => {
    const mapper = createPathMapper("/mnt/c/Users/Adam/project", [
      mount("/mnt/c/Users/Adam/project", "/workspace/project"),
    ]);
    expect(mapper.containerCwd).toBe("/workspace/project");
  });
});

describe("createPathMapper — multiple mount edge cases", () => {
  it("handles mounts with trailing slashes in source", () => {
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:/Users/Adam/project/", "/workspace/project/"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/project/src/main.ts")).toBe(
      "/workspace/project/src/main.ts",
    );
  });

  it("prefers exact match over prefix match for best mount", () => {
    // createPathMapper selects the single best mount (longest source prefix matching
    // hostCwd). Once selected, ALL paths are translated through that mount. Paths
    // that don't share the mount's prefix fall through unchanged.
    const mapper = createPathMapper("C:/Users/Adam/java-project", [
      mount("C:/Users/Adam", "/home/user"),
      mount("C:/Users/Adam/java-project", "/workspace/java"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/java-project/pom.xml")).toBe(
      "/workspace/java/pom.xml",
    );
    // A sibling directory doesn't match the selected mount's prefix → falls through
    expect(mapper.toContainer("C:/Users/Adam/other-project/index.js")).toBe(
      "C:/Users/Adam/other-project/index.js",
    );
  });

  it("handles mount source with no trailing separator matching exactly", () => {
    const mapper = createPathMapper("C:/data", [
      mount("C:/data", "/data"),
    ]);
    expect(mapper.toContainer("C:/data/file.csv")).toBe("/data/file.csv");
  });
});
