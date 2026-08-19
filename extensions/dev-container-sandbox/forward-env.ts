/**
 * Environment variable forwarding configuration for Dev Container Sandbox.
 *
 * Reads the list of env var names to forward from two sources:
 *   1. Pi settings files (global: ~/.pi/agent/settings.json, project: .pi/settings.json)
 *      under the key "dev-container-sandbox.forwardEnv" (an array of env var names).
 *   2. The SANDBOX_FORWARD_ENV environment variable (comma-separated names).
 *
 * Then resolves the CURRENT values from process.env and returns them as a
 * Record<string, string> for forwarding via podman exec --env.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Read env var names from pi settings files under the key
 * "dev-container-sandbox.forwardEnv" and from SANDBOX_FORWARD_ENV env var,
 * then resolve their current values from process.env.
 *
 * @param projectCwd - The project directory (for finding .pi/settings.json)
 * @returns Record of env var names to their current values (only vars that are set)
 */
export function getForwardedEnv(projectCwd: string): Record<string, string> {
  const names = new Set<string>();

  // Source 1: SANDBOX_FORWARD_ENV env var (comma-separated names)
  const envVar = process.env.SANDBOX_FORWARD_ENV;
  if (envVar != null && envVar !== "") {
    for (const name of envVar.split(",")) {
      const trimmed = name.trim();
      if (trimmed !== "") names.add(trimmed);
    }
  }

  // Source 2: Global pi settings (~/.pi/agent/settings.json or PI_CODING_AGENT_DIR)
  const piAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = piAgentDir != null && piAgentDir !== "" ? piAgentDir : path.join(homedir(), ".pi", "agent");
  readForwardEnvFromSettings(path.join(agentDir, "settings.json"), names);

  // Source 3: Project pi settings ({projectCwd}/.pi/settings.json)
  readForwardEnvFromSettings(path.join(projectCwd, ".pi", "settings.json"), names);

  // Resolve values from process.env
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}

/**
 * Helper: read a settings.json file and add any "dev-container-sandbox.forwardEnv"
 * names to the given Set.
 */
function readForwardEnvFromSettings(settingsPath: string, names: Set<string>): void {
  try {
    if (!existsSync(settingsPath)) return;
    const content = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content) as Record<string, unknown>;
    const sandboxConfig = settings["dev-container-sandbox"] as Record<string, unknown> | undefined;
    if (sandboxConfig?.forwardEnv != null && Array.isArray(sandboxConfig.forwardEnv)) {
      for (const name of sandboxConfig.forwardEnv) {
        if (typeof name === "string") {
          const trimmed = name.trim();
          if (trimmed !== "") names.add(trimmed);
        }
      }
    }
  } catch {
    // Silently ignore: malformed JSON, missing file, etc.
  }
}
