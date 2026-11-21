# Contributing to db-stack

One monorepo, four workspace directories, three published packages:

| Directory     | Package                    | Published |
| ------------- | -------------------------- | --------- |
| `node/`       | `@agentix-e/db-node`       | yes       |
| `cluster/`    | `@agentix-e/db-cluster`    | yes       |
| `federation/` | `@agentix-e/db-federation` | yes       |
| `e2e/`        | `@agentix-e/db-stack-e2e`  | no        |

The split follows the deployment a consumer has — one node, one datacenter, several
datacenters — and `e2e/` holds the acceptance suites that drive all three as real
processes. Nothing below `node/` imports anything above it; see
[docs/architecture.md](docs/architecture.md) for the dependency rule and why it holds.

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix      | When to use                         |
| ----------- | ----------------------------------- |
| `feat:`     | A new feature                       |
| `fix:`      | A bug fix                           |
| `chore:`    | Maintenance, tooling, deps          |
| `docs:`     | Documentation only                  |
| `test:`     | Adding or fixing tests              |
| `refactor:` | Code change with no behavior change |
| `perf:`     | Performance improvement             |
| `style:`    | Formatting, linting (no logic)      |

Examples:

```
feat(auth): add OAuth2 token refresh
fix(core): resolve deadlock on concurrent writes
docs: update README with architecture diagram
```

## Creating a Changeset

Run the following command from the repository root:

```bash
pnpm changeset
```

This generates a markdown file in `.changeset/` describing your changes. Commit it
alongside your code. The three packages are versioned **independently**: a changeset
names the packages it touches, and a change to `cluster` does not release `node`.

## Development Setup

```bash
git clone git@github.com:AgentiX-E/db-stack.git
cd db-stack
corepack enable
pnpm install
pnpm build
pnpm test
```

`pnpm install` is not optional after a directory moves: pnpm's `node_modules` links are
relative and are rebuilt to the new depth only by a fresh install.

## Running the Gates

```bash
pnpm check:gates      # configs and scripts wired to real files
pnpm lint             # eslint, per package
pnpm format:check     # prettier over sources and docs
pnpm typecheck        # tsc --noEmit on the published surface, per package
pnpm typecheck:tests  # the same, for every test and benchmark
pnpm test             # unit + integration suites (turbo)
pnpm coverage         # v8 coverage per package
pnpm coverage:gate    # fails unless every dimension is ≥ 95 % in every package
pnpm e2e              # real multi-process clusters over mutual TLS
pnpm verify           # all of the above, in order
```

A gate that reports success without measuring is worse than no gate, so each one fails
when its input disappears — `check:gates` refuses a `vitest run` filter naming a
directory that does not exist, `check:script-coverage` refuses a script no test loads,
and `coverage:gate` refuses a package missing from the coverage report.

## Pull Request Guidelines

- Keep PRs focused on a single concern — split unrelated changes.
- Ensure `pnpm verify` passes before requesting review.
- Add a changeset for any user-facing change (fix, feat, perf).
- Use the commit convention in your PR title.
- Reference related issues when applicable.
- Never commit a credential. API keys travel through environment variables only, and
  `.env` is not tracked.
