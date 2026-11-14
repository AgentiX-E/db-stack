# Contributing to @agentix-e/db-cluster

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix    | When to use                           |
|-----------|---------------------------------------|
| `feat:`   | A new feature                         |
| `fix:`    | A bug fix                             |
| `chore:`  | Maintenance, tooling, deps            |
| `docs:`   | Documentation only                    |
| `test:`   | Adding or fixing tests                |
| `refactor:` | Code change with no behavior change |
| `perf:`   | Performance improvement               |
| `style:`  | Formatting, linting (no logic change) |

Examples:
```
feat: add Raft consensus leader election
fix: resolve WAL recovery on partial write
docs: update API reference for sharding
```

## Creating a Changeset

Run the following command and follow the prompts:

```bash
npx changeset
```

This generates a markdown file in `.changeset/` describing your changes. Commit it alongside your code.

## Running Tests

```bash
# Install dependencies
npm ci

# Build
npm run build

# Run all tests
npm test

# Run specific test suites
npx vitest run src/__tests__/unit/
npx vitest run src/__tests__/integration/
```

## Pull Request Guidelines

- Keep PRs focused on a single concern — split unrelated changes.
- Ensure all tests pass before requesting review.
- Add a changeset for any user-facing change (fix, feat, perf).
- Use the commit convention in your PR title.
- Reference related issues when applicable.

## Development Setup

```bash
git clone <repo-url>
cd db-cluster
npm ci
npm run build
npm test
```
