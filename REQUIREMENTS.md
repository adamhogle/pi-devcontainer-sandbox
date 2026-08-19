# Dev Container Sandbox Extension — Requirements

## Overview

A pi extension that routes all built-in tools (read, write, edit, bash, grep, find, ls) into a running Podman dev container. When no container is detected, pi runs normally in host mode.

## Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/extensions/dev-container-sandbox/index.ts` | Extension entry point: detection, tool overrides, status command |
| `~/.pi/agent/extensions/dev-container-sandbox/operations.ts` | Podman operation backends (read, write, edit, bash, ls, find, grep) |
| `~/.pi/agent/extensions/dev-container-sandbox/forward-env.ts` | Reads env forwarding config from pi settings and resolves values from `process.env` |

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
| `bash` | `podman exec -i <container> bash -lc "<command>"` with streaming, timeout, abort. Supports `--env KEY=VALUE` for configured forwarded env vars |
| `grep` | `podman exec <container> grep -rn` with context, limit, glob support |
| `find` | `podman exec <container> find ...` |
| `ls` | `podman exec <container> stat` for single files, `ls -1a` for directories |

### Environment variable forwarding
When running commands inside the dev container, environment variables from the host
(API keys, tokens, etc.) are not automatically available. Use env forwarding to pass
specific variables through `podman exec --env`.

#### Configuration

Env forwarding only applies to **bash operations** (`tool(bash)` and `!` commands).
File tools (read, write, edit, ls, find, grep) do not receive forwarded env vars.

**1. Pi settings (recommended, set once)**

Add a `dev-container-sandbox.forwardEnv` array to your global `~/.pi/agent/settings.json`:

```json
{
  "dev-container-sandbox": {
    "forwardEnv": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
  }
}
```

You can also add project-specific overrides in `.pi/settings.json`; they merge with
the global config.

**2. Environment variable (ad-hoc)**

```bash
SANDBOX_FORWARD_ENV=OPENAI_API_KEY,ANTHROPIC_API_KEY pi
```

If both sources specify the same name, it is deduplicated. Only variables that are
actually set in `process.env` at startup are forwarded. This works naturally with
`envchain my-secret pi` — configure the names in settings once, and values are
picked up from whatever envchain provides.

#### Scope

#### Security consideration

Env vars are passed to `podman exec` as `--env KEY=VALUE` command-line arguments.
On most systems, these arguments are visible to other users via `ps aux` or
`/proc/*/cmdline` while the process is running. Avoid using env forwarding on
shared machines or in CI environments where process listings are accessible to
untrusted parties. For local development machines, this is generally not a concern
since only your user can see your own processes.

| Operation | Receives env vars? | Reason |
|-----------|-------------------|--------|
| `tool(bash)` | ✅ | Agent shell commands need API keys |
| `!` / `!!` commands | ✅ | User shell commands need API keys |
| `tool(read)` | ❌ | File reads don't need env vars |
| `tool(write)` | ❌ | File writes don't need env vars |
| `tool(edit)` | ❌ | Composed of read + write |
| `tool(find)` | ❌ | File search doesn't need env vars |
| `tool(ls)` | ❌ | File listing doesn't need env vars |
| `tool(grep)` | ❌ | Text search doesn't need env vars |

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

## Devcontainer Configuration

### Required: Mount `~/.pi/` into the container

All tool calls (read, write, bash, etc.) are routed into the container via `podman exec`. Skills, settings, auth, and prompts live in `~/.pi/` on the **host** filesystem. If this directory is not mounted into the container, the agent will fail to read skill files, settings, and other resources.

> **Note:** This mount is for **your project's** `.devcontainer/devcontainer.json`, not this repo's. This repo's config is for development and CI, which don't need skills.

Add a bind mount to your project's `.devcontainer/devcontainer.json`:


```json
"mounts": [
  "source=${localEnv:HOME}/.pi,target=${localEnv:HOME}/.pi,type=bind,consistency=cached"
]
```

This mounts the host's `~/.pi/` into the container at the same path. The `${localEnv:HOME}` variable expands to the host user's home directory.

Without this mount, the following resources will be **inaccessible** inside the container:

| Resource | Host Path | Effect if not mounted |
|----------|-----------|-----------------------|
| Skills | `~/.pi/agent/skills/` | Agent can't read SKILL.md files |
| Settings | `~/.pi/agent/settings.json` | Global settings unavailable |
| Auth | `~/.pi/agent/auth.json` | Credentials unavailable |
| Prompts | `~/.pi/agent/prompts/` | Prompt templates broken |
| Extensions | `~/.pi/agent/extensions/` | Global extensions can't load scripts |
| Themes | `~/.pi/agent/themes/` | Custom themes unavailable |
| Sessions | `~/.pi/sessions/` | Session history and state unavailable |

### Why mount instead of local fallback?

An alternative approach would be to detect unmapped paths and fall back to local (host) execution. This was attempted but abandoned because it creates an inconsistent experience: the agent sees some paths work in-container and some locally, without any way to distinguish which is which. Mounting ensures **all** tool calls go through the same podman exec path, giving the agent a uniform environment.
