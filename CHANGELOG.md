# Changelog

## [0.3.0] - 2026-09-25

### Added

- Tool operations now run as the dev container's remote user instead of root
  - The user is read from the `devcontainer.metadata` label (`remoteUser` or `containerUser`), or from the `devcontainer up` result for containers this extension starts
  - Files written by the agent are owned by the configured dev container user

### Files

- Modified `operations.ts` — added `getContainerRemoteUser`, and an optional `user` parameter threaded through every operation factory and `podman exec` call
- Modified `index.ts` — resolves the remote user on attach and passes it to all tool operations

## [0.2.0] - 2026-08-19

### Added

- Environment variable forwarding into dev containers
  - Configure env var names to forward via pi settings (`dev-container-sandbox.forwardEnv` in `settings.json`) or `SANDBOX_FORWARD_ENV` environment variable
  - Only bash operations (agent `tool(bash)` and user `!` commands) receive forwarded env vars; file tools are unaffected
  - Values are resolved from `process.env` at session start

### Files

- New `forward-env.ts` — reads env forwarding config from pi settings and resolves values
- Modified `operations.ts` — `createPodmanBashOps` now accepts optional `envVars` parameter
- Modified `index.ts` — calls `getForwardedEnv()` on session start, threads into bash tool and user_bash handler

## [0.1.1] - 2025-06-09

### Fixed

- Release workflow `tag-and-release` job failing on merge to main
  - Removed redundant `github.ref` condition (already scoped by `on:` trigger)
  - Moved label extraction inline to avoid evaluation issues on push events

## [0.1.0] - 2025-06-09

### Added

- Initial release as a pi package
- Tool routing for read, write, edit, bash, grep, find, ls into Podman dev containers
- Auto-detection of running containers on session start
- Auto-start via `@devcontainers/cli`
- `/dev-container` status command
- `/dev-container rebuild` command
- Path translation from host → container paths (Windows/WSL support)
- Host fallback when no container is detected
- `--dev-container <name>` manual override flag

