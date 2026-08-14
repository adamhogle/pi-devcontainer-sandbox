# Dev Container Sandbox — Agent Guide

This file is loaded by pi as a context file. For contributing guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick Reference

- **Project structure**: See [CONTRIBUTING.md#project-structure](CONTRIBUTING.md#project-structure)
- **Development workflow**: Red to Green to Refactor TDD. See [CONTRIBUTING.md#development-workflow-red--green--refactor](CONTRIBUTING.md#development-workflow-red--green--refactor)
- **Running tests**: `npm test` or `npx vitest tests/path/to/test.test.ts`
- **Code coverage**: `npm run test:coverage` — HTML report at `coverage/index.html`
- **Coding conventions**: Path translation inside operation factories, never in `index.ts`
- **Known bugs**: See [CONTRIBUTING.md#known-bugs--regression-tests](CONTRIBUTING.md#known-bugs--regression-tests)
- **Release workflow**: Every PR that merges to `main` is a release. See [CONTRIBUTING.md#release-workflow](CONTRIBUTING.md#release-workflow)
- **Release labels**: `release-patch`, `release-minor`, `release-major` — apply exactly one per PR, or none for docs/CI-only
- **Version bump**: `npm version patch --no-git-tag-version` (or minor/major) before pushing the PR
- **CI validation**: CI verifies the version in `package.json` matches the label. Run `npm test` locally first.
- **Merge method**: Rebase + fast-forward merge only
- **Deploy (dev)**: `npm test && cp extensions/dev-container-sandbox/*.ts ~/.pi/agent/extensions/dev-container-sandbox/`
- **Deploy (release)**: Automatic — merging a labeled PR creates the tag and GitHub Release

## Key Principles

1. **TDD first** — Write the failing test before touching implementation.
2. **Path mapping lives in operations** — `index.ts` never translates paths explicitly.
3. **localCwd as tool cwd** — Always use the host cwd, not the container cwd, for tool factories.
4. **No double translation** — Pass raw host paths to operation factories; they translate internally.

## Guardrails

- **Never modify `.github/workflows/` files without asking me first.** Show me the proposed changes and wait for my approval before committing or pushing any workflow changes.
- This applies to any CI/CD configuration, action updates, or workflow additions.
- See `.github/workflows/release.yml` for the new release workflow being introduced in this PR.
