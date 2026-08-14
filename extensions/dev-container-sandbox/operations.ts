/**
 * Podman operations for the Dev Container Sandbox extension.
 *
 * Implements BashOperations, ReadOperations, WriteOperations, EditOperations,
 * LsOperations, FindOperations, and GrepOperations using `podman exec`
 * and `podman inspect` to route tool execution into a running container.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	GrepToolDetails,
	GrepToolInput,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { truncateHead, formatSize, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

// ─── Path Translation ────────────────────────────────────────────────────────

export interface MountInfo {
	source: string;
	destination: string;
}

/**
 * Builds a path translator from podman mount data.
 * Finds the mount containing the host cwd and uses it to translate
 * host paths to container paths.
 */
export function createPathMapper(hostCwd: string, mounts: MountInfo[]): PathMapper {
	const normalizedCwd = normalizePath(hostCwd);
	// On Windows, also try the WSL2 equivalent for matching podman mount sources

	/** Generate variants of a path to try when matching mounts. */
	function pathVariants(p: string): string[] {
		const variants = [p];
		const wsl = windowsToWslPath(p);
		if (wsl != null) variants.push(wsl);
		return variants;
	}

	// Find the best matching mount — longest source prefix match
	let bestMount: MountInfo | null = null;
	let bestPrefixLen = 0;

	const cwdVariants = pathVariants(normalizedCwd);

	for (const mount of mounts) {
		const normSource = normalizePath(mount.source);
		const sourceWithSep = normSource.endsWith("/") ? normSource : normSource + "/";

		for (const cwdVariant of cwdVariants) {
			const cwdWithSep = cwdVariant.endsWith("/") ? cwdVariant : cwdVariant + "/";
			if (cwdWithSep === sourceWithSep || cwdWithSep.startsWith(sourceWithSep)) {
				if (normSource.length > bestPrefixLen) {
					bestPrefixLen = normSource.length;
					bestMount = mount;
				}
			}
		}
	}

	return {
		/**
		 * Translate a host path to a container path.
		 * Handles Windows paths (C:/...) and WSL paths (/mnt/c/...).
		 */
		toContainer(hostPath: string): string {
			if (!hostPath) return "/";
			const normalized = normalizePath(hostPath);

			if (bestMount) {
				const normSource = normalizePath(bestMount.source);
				const normDest = normalizePath(bestMount.destination);

				// Try matching both the original path and WSL variant
				for (const variant of pathVariants(normalized)) {
					if (variant.startsWith(normSource)) {
						const relative = variant.slice(normSource.length);
						return relative ? `${normDest}${relative}` : normDest;
					}
				}
			}

			// Fallback: no matching mount, use path as-is
			return normalized;
		},

		/** The container-side working directory corresponding to hostCwd. */
		containerCwd: bestMount
			? (() => {
					const normSource = normalizePath(bestMount.source);
					const normDest = normalizePath(bestMount.destination);
					// Try matching original and WSL variant
					for (const variant of cwdVariants) {
						if (variant.startsWith(normSource)) {
							const relative = variant.slice(normSource.length);
							return relative ? `${normDest}${relative}` : normDest;
						}
					}
					return normDest;
				})()
			: normalizePath(hostCwd),
	};
}

/** Type for the path mapper returned by createPathMapper */
export interface PathMapper {
	toContainer(hostPath: string): string;
	containerCwd: string;
}

function normalizePath(p: string): string {
	// Convert Windows backslashes to forward slashes, strip trailing slash
	let result = p.replace(/\\/g, "/");
	if (result.endsWith("/")) result = result.slice(0, -1);
	return result;
}

/**
 * Convert a Windows host path to WSL2-style path for matching against
 * podman mount sources. E.g., "C:/Users/Adam/project" → "/mnt/c/Users/Adam/project".
 * Returns null if the path doesn't look like a Windows absolute path.
 */
function windowsToWslPath(p: string): string | null {
	const match = p.match(/^([A-Za-z]):(\/.*)$/);
	if (!match) return null;
	const drive = match[1].toLowerCase();
	return `/mnt/${drive}${match[2]}`;
}

// ─── Podman exec helper ──────────────────────────────────────────────────────

/**
 * Run a podman exec command and capture stdout as a Buffer.
 * Throws on non-zero exit.
 */
function podmanExec(container: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("podman", ["exec", container, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data: Buffer) => chunks.push(data));
		child.stderr.on("data", (data: Buffer) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`podman exec failed (${code}): ${Buffer.concat(errChunks).toString().trim()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

/**
 * Query podman for the container's working directory.
 */
export async function getContainerWorkingDir(container: string): Promise<string> {
	const buf = await podmanExec(container, [
		"sh",
		"-c",
		'echo "${PWD:-/}"',
	]);
	return buf.toString().trim() || "/";
}

/**
 * Query podman for all bind mount info.
 * Uses `podman inspect` from the host to get proper host-side source paths.
 */
export async function getContainerMounts(container: string): Promise<MountInfo[]> {
	try {
		const buf = await new Promise<Buffer>((resolve, reject) => {
			const child = spawn("podman", [
				"inspect",
				container,
				"--format",
				"{{json .Mounts}}",
			], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const chunks: Buffer[] = [];
			const errChunks: Buffer[] = [];
			child.stdout.on("data", (data: Buffer) => chunks.push(data));
			child.stderr.on("data", (data: Buffer) => errChunks.push(data));
			child.on("error", reject);
			child.on("close", (code) => {
				if (code !== 0) {
					reject(
						new Error(
							`podman inspect mounts failed (${code}): ${Buffer.concat(errChunks).toString().trim()}`,
						),
					);
				} else {
					resolve(Buffer.concat(chunks));
				}
			});
		});

		const parsed = JSON.parse(buf.toString().trim()) as Array<{
			Source: string;
			Destination: string;
			Type: string;
		}>;

		const mounts: MountInfo[] = [];
		for (const m of parsed) {
			if (m.Type === "bind" || m.Type === "volume") {
				mounts.push({ source: m.Source, destination: m.Destination });
			}
		}

		return mounts;
	} catch {
		// Fallback: return empty mounts, path translation will use paths as-is
		return [];
	}
}

// ─── Bash Operations ─────────────────────────────────────────────────────────

export function createPodmanBashOps(container: string, pathMapper?: PathMapper): BashOperations {
	const toCont = (p: string): string => pathMapper?.toContainer(p) ?? p;
	return {
		exec(command, cwd, { onData, signal, timeout }): Promise<BashOutput> {
			return new Promise((resolve, reject) => {
				// Translate cwd to container path, then cd to it
				const containerCwd = toCont(cwd);
				const fullCommand = `cd ${quote(containerCwd)} && ${command}`;

				const child = spawn("podman", ["exec", "-i", container, "bash", "-lc", fullCommand], {
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						killChild(child);
					}, timeout * 1000);
				}

				child.stdout.on("data", onData);
				child.stderr.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = (): void => { killChild(child); };
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted === true) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code ?? 0 });
					}
				});
			});
		},
	};
}

// ─── Read Operations ─────────────────────────────────────────────────────────

export function createPodmanReadOps(container: string, pathMapper?: PathMapper): ReadOperations {
	const toCont = (p: string): string => pathMapper?.toContainer(p) ?? p;
	return {
		async readFile(filePath): Promise<string> {
			return podmanExec(container, ["cat", toCont(filePath)]);
		},

		async access(filePath: string) {
			await podmanExec(container, ["test", "-r", toCont(filePath)]);
		},

		async detectImageMimeType(filePath: string) {
			const cp = toCont(filePath);
			const ext = cp.toLowerCase().split(".").pop();
			if (ext === "png") return "image/png";
			if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
			if (ext === "gif") return "image/gif";
			if (ext === "webp") return "image/webp";
			try {
				const buf = await podmanExec(container, ["file", "--mime-type", "-b", cp]);
				const mime = buf.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

// ─── Write Operations ────────────────────────────────────────────────────────

export function createPodmanWriteOps(container: string, pathMapper?: PathMapper): WriteOperations {
	const toCont = (p: string): string => pathMapper?.toContainer(p) ?? p;
	return {
		async writeFile(filePath: string, content: string | Buffer): Promise<void> {
			const cp = toCont(filePath);
			const input = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
			const b64 = input.toString("base64");
			await podmanExec(container, [
				"sh",
				"-c",
				`mkdir -p $(dirname ${quote(cp)}) && echo ${quote(b64)} | base64 -d > ${quote(cp)}`,
			]);
		},

		async mkdir(dirPath: string): Promise<void> {
			await podmanExec(container, ["mkdir", "-p", toCont(dirPath)]);
		},
	};
}

// ─── Edit Operations ─────────────────────────────────────────────────────────

export function createPodmanEditOps(container: string, pathMapper?: PathMapper): EditOperations {
	const readOps = createPodmanReadOps(container, pathMapper);
	const writeOps = createPodmanWriteOps(container, pathMapper);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

// ─── Ls Operations ───────────────────────────────────────────────────────────

export function createPodmanLsOps(container: string, pathMapper?: PathMapper): LsOperations {
	const toCont = (p: string): string => pathMapper?.toContainer(p) ?? p;
	return {
		async exists(filePath: string): Promise<boolean> {
			try {
				await podmanExec(container, ["test", "-e", toCont(filePath)]);
				return true;
			} catch {
				return false;
			}
		},

		async stat(filePath: string) {
			const cp = toCont(filePath);
			const buf = await podmanExec(container, [
				"stat",
				"--format",
				'{"mode":"%f","size":%s,"mtime":%Y,"permissions":"%A"}',
				cp,
			]);
			const data = JSON.parse(buf.toString().trim()) as {
				mode?: string;
				size: number;
				mtime: number;
				permissions: string;
			};
			const modeInt = (data.mode != null && data.mode !== "") ? Number.parseInt(data.mode, 16) : 0;
			return {
				size: data.size,
				mtimeMs: data.mtime * 1000,
				mode: modeInt,
				isDirectory: data.permissions.startsWith("d"),
				isFile: data.permissions.startsWith("-"),
				isSymbolicLink: data.permissions.startsWith("l"),
			};
		},

		async readdir(dirPath: string) {
			const cp = toCont(dirPath);
			const buf = await podmanExec(container, [
				"sh",
				"-c",
				`ls -1a ${quote(cp)} 2>/dev/null || echo ""`,
			]);
			const entries = buf
				.toString()
				.trim()
				.split("\n")
				.filter((e) => e !== "" && e !== "." && e !== "..");
			return entries;
		},
	};
}

// ─── Find Operations ────────────────────────────────────────────────────────

export function createPodmanFindOps(container: string, pathMapper?: PathMapper): FindOperations {
	const toCont = (p: string): string => pathMapper?.toContainer(p) ?? p;
	return {
		async exists(filePath: string): Promise<boolean> {
			try {
				await podmanExec(container, ["test", "-e", toCont(filePath)]);
				return true;
			} catch {
				return false;
			}
		},

		async glob(pattern: string, cwd: string, options: { limit?: number; signal?: AbortSignal; cwd?: string; ignore?: string[] }) {
			const limit = options.limit ?? 1000;
			const searchRoot = toCont(options.cwd ?? cwd);

			// Build ignore-prune clauses for find
			let pruneClause = "";
			if (options.ignore && options.ignore.length > 0) {
				const prunePatterns = options.ignore.map((pat: string) => {
					// Convert glob-like ignore patterns (e.g., "**/node_modules/**") to find -path patterns
					const dirName = pat.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
					return `-path '*/${dirName}/*' -o -path '*/${dirName}'`;
				});
				pruneClause = ` ( ${prunePatterns.join(" -o ")} ) -prune -o`;
			}

			const cmd = `find ${quote(searchRoot)} ${pruneClause} -type f -name ${quote(pattern)} -print 2>/dev/null | head -${limit}`;
			const buf = await podmanExec(container, ["sh", "-c", cmd], options.signal);
			const lines = buf
				.toString()
				.trim()
				.split("\n")
				.filter((l: string) => l);
						// Strip searchRoot prefix from results so they are relative paths.
			// The SDK's relativizeFindResultPath receives searchPath as a resolved
			// host path (e.g. C:Users...) and resultPath as a container Linux path
			// (e.g. /workspaces/...). path.relative() on Windows can't compute a
			// relative path between incompatible path formats, producing garbage.
			// By returning relative paths, relativizeFindResultPath sees non-absolute
			// paths and passes them through unchanged. (Bug 15 fix)
			const searchRootWithSep = searchRoot.endsWith("/") ? searchRoot : searchRoot + "/";
			return lines.map((l) => {
				if (l.startsWith(searchRootWithSep)) return l.slice(searchRootWithSep.length);
				if (l === searchRoot) return ".";
				return l;
			});
		},
	};
}

// ─── Grep Operations (direct execute function) ───────────────────────────────

/**
 * Execute grep inside the container via podman exec.
 * Returns formatted output with context lines and match information.
 */
export async function executePodmanGrep(
	container: string,
	params: GrepToolInput,
	signal?: AbortSignal,
	pathMapper?: PathMapper,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
	const toCont = (p: string): string => pathMapper?.toContainer(p) ?? p;
	const { pattern, path: searchPath, literal, ignoreCase, context, glob: globPattern, limit } = params;

	// Build grep arguments
	const grepArgs: string[] = ["grep", "-n"]; // always show line numbers
	if (literal === true) grepArgs.push("-F");
	if (ignoreCase === true) grepArgs.push("-i");
	if (context != null && context > 0) {
		grepArgs.push("-C", String(context));
	}
	// Recursive by default if it's a directory
	grepArgs.push("-r");
	grepArgs.push("--");
	grepArgs.push(pattern);
	grepArgs.push(toCont(searchPath ?? "."));

	// Apply glob filter if specified
	if (globPattern != null && globPattern !== "") {
		grepArgs.push("--include", globPattern);
	}

	const effectiveLimit = Math.max(1, limit ?? 100);

	try {
		const buf = await podmanExec(container, grepArgs, signal);
		const raw = buf.toString();

		if (!raw.trim()) {
			return { content: [{ type: "text", text: "No matches found" }], details: undefined };
		}

		// Split into lines and apply limit
		const allLines = raw.split("\n");
		const truncated = allLines.slice(0, effectiveLimit + 1); // +1 to detect truncation
		const matchLimitReached = allLines.length > effectiveLimit;

		let output = truncated.join("\n");
		const notices: string[] = [];
		const details: GrepToolDetails = {};

		if (matchLimitReached) {
			details.matchLimitReached = effectiveLimit;
			notices.push(`${effectiveLimit} matches limit reached`);
		}

		// Apply size truncation
		const sizeTruncation = truncateHead(output, {
			maxLines: Number.MAX_SAFE_INTEGER,
		});
		if (sizeTruncation.truncated) {
			details.truncation = sizeTruncation;
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		output = sizeTruncation.content;

		if (notices.length > 0) {
			output += `\n\n[${notices.join(". ")}]`;
		}

		return {
			content: [{ type: "text", text: output }],
			details: Object.keys(details).length > 0 ? details : undefined,
		};
	} catch (err) {
		if (signal?.aborted === true) throw new Error("aborted");
		// grep returns exit code 1 when no matches found
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("failed (1)")) {
			return { content: [{ type: "text", text: "No matches found" }], details: undefined };
		}
		throw err;
	}
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function quote(s: string): string {
	// Simple shell quoting for podman exec
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
	try {
		child.kill(signal);
	} catch {
		// Already exited
	}
}

// Re-export types for consumers
export type { GrepToolInput } from "@earendil-works/pi-coding-agent";
