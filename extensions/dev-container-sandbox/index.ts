/**
 * Dev Container Sandbox Extension
 *
 * Routes pi's built-in tools (read, write, edit, bash, grep, find, ls)
 * into a running Podman dev container.
 *
 * Uses @devcontainers/cli to manage containers. On Windows, creates a
 * temporary docker.exe shim (copy of podman.exe) so the CLI can find
 * its docker dependency.
 *
 * Auto-detection on startup:
 *   1. Check .devcontainer/devcontainer.json exists
 *   2. Fast path: scan running podman containers for one with project mounted
 *   3. If not found, run devcontainer up to build/start
 *
 *
 * NOTE: Users should mount ~/.pi/ into their devcontainer for skills,
 * settings, auth, and prompts to work. See REQUIREMENTS.md.

 * Manual override: --dev-container <name>
 * Rebuild: /dev-container rebuild
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type BashOperations,
} from "@earendil-works/pi-coding-agent";

import {
	createPathMapper,
	createPodmanBashOps,
	createPodmanEditOps,
	createPodmanFindOps,
	createPodmanLsOps,
	createPodmanReadOps,
	createPodmanWriteOps,
	executePodmanGrep,
	getContainerMounts,
	getContainerRemoteUser,
} from "./operations";

import type { PathMapper } from "./operations";
import { getForwardedEnv } from "./forward-env";

// ─── Docker shim for podman on Windows ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface DockerShim {
	dir: string;
	cleanup: () => void;
}



// ─── Devcontainer CLI helper ─────────────────────────────────────────────────

interface DevContainerUpResult {
	outcome: "success" | "failure";
	containerId: string;
	remoteUser: string;
	remoteWorkspaceFolder: string;
	error?: string;
}

function runDevContainerUp(
	workspaceFolder: string,
	rebuild: boolean,
	signal?: AbortSignal,
): Promise<DevContainerUpResult> {
	return new Promise((resolve, reject) => {
		const args = [
			"@devcontainers/cli",
			"up",
			"--docker-path",
			"podman",
			"--workspace-folder",
			workspaceFolder,
		];
		if (rebuild) args.push("--remove-existing-container");

		const useShell = process.platform === "win32";
		const child = spawn(useShell ? "npx" : "npx", args, {
			stdio: ["ignore", "pipe", "pipe"],
			signal,
			cwd: workspaceFolder,
			shell: useShell,
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
		child.stderr.on("data", (data: Buffer) => stderrChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (signal?.aborted === true) { reject(new Error("aborted")); return; }
			const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
			const stderr = Buffer.concat(stderrChunks).toString("utf-8");
			const jsonLines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
			if (jsonLines.length === 0) {
				reject(new Error(`devcontainer up failed (exit ${code}): no JSON.\n${truncateLog(stderr)}`));
				return;
			}
			try {
				const result = JSON.parse(jsonLines[jsonLines.length - 1]) as DevContainerUpResult;
				if (result.outcome === "failure") {
					reject(new Error(`devcontainer up failed: ${result.error ?? result.outcome}\n${truncateLog(stderr)}`));
				} else {
					resolve(result);
				}
			} catch (parseErr) {
				reject(new Error(`Parse error: ${String(parseErr)}\n${truncateLog(stdout)}\n${truncateLog(stderr)}`));
			}
		});
	});
}

function truncateLog(text: string, maxLines = 15): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more)`;
}

// ─── Podman exec helper ──────────────────────────────────────────────────────

function podmanExec(
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn("podman", args, {
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => err.push(d));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(out).toString("utf-8").trim(),
				stderr: Buffer.concat(err).toString("utf-8").trim(),
				code: code ?? -1,
			});
		});
	});
}

// ─── Container detection ─────────────────────────────────────────────────────

interface ContainerInfo {
	containerName: string;
	containerCwd: string;
	pathMapper: PathMapper;
	/** Dev container remote user to run `podman exec` as, when known. */
	remoteUser?: string;
}

/** Fast path: find a running container explicitly labelled for this project folder.
 *
 * Only `devcontainer.local_folder` counts. A container whose mount happens to
 * cover the folder (for example a VS Code container started for a parent
 * directory) is not attached to, so the fast path can never pick the wrong
 * container. The label is compared without relying on podman's case handling,
 * so Windows and WSL forms of the same folder both match. */
async function findDevContainer(
	localCwd: string,
	signal?: AbortSignal,
): Promise<ContainerInfo | null> {
	const ids = new Set<string>();
	for (const variant of folderLabelVariants(localCwd)) {
		try {
			const ps = await podmanExec(
				["ps", "-q", "--noheading", "--filter", `label=devcontainer.local_folder=${variant}`],
				signal,
			);
			for (const line of ps.stdout.split("\n")) {
				const id = line.trim();
				if (id !== "") ids.add(id);
			}
		} catch { continue; }
	}

	for (const id of ids) {
		try {
			const mounts = await getContainerMounts(id);
			const pathMapper = createPathMapper(localCwd, mounts);
			return { containerName: id, containerCwd: pathMapper.containerCwd, pathMapper };
		} catch { continue; }
	}
	return null;
}

function normalizePath(p: string): string {
	let result = p.replace(/\\/g, "/");
	if (result.endsWith("/")) result = result.slice(0, -1);
	return result;
}

function windowsToWslPath(p: string): string | null {
	const match = p.match(/^([A-Za-z]):(\/.*)$/);
	if (!match) return null;
	return `/mnt/${match[1].toLowerCase()}${match[2]}`;
}

function wslToWindowsPath(p: string): string | null {
	const match = p.match(/^\/mnt\/([a-z])\/(.*)$/);
	if (!match) return null;
	return `${match[1].toUpperCase()}:/${match[2]}`;
}

/** Forms of the folder a devcontainer CLI container might label itself with.
 *
 * Covers the native path, its Windows/WSL counterpart and both drive-letter
 * cases, so a container created on either side of the boundary is recognised. */
function folderLabelVariants(localCwd: string): string[] {
	const normalized = normalizePath(localCwd);
	const variants = new Set<string>([normalized]);
	const wsl = windowsToWslPath(normalized);
	if (wsl != null) variants.add(wsl);
	const windows = wslToWindowsPath(normalized);
	if (windows != null) variants.add(windows);
	for (const variant of [...variants]) {
		const drive = variant.match(/^([A-Za-z]):\//);
		if (drive != null) {
			variants.add(drive[1].toLowerCase() + variant.slice(1));
			variants.add(drive[1].toUpperCase() + variant.slice(1));
		}
	}
	return [...variants];
}

// ─── Extension factory (sync) ───────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("dev-container", {
		description: "Use a specific container by name/ID instead of auto-detection",
		type: "string",
	});

	const localCwd = process.cwd();

	// Capture all local tools for fallback
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	// Forwarded env vars to pass into container (from pi settings)
	let forwardedEnv: Record<string, string> = {};

	let resolvedContainer: ContainerInfo | null = null;

	const getContainerOps = (): ContainerInfo | null => {
		if (!resolvedContainer) return null;
		return {
			containerName: resolvedContainer.containerName,
			containerCwd: resolvedContainer.containerCwd,
			pathMapper: resolvedContainer.pathMapper,
			remoteUser: resolvedContainer.remoteUser,
		};
	};

	type ReadyPayload = {
		mode: "container" | "host";
		containerId?: string;
		containerCwd?: string;
		remoteUser?: string;
		reason?: string;
	};

	/** Announce that a mode has been chosen, once detection has finished. Other
	 * extensions can wait for this signal instead of polling container state. */
	const announceReady = (payload: ReadyPayload): void => {
		pi.events.emit("devcontainer:ready", { workspaceFolder: localCwd, ...payload });
	};

	// ── session_start: detect container ───────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const containerFlag = pi.getFlag("dev-container") as string | undefined;

		// Read env var forwarding configuration from pi settings
		forwardedEnv = getForwardedEnv(localCwd);

		try {
			if (containerFlag != null) {
				const mounts = await getContainerMounts(containerFlag);
				const pathMapper = createPathMapper(localCwd, mounts);
				const remoteUser = await getContainerRemoteUser(containerFlag);
				resolvedContainer = { containerName: containerFlag, containerCwd: pathMapper.containerCwd, pathMapper, remoteUser: remoteUser ?? undefined };
				announceReady({ mode: "container", containerId: containerFlag, containerCwd: pathMapper.containerCwd, remoteUser: remoteUser ?? undefined });
				ctx.ui.setStatus("dev-container", ctx.ui.theme.fg("accent", `🐳 ${containerFlag.slice(0, 12)}:${pathMapper.containerCwd}`));
				ctx.ui.notify(`Tools routed into container: ${containerFlag.slice(0, 12)}`, "info");
				return;
			}

			// Check if devcontainer config exists
			if (!existsSync(path.join(localCwd, ".devcontainer", "devcontainer.json"))) {
				announceReady({ mode: "host", reason: "no-devcontainer" });
				ctx.ui.notify("No .devcontainer — using host mode", "info");
				return;
			}

			// Fast path: check already-running containers
			const existing = await findDevContainer(localCwd);
			if (existing) {
				const remoteUser = await getContainerRemoteUser(existing.containerName);
				resolvedContainer = { ...existing, remoteUser: remoteUser ?? undefined };
				announceReady({ mode: "container", containerId: existing.containerName, containerCwd: existing.containerCwd, remoteUser: remoteUser ?? undefined });
				const label = `${existing.containerName.slice(0, 12)}:${existing.containerCwd}`;
				ctx.ui.setStatus("dev-container", ctx.ui.theme.fg("accent", `🐳 ${label}`));
				ctx.ui.notify(`Attached to dev container: ${label}`, "info");
				return;
			}

			// Build path: run devcontainer up to build/start
			ctx.ui.setStatus("dev-container", ctx.ui.theme.fg("accent", "🐳 starting…"));
			ctx.ui.notify("Starting dev container (this may take a while)...", "info");
			const result = await runDevContainerUp(localCwd, false);
			if (!result.containerId) {
				announceReady({ mode: "host", reason: "no-container-id" });
				ctx.ui.notify("devcontainer up succeeded but no container ID returned. Using host mode.", "warning");
				return;
			}
			const mounts = await getContainerMounts(result.containerId);
			const pathMapper = createPathMapper(localCwd, mounts);
			resolvedContainer = { containerName: result.containerId, containerCwd: result.remoteWorkspaceFolder, pathMapper, remoteUser: result.remoteUser || undefined };
			announceReady({ mode: "container", containerId: result.containerId, containerCwd: result.remoteWorkspaceFolder, remoteUser: result.remoteUser || undefined });
			const label = `${result.containerId.slice(0, 12)}:${result.remoteWorkspaceFolder}`;
			ctx.ui.setStatus("dev-container", ctx.ui.theme.fg("accent", `🐳 ${label}`));
			ctx.ui.notify(`Attached to dev container: ${label}`, "info");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			announceReady({ mode: "host", reason: msg });
			ctx.ui.notify(
				containerFlag != null
					? `Container "${containerFlag}" failed: ${msg}. Using host mode.`
					: `Dev container failed: ${msg}. Using host mode.`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", () => {
		resolvedContainer = null;
	});

	// ── Tool overrides ────────────────────────────────────────────────────
	//
	// IMPORTANT: All tool overrides use localCwd (host cwd) when creating the SDK
	// tool wrapper, NOT ops.containerCwd. This ensures resolveToCwd() inside the
	// SDK tools works with native Windows paths, which it handles correctly.
	// The operations themselves receive the pathMapper and translate host paths
	// to container paths internally before executing podman commands.
	//
	// Previously this code passed container paths (e.g. /workspace/stock-trading)
	// through createXTool(ops.containerCwd, ...), but on Windows, Node's
	// path.resolve() treats paths starting with "/" as current-drive-rooted paths,
	// converting /workspace/foo -> C:\workspace\foo. This corroded the paths
	// before they reached the operations.

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ops = getContainerOps();
			if (!ops) return localRead.execute(id, params, signal, onUpdate);
			return createReadTool(localCwd, { operations: createPodmanReadOps(ops.containerName, ops.pathMapper, ops.remoteUser) })
				.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ops = getContainerOps();
			if (!ops) return localWrite.execute(id, params, signal, onUpdate);
			return createWriteTool(localCwd, { operations: createPodmanWriteOps(ops.containerName, ops.pathMapper, ops.remoteUser) })
				.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ops = getContainerOps();
			if (!ops) return localEdit.execute(id, params, signal, onUpdate);
			return createEditTool(localCwd, { operations: createPodmanEditOps(ops.containerName, ops.pathMapper, ops.remoteUser) })
				.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ops = getContainerOps();
			if (!ops) return localBash.execute(id, params, signal, onUpdate);
			return createBashTool(localCwd, { operations: createPodmanBashOps(ops.containerName, ops.pathMapper, forwardedEnv, ops.remoteUser) })
				.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const ops = getContainerOps();
			if (!ops) return localGrep.execute(_id, params, signal, _onUpdate);
			return executePodmanGrep(ops.containerName, params, signal, ops.pathMapper, ops.remoteUser);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ops = getContainerOps();
			if (!ops) return localFind.execute(id, params, signal, onUpdate);

			// Bypass SDK's createFindTool + resolveToCwd: on Windows, node:path
			// converts Linux container paths to Windows drive-rooted paths.
			// Use localCwd for the SDK tool, but the find operation receives a pathMapper
			// and translates internally.
			return createFindTool(localCwd, { operations: createPodmanFindOps(ops.containerName, ops.pathMapper, ops.remoteUser) })
				.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ops = getContainerOps();
			if (!ops) return localLs.execute(id, params, signal, onUpdate);

			// Same as find: use localCwd so resolveToCwd works with native Windows paths.
			// The LsOperations translate host paths to container paths internally.
			return createLsTool(localCwd, { operations: createPodmanLsOps(ops.containerName, ops.pathMapper, ops.remoteUser) })
				.execute(id, params, signal, onUpdate);
		},
	});

	// ── User ! commands ───────────────────────────────────────────────────

	pi.on("user_bash", (event) => {
		const ops = getContainerOps();
		if (!ops) return;
		// The ops factory translates host→container internally. Pass event.cwd as-is.
		const inner = createPodmanBashOps(ops.containerName, ops.pathMapper, forwardedEnv, ops.remoteUser);
		return {
			operations: {
				exec(cmd: string, _cwd: string, opts: Parameters<BashOperations["exec"]>[2]) {
					return inner.exec(cmd, event.cwd, opts);
				},
			},
		};
	});

	// ── System prompt ─────────────────────────────────────────────────────

	pi.on("before_agent_start", (event) => {
		const ops = getContainerOps();
		if (!ops) return;
		// Edit the structured options rather than returning a systemPrompt: a
		// returned prompt becomes forceSystemPrompt, replacing the whole prompt
		// and discarding sections other extensions contributed. Mutating `cwd`
		// only moves the working-folder line.
		event.systemPromptOptions.cwd = ops.containerCwd;
		// The docs section points at host-only pi install paths that do not exist
		// in the container, so drop it. Removing the named section leaves every
		// other section intact, unlike rewriting the assembled prompt string.
		if ("docs" in event.systemPromptOptions.sections) {
			delete event.systemPromptOptions.sections.docs;
		}
	});

	// ── /dev-container command ────────────────────────────────────────────

	pi.registerCommand("dev-container", {
		description: "Show status or use 'rebuild' to rebuild the dev container from config",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed === "rebuild") {
				const dcPath = path.join(localCwd, ".devcontainer", "devcontainer.json");
				if (!existsSync(dcPath)) {
					ctx.ui.notify("No .devcontainer found — nothing to rebuild", "error");
					return;
				}
				ctx.ui.setStatus("dev-container", ctx.ui.theme.fg("accent", "🐳 rebuilding…"));
				ctx.ui.notify("Rebuilding dev container...", "info");
				try {
					const result = await runDevContainerUp(localCwd, true);
					if (!result.containerId) {
						announceReady({ mode: "host", reason: "rebuild-no-container-id" });
						ctx.ui.notify("Rebuild succeeded but no container ID returned. Using host mode.", "warning");
						resolvedContainer = null;
						ctx.ui.setStatus("dev-container", undefined);
						return;
					}
					const mounts = await getContainerMounts(result.containerId);
					const pathMapper = createPathMapper(localCwd, mounts);
					resolvedContainer = { containerName: result.containerId, containerCwd: result.remoteWorkspaceFolder, pathMapper, remoteUser: result.remoteUser || undefined };
					announceReady({ mode: "container", containerId: result.containerId, containerCwd: result.remoteWorkspaceFolder, remoteUser: result.remoteUser || undefined });
					const label = `${result.containerId.slice(0, 12)}:${result.remoteWorkspaceFolder}`;
					ctx.ui.setStatus("dev-container", ctx.ui.theme.fg("accent", `🐳 ${label}`));
					ctx.ui.notify(`Rebuilt and re-attached: ${label}`, "success");
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					announceReady({ mode: "host", reason: `rebuild: ${msg}` });
					ctx.ui.notify(`Rebuild failed: ${msg}. Dropping to host mode.`, "error");
					resolvedContainer = null;
					ctx.ui.setStatus("dev-container", undefined);
				}
				return;
			}

			const ops = getContainerOps();
			if (!ops) {
				ctx.ui.notify(
					["No dev container — running in host mode", "", "Subcommands:", "  /dev-container rebuild  — rebuild and re-attach"].join("\n"),
					"info",
				);
				return;
			}
			const cn = ops.containerName;
			ctx.ui.notify(
				[
					"Dev Container Status:",
					`  Container:   ${cn.slice(0, 20)}...`,
					`  Working dir: ${ops.containerCwd}`,
					`  Host cwd:    ${localCwd}`,
					"", "Subcommands:",
					"  /dev-container rebuild  — rebuild and re-attach",
				].join("\n"),
				"info",
			);
		},
	});
}
