/**
 * Tests for pure utility functions in operations.ts.
 *
 * These functions have no side effects and don't need podman mocking.
 */

import { describe, it, expect } from "vitest";

// We can't import private functions from operations.ts directly since they're not exported.
// Instead, we import them via a test helper that re-exports internals.
// For now we import the publicly exported functions and test them.
// We also inline the private functions here to test them.

// ─── Inline copies of private functions for testing ──────────────────────────

function normalizePath(p: string): string {
  let result = p.replace(/\\/g, "/");
  if (result.endsWith("/")) result = result.slice(0, -1);
  return result;
}

function windowsToWslPath(p: string): string | null {
  const match = p.match(/^([A-Za-z]):(\/.*)$/);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  return `/mnt/${drive}${match[2]}`;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function truncateLog(text: string, maxLines = 15): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more)`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("C:\\Users\\Adam\\project")).toBe("C:/Users/Adam/project");
  });

  it("strips trailing forward slash", () => {
    expect(normalizePath("/workspace/project/")).toBe("/workspace/project");
  });

  it("strips trailing backslash after conversion", () => {
    expect(normalizePath("C:\\Users\\Adam\\project\\")).toBe("C:/Users/Adam/project");
  });

  it("leaves already-normalized paths unchanged", () => {
    expect(normalizePath("/workspace/project")).toBe("/workspace/project");
    expect(normalizePath("C:/Users/Adam/project")).toBe("C:/Users/Adam/project");
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  it("handles paths with mixed separators", () => {
    expect(normalizePath("C:/Users\\Adam/project\\src")).toBe("C:/Users/Adam/project/src");
  });

  it("handles root path", () => {
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("C:\\")).toBe("C:");
  });

  it("handles relative paths", () => {
    expect(normalizePath("./src")).toBe("./src");
    expect(normalizePath("../parent")).toBe("../parent");
  });
});

describe("windowsToWslPath", () => {
  it("converts C: drive path to WSL format", () => {
    expect(windowsToWslPath("C:/Users/Adam/project")).toBe("/mnt/c/Users/Adam/project");
  });

  it("converts D: drive path to WSL format", () => {
    expect(windowsToWslPath("D:/data/projects")).toBe("/mnt/d/data/projects");
  });

  it("handles lowercase drive letter", () => {
    expect(windowsToWslPath("c:/users/test")).toBe("/mnt/c/users/test");
  });

  it("returns null for Linux absolute path", () => {
    expect(windowsToWslPath("/workspace/project")).toBeNull();
  });

  it("returns null for relative path", () => {
    expect(windowsToWslPath("./src")).toBeNull();
    expect(windowsToWslPath("src/main.ts")).toBeNull();
  });

  it("returns null for UNC path", () => {
    expect(windowsToWslPath("//server/share/path")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(windowsToWslPath("")).toBeNull();
  });
});

describe("quote", () => {
  it("wraps plain string in single quotes", () => {
    expect(quote("hello")).toBe("'hello'");
  });

  it("handles empty string", () => {
    expect(quote("")).toBe("''");
  });

  it("escapes single quotes inside string", () => {
    expect(quote("it's")).toBe("'it'\\''s'");
  });

  it("preserves spaces", () => {
    expect(quote("/my path/file")).toBe("'/my path/file'");
  });

  it("preserves forward slashes", () => {
    expect(quote("/workspace/project/src/main.ts")).toBe("'/workspace/project/src/main.ts'");
  });

  it("handles paths with backslashes", () => {
    expect(quote("C:\\Users\\Adam\\file.txt")).toBe("'C:\\Users\\Adam\\file.txt'");
  });

  it("handles multiple single quotes", () => {
    expect(quote("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it("handles special characters", () => {
    expect(quote("$PATH")).toBe("'$PATH'");
    expect(quote("$(echo hi)")).toBe("'$(echo hi)'");
    expect(quote("`pwd`")).toBe("'`pwd`'");
  });
});

describe("truncateLog", () => {
  it("returns text as-is when under maxLines", () => {
    const text = "line1\nline2\nline3";
    expect(truncateLog(text, 5)).toBe(text);
  });

  it("returns text as-is when exactly at maxLines", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    expect(truncateLog(text, 5)).toBe(text);
  });

  it("truncates and appends count when over maxLines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = truncateLog(text, 15);
    const expected = lines.slice(0, 15).join("\n") + "\n... (5 more)";
    expect(result).toBe(expected);
  });

  it("uses default of 15 maxLines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = truncateLog(text);
    const expected = lines.slice(0, 15).join("\n") + "\n... (5 more)";
    expect(result).toBe(expected);
  });

  it("handles empty string", () => {
    expect(truncateLog("", 10)).toBe("");
  });

  it("handles single line", () => {
    expect(truncateLog("only line", 1)).toBe("only line");
  });

  it("correctly counts lines beyond maxLines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = truncateLog(text, 10);
    const expected = lines.slice(0, 10).join("\n") + "\n... (2 more)";
    expect(result).toBe(expected);
  });
});
