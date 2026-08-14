# Contributing

Thanks for your interest in the Dev Container Sandbox extension for pi!

## Table of Contents

- [Project Structure](#project-structure)
- [Development Workflow: Red → Green → Refactor](#development-workflow-red--green--refactor)
- [Running Tests](#running-tests)
- [Code Coverage](#code-coverage)
- [Coding Conventions](#coding-conventions)
  - [Path Translation](#path-translation)
  - [Tool Overrides (index.ts)](#tool-overrides-indexts)
  - [Operations (operations.ts)](#operations-operationsts)
- [Known Bugs & Regression Tests](#known-bugs--regression-tests)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Deployment](#deployment)

## Project Structure

```
pi-devcontainer-sandbox/
├── extensions/dev-container-sandbox/   # Source code (TypeScript)
│   ├── index.ts                        # Extension entry point
│   └── operations.ts                   # Podman operation backends
├── tests/                              # Test suite (TDD-driven)
│   ├── helpers/
│   │   ├── mock-podman.ts              # Mock spawn for podman
│   │   └── mock-pi-api.ts              # Mock ExtensionAPI
│   ├── operations/
│   │   ├── path-mapper.test.ts
│   │   ├── utils.test.ts
│   │   ├── read-write.test.ts
│   │   ├── bash.test.ts
│   │   ├── ls.test.ts
│   │   ├── find.test.ts
│   │   ├── grep.test.ts
│   │   └── inspect.test.ts
│   └── index.test.ts
├── .github/workflows/tag-release.yml       # Release (version check + tag on merge)
├── package.json
├── CHANGELOG.md                        # Release history
├── CONTRIBUTING.md                     # This file
├── REQUIREMENTS.md                     # Full behavior specification
└── README.md
```

## Development Workflow: Red → Green → Refactor

Every bug fix or feature follows this three-phase TDD discipline.

### 1. Red — Write a failing test first

Before touching any implementation, write a test that demonstrates the bug or specifies the new behavior. This proves you understand the root cause.

```bash
npm test   # Expected: NEW test FAILS, all others PASS
```

### 2. Green — Fix the implementation

Change only the production code  to make the new test pass. Do not modify existing tests.

```bash
npm test   # Expected: ALL tests PASS (including the new one)
```

### 3. Refactor — Clean up

Improve naming, extract helpers, simplify logic — while keeping all tests green.

```bash
npm test   # Expected: ALL tests PASS
```

## Running Tests

```bash
# Full suite
npm test

# Full suite with code coverage
npm run test:coverage

# Coverage reports are generated in ./coverage/
# - text: terminal summary + per-file breakdown
# - lcov: for IDE plugins (e.g. coverage-gutters)
# - html: open coverage/index.html in a browser

# Single test file (watch mode)
npx vitest tests/operations/find.test.ts

# All operation tests
npx vitest tests/operations/
```

Test runner: Vitest (configured in `vitest.config.ts`). TypeScript source is loaded via `vite` (no build step needed).

## Code Coverage

Coverage is configured in `vitest.config.ts` using `@vitest/coverage-v8`.

| Feature | Value |
|---------|-------|
| Provider | v8 (native Node.js — fast, no transpiler) |
| Scope | `extensions/dev-container-sandbox/**/*.ts` |
| Excluded | `.d.ts` declaration files |
| Reports | `text`, `text-summary`, `lcov`, `html` |
| Output | `./coverage/` |
| Watermarks | Statements/Functions `[60, 80]`, Branches `[50, 70]` |

### Goals

| Metric | Target |
|--------|--------|
| Statements | >= 80% |
| Branches   | >= 70% |
| Functions  | >= 80% |
| Lines      | >= 80% |

Check coverage before and after your change  to prevent regressions:

```bash
# Before your change
git stash && npm run test:coverage | tail -12
git stash pop

# After your change
npm run test:coverage | tail -12
```

## Coding Conventions

### Path Translation

- **All path translation lives inside operation factories**, never in `index.ts`.
- Each operation factory accepts `pathMapper?: PathMapper` as the last parameter.
- Operations call `toCont(path)` internally  to translate host  to container.
- If `pathMapper` is undefined, paths pass through unchanged (host mode).

### Tool Overrides (index.ts)

- Always use `localCwd` (host cwd) as the tool cwd:

```typescript
// CORRECT
return createReadTool(localCwd, { operations: createPodmanReadOps(name, pathMapper) })

// WRONG — causes resolveToCwd corruption on Windows
return createReadTool(ops.containerCwd, { ... })
```

- Pass raw params through (no pre-translation):

```typescript
// CORRECT — operation translates internally
return createReadTool(localCwd, { operations: createPodmanReadOps(name, pathMapper) })
    .execute(id, params, signal, onUpdate);

// WRONG — double translation
return createReadTool(localCwd, { operations: createPodmanReadOps(name) })
    .execute(id, { ...params, path: pathMapper.toContainer(params.path) }, signal, onUpdate);
```

### Operations (operations.ts)

- Each factory: `export function createXxxOps(container: string, pathMapper?: PathMapper): XxxOperations`
- Create `const toCont = (p: string) => pathMapper?.toContainer(p) ?? p;` at the top
- Translate each path parameter before passing  to podman

## Known Bugs & Regression Tests

| # | Bug | Root Cause | Fix | Regression Test |
|---|---|---|---|---|
| 1 | `ls`/`find` show Windows paths inside container | `resolveToCwd()` on Windows converts `/workspace/foo`  to `C:\workspace\foo` | All tools use `localCwd` (host) as tool cwd; operations translate paths internally | Each tool override test verifies `createXTool(localCwd, ...)` is used, NOT `createXTool(ops.containerCwd, ...)` |
| 2 | `user_bash` double-translates cwd | Handler called `pathMapper.toContainer(event.cwd)` then ops translated again | Pass `event.cwd` as-is (raw host path)  to ops factory | `user_bash` handler test verifies no pre-translation |
| 3 | Find results show garbled paths on Windows | `createPodmanFindOps.glob` returned absolute container paths; SDK `relativizeFindResultPath` can't relativize between host Windows and container Linux paths | Strip `searchRoot` prefix from find results before returning | `glob` returns relative paths (prefix stripped), not absolute container paths |

## Pull Request Guidelines

- **One PR per bug or feature.** Keep changes focused and reviewable.
- **Follow Red → Green → Refactor.** The PR should include the test that proves the fix (Red) and the implementation (Green).
- **All tests must pass.** Run `npm test` before submitting.
- **Lint must pass.** Run `npm run lint` — the ESLint config is strict.
- **Coverage should not regress.** Check `npm run test:coverage` before and after.
- **Keep the known bugs table up  to date.** When you fix a bug, move its row  to the commit message reference.
- **Document new behavior** in `REQUIREMENTS.md` if it changes the extension's external contract.

## Release Workflow

Every PR that merges to `main` produces a new release. The version is determined by a GitHub label on the PR.

### Labels

| Label | Effect | Example |
|-------|--------|--------|
| `release-patch` | Patch bump (0.1.0 → 0.1.1) | Bug fixes, minor changes |
| `release-minor` | Minor bump (0.1.0 → 0.2.0) | New features, breaking 0.x changes |
| `release-major` | Major bump (1.0.0 → 2.0.0) | Breaking changes after 1.0 |
| _(none)_ | No version change | Docs-only, refactors, CI changes |

Apply exactly one release label per PR. CI will fail if multiple are detected.

### Developer workflow

```bash
# 1. Create branch, make changes, write tests

# 2. Bump the version
#    Run the appropriate command for your label:
#    npm version patch --no-git-tag-version   # for release-patch
#    npm version minor --no-git-tag-version   # for release-minor
#    npm version major --no-git-tag-version   # for release-major

# 3. Commit the version bump (can be combined with feature commit)
git add package.json
git commit -m "feat: my feature"

# 4. Open PR, add the matching release label
#    CI validates the version bump matches the label

# 5. Rebase onto main, then ff-merge
#    Post-merge, CI creates a git tag and GitHub Release automatically
```

### How it works

1. **PR check** — CI reads the PR label and validates that `package.json` version is bumped by the correct amount from the latest tag on `main`.
2. **Post-merge** — CI creates a git tag (`v0.1.1`) and a GitHub Release with auto-generated release notes.

No release branches, no manual tagging, no npm publish needed. Every merge is a release.

### Why every merge?

This project uses git-based install (`pi install github:adamhogle/pi-devcontainer-sandbox`). Users pin to a specific tag (`#v0.1.0`) for stability or run `pi update` to get the latest. Frequent releases with clear semver signals are better than infrequent batched releases for this model.

To batch multiple changes into one release, open a single PR containing all the changes with one version bump.

## Deployment

### For end users

```bash
# Install
pi install github:adamhogle/pi-devcontainer-sandbox

# Update to latest
pi update dev-container-sandbox
# Or:
pi update --all
```

### For development testing

The deployed copy lives at `~/.pi/agent/extensions/dev-container-sandbox/`. To test local changes without committing:

```bash
npm test && cp extensions/dev-container-sandbox/*.ts ~/.pi/agent/extensions/dev-container-sandbox/
```

### Publishing a release

Releases are automatic via CI. When your PR with a `release-*` label merges to `main`:

1. CI creates a git tag (`v0.1.0`, `v0.2.0`, etc.)
2. CI creates a GitHub Release with auto-generated notes
3. Users running `pi update dev-container-sandbox` get the latest code from `main`
4. Users who pinned to a tag continue on that version until they explicitly change their pin
