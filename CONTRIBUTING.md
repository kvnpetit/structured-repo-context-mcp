# Contributing to SRC (Structured Repo Context)

Thank you for your interest in contributing to SRC! This guide will help you get started.

**Related documentation:**
- 📖 [README](./README.md) — Project overview and quick start
- 🛠️ [Development Guide](./GUIDE.md) — Architecture, commands, and technical details
- 📋 [Changelog](./CHANGELOG.md) — Version history
- 📄 [LICENSE](./LICENSE) — MIT License
- 🤝 [Code of Conduct](./CODE_OF_CONDUCT.md) — Community guidelines

---

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22.0.0
- [bun](https://bun.sh/) (recommended) or [npm](https://www.npmjs.com/)
- [Git](https://git-scm.com/)

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:

```bash
git clone https://github.com/YOUR_USERNAME/structured-repo-context-mcp.git
cd structured-repo-context-mcp
```

3. Add upstream remote:

```bash
git remote add upstream https://github.com/kvnpetit/structured-repo-context-mcp.git
```

### Install Dependencies

```bash
bun install
# or: npm install
```

### Verify Setup

```bash
bun run check
# or: npm run check
```

All checks should pass without errors.

---

## Development Workflow

### Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

Branch naming:
- `feature/` — New features
- `fix/` — Bug fixes
- `docs/` — Documentation changes
- `refactor/` — Code refactoring
- `test/` — Test improvements

### Development

See [GUIDE.md](./GUIDE.md) for:
- Available commands
- Project architecture and data flow
- Creating new features (with full code examples)
- Testing strategy and examples
- Naming conventions and path aliases

---

## Testing

- **Coverage threshold:** 80% minimum (lines, functions, branches, statements)
- **Test location:** Colocated with source (`index.test.ts` next to `index.ts`)
- **Run tests:** `bun run test` (or: `npm test`)
- **With coverage:** `bun run test:coverage` (or: `npm run test:coverage`)

> **IMPORTANT:** Always use `bun run test`, NOT `bun test`. The command `bun test` uses Bun's native test runner which doesn't support `vi.doMock()` and other Vitest features. This project uses Vitest as the test runner.

See [GUIDE.md - Testing Strategy](./GUIDE.md#testing-strategy) for detailed examples.

---

## Reporting Issues

### Bug Reports

Use the [Bug Report template](https://github.com/kvnpetit/structured-repo-context-mcp/issues/new?template=bug_report.md) and include:

- Clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node.js version, package version)
- Error logs if applicable

### Feature Requests

Use the [Feature Request template](https://github.com/kvnpetit/structured-repo-context-mcp/issues/new?template=feature_request.md) and include:

- Problem statement
- Proposed solution
- Use cases with examples

---

## Submitting Changes

### Before Submitting

1. ✅ All tests pass: `bun run test` (or: `npm test`)
2. ✅ Code checks pass: `bun run check` (or: `npm run check`)
3. ✅ Coverage thresholds met: `bun run test:coverage` (or: `npm run test:coverage`)
4. ✅ Documentation updated (if applicable)
5. ✅ Commit messages follow conventions

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>: <short description>
```

**Types:** `feat`, `fix`, `perf`, `docs`, `style`, `refactor`, `test`, `chore`

**Examples:**

```bash
feat: add code search feature
fix(cli): resolve argument parsing error
docs: update installation guide
```

> See [GUIDE.md - Changelog](./GUIDE.md#changelog) for which types appear in the changelog.

### Creating a Pull Request

1. **Push your branch:**
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create PR on GitHub:**
   - Go to your fork on GitHub
   - Click "Compare & pull request"
   - Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

3. **PR Title:** Use conventional commit format
   ```
   feat: Add semantic code search
   fix: Resolve memory leak in indexer
   ```

4. **PR Description:**
   - Describe what changed and why
   - Reference any related issues (`Closes #123`)
   - List breaking changes (if any)
   - Include screenshots for UI changes

### PR Review Process

- ✅ All CI checks must pass
- ✅ At least one maintainer review required
- ✅ All review comments addressed
- ✅ No merge conflicts
- ✅ Branch is up to date with main

---

## Need Help?

- 📖 Read the [Development Guide](./GUIDE.md)
- 💬 Open an [issue](https://github.com/kvnpetit/structured-repo-context-mcp/issues)
- 🔍 Search [existing issues](https://github.com/kvnpetit/structured-repo-context-mcp/issues?q=is%3Aissue)

---

## Recognition

Contributors will be recognized in:
- GitHub contributors list
- Release notes (for significant contributions)
- Changelog (commit authors are linked)

Thank you for contributing to SRC! 🎉
