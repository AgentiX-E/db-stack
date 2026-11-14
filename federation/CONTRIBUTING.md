# Contributing to @agentix-e/db-federation

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
feat: add cross-shard query support
fix: resolve connection pool leak on timeout
docs: update README with query syntax
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
cd db-federation
npm ci
npm run build
npm test
```
