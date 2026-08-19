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
    // toContainer() checks ALL mounts, not just the bestMount (deepest match to
    // hostCwd). A sibling directory outside the project mount is translated via
    // the broader parent mount (C:/Users/Adam → /home/user).
    const mapper = createPathMapper("C:/Users/Adam/java-project", [
      mount("C:/Users/Adam", "/home/user"),
      mount("C:/Users/Adam/java-project", "/workspace/java"),
    ]);
    expect(mapper.toContainer("C:/Users/Adam/java-project/pom.xml")).toBe(
      "/workspace/java/pom.xml",
    );
    // Sibling directory now translates via the broader parent mount (not buggy fallthrough)
    expect(mapper.toContainer("C:/Users/Adam/other-project/index.js")).toBe(
      "/home/user/other-project/index.js",
    );
  });

  it("handles mount source with no trailing separator matching exactly", () => {
    const mapper = createPathMapper("C:/data", [
      mount("C:/data", "/data"),
    ]);
    expect(mapper.toContainer("C:/data/file.csv")).toBe("/data/file.csv");
  });
});

// ─── Linux Host Tests ──────────────────────────────────────────────────────
//
// BUG: On Linux hosts, toContainer() only checks the single "best mount" (the
// mount whose source best matches hostCwd). Paths belonging to a DIFFERENT
// mount — like ~/.pi mounted at a different source path — fall through
// untranslated. On Windows this was less visible because host paths use
// "C:\..." format while container paths use "/workspace/..." format, making
// the two domains naturally distinguishable. On Linux, both host and container
// paths look like "/home/...", so any path outside the project mount silently
// passes through and the container can't find it.

describe("createPathMapper — Linux host (user mismatch bug)", () => {
  it("BUG: pi home path under separate mount falls through untranslated on Linux", () => {
    // Scenario: Linux host where ~/.pi is mounted at a different path
    // inside the container (because container user != host user).
    //
    // Host user: "hostuser"  (home: /home/hostuser)
    // Container user: "contuser" (home: /home/contuser)
    // Mount: /home/hostuser/.pi  →  /home/contuser/.pi  (cross-user mount)
    // Mount: /home/hostuser/project →  /workspaces/project (project mount)
    //
    // When pi resolves ~/.pi/agent/skill/foo/SKILL.md on the HOST, it becomes:
    //   /home/hostuser/.pi/agent/skill/foo/SKILL.md
    //
    // toContainer() should translate this to the container-side path:
    //   /home/contuser/.pi/agent/skill/foo/SKILL.md
    //
    // BUG: toContainer() only checks bestMount (project mount), so the path
    // falls through unchanged and the container can't find it.

    const mapper = createPathMapper("/home/hostuser/project", [
      mount("/home/hostuser/project", "/workspaces/project"),
      mount("/home/hostuser/.pi", "/home/contuser/.pi"),
    ]);

    // The path inside the project dir still translates correctly
    expect(mapper.toContainer("/home/hostuser/project/src/main.ts")).toBe(
      "/workspaces/project/src/main.ts",
    );

    // BUG: ~/.pi path should be translated via the .pi mount, but falls through
    expect(mapper.toContainer("/home/hostuser/.pi/agent/skill/foo/SKILL.md")).toBe(
      // CURRENT (buggy) result: "/home/hostuser/.pi/agent/skill/foo/SKILL.md"
      // EXPECTED (correct) result: "/home/contuser/.pi/agent/skill/foo/SKILL.md"
      "/home/contuser/.pi/agent/skill/foo/SKILL.md",
    );
  });

  it("BUG: host home directory path under separate mount falls through untranslated", () => {
    // Same setup but the entire home directory is bridged, with .pi as
    // a subdirectory. The .pi-specific mount might not exist — instead
    // /home/hostuser is mounted to /home/contuser.
    const mapper = createPathMapper("/home/hostuser/project", [
      mount("/home/hostuser/project", "/workspaces/project"),
      mount("/home/hostuser", "/home/contuser"),
    ]);

    // ~/.pi path should translate via the home directory mount
    expect(mapper.toContainer("/home/hostuser/.pi/agent/settings.json")).toBe(
      "/home/contuser/.pi/agent/settings.json",
    );
  });

  it("BUG: paths under other mounts are not translated when multiple mounts exist", () => {
    // Even on Windows, if .pi is mounted via a different bind mount that
    // is NOT the best mount, paths under it are not translated.
    const mapper = createPathMapper("C:/Users/Adam/project", [
      mount("C:/Users/Adam/project", "/workspaces/project"),
      mount("C:/Users/Adam/.pi", "/home/contuser/.pi"),
    ]);

    expect(mapper.toContainer("C:/Users/Adam/.pi/agent/skill/foo/SKILL.md")).toBe(
      "/home/contuser/.pi/agent/skill/foo/SKILL.md",
    );
  });

  it("containerCwd still uses project mount when .pi mount also exists", () => {
    // containerCwd should remain based on the project mount, not the .pi mount.
    // The issue is only in toContainer() not checking other mounts.
    const mapper = createPathMapper("/home/hostuser/project", [
      mount("/home/hostuser/project", "/workspaces/project"),
      mount("/home/hostuser/.pi", "/home/contuser/.pi"),
    ]);

    expect(mapper.containerCwd).toBe("/workspaces/project");
  });

  it("(a) picks deepest matching non-best mount when multiple overlap", () => {
    // Multiple non-best mounts could match a path. The deepest source prefix wins,
    // same as the existing logic for the best mount.
    const mapper = createPathMapper("/home/hostuser/project", [
      mount("/home/hostuser/project", "/workspaces/project"),
      mount("/home/hostuser", "/home/contuser"),
      mount("/home/hostuser/.pi", "/home/contuser/.pi"),
    ]);

    // Both mounts match, but .pi is deeper → should win
    expect(mapper.toContainer("/home/hostuser/.pi/agent/skill/foo/SKILL.md")).toBe(
      "/home/contuser/.pi/agent/skill/foo/SKILL.md",
    );

    // Home mount handles paths above .pi
    expect(mapper.toContainer("/home/hostuser/other/some-file")).toBe(
      "/home/contuser/other/some-file",
    );
  });

  it("(b) identity mount where source == destination", () => {
    // When source == destination (same-path bind mount), translation is a no-op.
    // This is the recommended mount pattern for ~/.pi in devcontainer.json.
    const mapper = createPathMapper("/home/hostuser/project", [
      mount("/home/hostuser/project", "/workspaces/project"),
      mount("/home/hostuser/.pi", "/home/hostuser/.pi"),
    ]);

    // .pi mount is identity (source == dest), path should pass through unchanged
    expect(mapper.toContainer("/home/hostuser/.pi/agent/skill/foo/SKILL.md")).toBe(
      "/home/hostuser/.pi/agent/skill/foo/SKILL.md",
    );
  });

  it("(c) path matching zero mounts still falls through unchanged", () => {
    // A host path outside ALL mounts (e.g. /tmp or /var) should fall through
    // unchanged, just like the current behavior.
    const mapper = createPathMapper("/home/hostuser/project", [
      mount("/home/hostuser/project", "/workspaces/project"),
      mount("/home/hostuser/.pi", "/home/contuser/.pi"),
    ]);

    expect(mapper.toContainer("/tmp/some-file.txt")).toBe(
      "/tmp/some-file.txt",
    );
    expect(mapper.toContainer("/var/log/syslog")).toBe(
      "/var/log/syslog",
    );
  });
});

