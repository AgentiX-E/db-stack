# Contributing to @agentix-e/db-operations

This is a monorepo with multiple packages under `packages/`. Each package is published as a separate npm package with the `@agentix-e/db-operations-*` naming convention.

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
feat(auth): add OAuth2 token refresh
fix(core): resolve deadlock on concurrent writes
docs: update README with architecture diagram
```

## Creating a Changeset

Run the following command from the repository root:

```bash
npx changeset
```

This generates a markdown file in `.changeset/` describing your changes. Commit it alongside your code. All packages share the same version number.

## Running Tests

```bash
# Install all dependencies
npm ci

# Build all packages
npm run build

# Run tests
npm test
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
cd db-operations
npm ci
npm run build
npm test
```
