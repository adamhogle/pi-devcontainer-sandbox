# Changelog

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
