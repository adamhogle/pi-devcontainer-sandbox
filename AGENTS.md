# Dev Container Sandbox — Agent Guide

This file is loaded by pi as a context file. For contributing guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick Reference

- **Project structure**: See [CONTRIBUTING.md#project-structure](CONTRIBUTING.md#project-structure)
- **Development workflow**: Red to Green to Refactor TDD. See [CONTRIBUTING.md#development-workflow-red--green--refactor](CONTRIBUTING.md#development-workflow-red--green--refactor)
- **Running tests**: `npm test` or `npx vitest tests/path/to/test.test.ts`
- **Code coverage**: `npm run test:coverage` — HTML report at `coverage/index.html`
- **Coding conventions**: Path translation inside operation factories, never in `index.ts`
- **Known bugs**: See [CONTRIBUTING.md#known-bugs--regression-tests](CONTRIBUTING.md#known-bugs--regression-tests)
- **Deploy**: `npm test && cp extensions/dev-container-sandbox/*.ts ~/.pi/agent/extensions/dev-container-sandbox/`

## Key Principles

1. **TDD first** — Write the failing test before touching implementation.
2. **Path mapping lives in operations** — `index.ts` never translates paths explicitly.
3. **localCwd as tool cwd** — Always use the host cwd, not the container cwd, for tool factories.
4. **No double translation** — Pass raw host paths to operation factories; they translate internally.
