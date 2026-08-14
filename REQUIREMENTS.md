# Dev Container Sandbox Extension — Requirements

## Overview

A pi extension that routes all built-in tools (read, write, edit, bash, grep, find, ls) into a running Podman dev container. When no container is detected, pi runs normally in host mode.

## Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/extensions/dev-container-sandbox/index.ts` | Extension entry point: detection, tool overrides, status command |
| `~/.pi/agent/extensions/dev-container-sandbox/operations.ts` | Podman operation backends (read, write, edit, bash, ls, find, grep) |

## Behavior

### Auto-detection (no flags needed)

On `session_start`, the extension:
1. Checks if `.devcontainer/devcontainer.json` exists in the project
2. If yes, runs `podman ps -q` to list running containers
3. For each running container, runs `podman inspect <id> --format '{{json .Mounts}}'`
4. Checks if any mount source matches the project directory (with Windows → WSL path conversion)
5. If a match is found, extracts the container ID and workspace folder, then attaches
6. If no match, runs `npx @devcontainers/cli up --docker-path podman` to build and start the container
7. If devcontainer up also fails, reports the error and falls back to host mode

### Manual override

```bash
pi --dev-container <container-name-or-id>
```

Skips auto-detection and attaches to the specified container directly. Useful for containers that don't mount the project directory.

### Rendered tools

All 7 built-in tools are overridden:

| Tool | Container implementation |
|------|------------------------|
| `read` | `podman exec <container> cat <path>` |
| `write` | Base64-encode content, `podman exec sh -c "echo <b64> \| base64 -d > <path>"` |
| `edit` | Composed from read + write |
| `bash` | `podman exec -i <container> bash -lc "<command>"` with streaming, timeout, abort |
| `grep` | `podman exec <container> grep -rn` with context, limit, glob support |
| `find` | `podman exec <container> find ...` |
| `ls` | `podman exec <container> stat` for single files, `ls -1a` for directories |

### User `!` commands

When a container is active, `!command` and `!!command` are routed into the container via the same bash operation backend. When no container is active, they run locally (pi's default behavior).

### CWD translation

- The `cwd` for bash commands is translated from host path to container path using pathMapper
- Relative file paths are resolved against the container's workspace folder (e.g., `/workspaces/stock-trading`), not the container root (`/`)

### System prompt

The system prompt's `Current working directory` line is updated to show the container workspace path instead of the host path.

### Status command

```
/dev-container
```

Shows the current container ID and workspace folder, or reports "host mode".

## Edge Cases

### No `.devcontainer` directory
Extension is a no-op — all tools run on host. No podman commands are executed.

### `.devcontainer` exists but no container running
Extension automatically runs `npx @devcontainers/cli up --docker-path podman` to build and start the container. If auto-start fails, reports the error and stays in host mode.

### `--dev-container` flag with invalid container
Error is caught and reported; extension falls back to host mode.

### Container stops mid-session
The next tool call will fail with a podman error. The tool result is marked as an error and shown to the LLM, which can decide how to handle it.

### Windows path translation

On Windows with podman (WSL2 backend):
- `process.cwd()` returns Windows paths (`C:\Users\...`)
- `podman inspect .Mounts` returns WSL paths (`/mnt/c/Users/...`)
- Extension converts Windows paths to WSL format (`windowsToWslPath()`) for matching
- File paths in tools are handled as-is (podman exec inside the container uses Linux paths)

### Windows spawn compatibility

- `podman` is a `.exe` and works with `spawn("podman", ...)` directly
- `npx.cmd` is a batch file and needs `{ shell: true }`

### Devcontainer CLI integration

Uses `npx @devcontainers/cli up --docker-path podman` for container lifecycle management.
The `--docker-path podman` flag tells the CLI to use podman as the container runtime.

### Rebuild (`/dev-container rebuild`)

Runs `npx @devcontainers/cli up --workspace-folder . --remove-existing-container --docker-path podman`
to rebuild the container from devcontainer config and re-attach without restarting pi.

### Auto-detection order

1. Check `.devcontainer/devcontainer.json` exists
2. Fast path: scan running podman containers via `podman ps` + `inspect` for one with the project mounted
3. If not found: run `devcontainer up` to build/start the container
4. If everything fails: host mode

## Dependencies

- `node:child_process` spawn
- pi's built-in `createBashTool()` / `createReadTool()` etc.
- `@devcontainers/cli` (installed via npx on first use)
- `podman` CLI
