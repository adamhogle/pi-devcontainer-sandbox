# Dev Container Sandbox — pi Extension

[![CI](https://github.com/adamhogle/pi-devcontainer-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/adamhogle/pi-devcontainer-sandbox/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Routes [pi](https://github.com/earendil-works/pi-coding-agent)'s built-in tools (read, write, edit, bash, grep, find, ls) in to a running [Podman](https://podman.io/) dev container.

## The Problem

When working inside a dev container, tools like `ls`, `find`, `read`, and `bash` need  to operate on files **inside** the container, not on the host filesystem. Without this extension, pi's tools only see host paths, which means:

- `ls /workspaces/project` fails because the LLM's cwd is inside the container
- `find src/**/*.ts` returns host results, not container results
- `read` and `write` target host files, not container project files

This extension intercepts all seven tools and transparently routes them in to a Podman-managed dev container, translating host paths (`C:\Users\...` or `/home/...`)  to container paths (`/workspaces/...`) so the LLM sees a seamless environment.

## Features

- **Auto-detection** — Detects running dev containers at startup via `podman ps` + `inspect`
- **Auto-start** — Builds and starts containers using `@devcontainers/cli` if none is running
- **Tool routing** — All 7 built-in tools (read, write, edit, bash, grep, find, ls) run inside the container
- **`!` command routing** — `!command` and `!!command` execute inside the container when active
- **CWD translation** — Working directory is transparently translated from host  to container paths
- **System prompt** — Updates the `Current working directory` line  to show the container workspace path
- **Manual override** — `pi --dev-container <name>`  to skip auto-detection
- **Rebuild** — `/dev-container rebuild`  to rebuild from devcontainer config
- **Status** — `/dev-container` shows current container ID and workspace
- **Host fallback** — No container = all tools run normally on host

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pi](https://github.com/earendil-works/pi-coding-agent) installed globally (`npm install -g @earendil-works/pi-coding-agent`)
- [Podman](https://podman.io/) installed and running
- A project with a `.devcontainer/devcontainer.json` configuration

## Install

### Manual / Development install

Clone the repo and copy the source files  to pi's extension directory:

```bash
git clone https://github.com/adamhogle/pi-devcontainer-sandbox.git
cd pi-devcontainer-sandbox
npm install
npm test
cp extensions/dev-container-sandbox/*.ts ~/.pi/agent/extensions/dev-container-sandbox/
```

### Try without installing

```bash
pi -e extensions/dev-container-sandbox/index.ts
```

Then start pi from a project that has a `.devcontainer/devcontainer.json`. The extension auto-detects the container on session start.

## Usage

Start pi from a project with a `.devcontainer/devcontainer.json`:

```bash
pi
```

The extension automatically detects or starts the container. Verify with:

```
/dev-container
```

Expected output:

```
 Active container: <id> -> /workspaces/your-project
```

Commands available:

| Command | Description |
|---------|-------------|
| `/dev-container` | Show container status |
| `/dev-container rebuild` | Rebuild container from devcontainer config |

### Manual container selection

```bash
pi --dev-container <container-name-or-id>
```

Skips auto-detection and attaches  to the specified container directly.

## How It Works

1. **Session start** — Extension checks for `.devcontainer/devcontainer.json`, then scans running podman containers for one that mounts the project directory
2. **Auto-start** — If no running container is found, runs `npx @devcontainers/cli up --docker-path podman`  to build and start
3. **Tool interception** — Each built-in tool (read, write, edit, bash, grep, find, ls) is replaced with a wrapper that executes the equivalent operation inside the container via `podman exec`
4. **Path translation** — Host paths are transparently converted  to container paths (e.g., `/home/user/project`  to `/workspaces/project`)

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No `.devcontainer/` | Extension is a no-op — all tools run on host |
| Container not running | Auto-starts via `@devcontainers/cli` |
| Invalid `--dev-container` | Error reported, falls back  to host mode |
| Container stops mid-session | Next tool call fails with podman error |
| Windows + WSL | Paths are converted from `C:\...`  to `/mnt/c/...` for matching |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow (TDD: Red → Green → Refactor), coding conventions, and test suite.

### Quick start

```bash
npm install
npm test           # 150+ tests
npm run lint       # Strict TypeScript linting
npm run test:coverage  # Code coverage report
```

## Project Structure

```
pi-devcontainer-sandbox/
├── .github/workflows/ci.yml     # CI (build + test on push/PR)
├── extensions/dev-container-sandbox/
│   ├── index.ts                  # Extension entry point
│   └── operations.ts             # Podman operation backends
├── tests/
│   ├── helpers/                  # Mock podman / mock pi API
│   └── operations/               # Unit tests
├── CONTRIBUTING.md               # Development guide
├── REQUIREMENTS.md               # Full behavior specification
└── README.md                     # This file
```

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
