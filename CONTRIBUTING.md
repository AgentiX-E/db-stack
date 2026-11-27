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

One environment variable belongs to the ruler rather than to the code: if
`NODE_COMPILE_CACHE` is set, scripts compiled from cached bytecode lose block ranges in
V8's coverage, and a range nobody reports cannot fail. From one tree, `check-doc-examples.mjs`
read 100.00 % lines with the variable set and 99.56 % with `457-458` uncovered without it.
`check:script-coverage` strips it from the run it starts; unset it yourself before reading
`pnpm coverage` numbers by hand, and never treat two figures taken with different settings
as a comparison.

## Before You Push

```bash
pnpm install-hooks    # once per clone: point git at .githooks/
pnpm preflight        # what the hook runs, and what to run if you have no hook
```

`pnpm install-hooks` sets `core.hooksPath` to the versioned `.githooks/` directory and
makes its hooks executable. Hooks live in the repository rather than in `.git/hooks` so
that the one git runs is the one review sees — a hook that exists on one machine only is
a hook nobody reviewed.

`pnpm preflight` is the fast end of `pnpm verify`: it compiles the sources and the
tests, lints, checks formatting, and runs the gates that read the tree. It stops at the
first failure, so the message you read is the cause rather than the cascade. It takes a
couple of minutes; `pnpm verify` takes tens and needs the e2e harness, which is why the
latter is CI's job rather than a push's.

> A passing preflight is not a green build. CI runs the suites, the coverage gate, the
> e2e harness, the mutation targets and the benchmark. What preflight buys is the
> absence of the failures that are cheapest to catch where they were introduced.

Pushes made through the GitHub Git Data API — the path used by automation in an
environment whose proxy allows only `api.github.com` — cannot run a client hook at all.
That used to be covered by a sentence here, and a sentence is not a gate: iteration 97
landed a `prefer-const` in a new harness file on exactly that path, with every gate that
had been _executed_ green, because `pnpm lint` was in the command and not in the run.

So every preflight run now leaves a receipt at `<git-dir>/preflight-receipt.json` —
which commit, which tree, whether the worktree was clean, and each step with its verdict
— and `check:push-receipt` refuses a push that cannot cite one:

```bash
pnpm preflight            # writes the receipt; commit first, or it records a dirty tree
pnpm check:push-receipt   # what push_commit.py runs before it creates a blob
```

The order is therefore **commit → preflight → push**. Run before the commit, the receipt
is taken on a dirty worktree, it records `clean: false`, and the gate refuses it by
name — because the bytes it judged are not the bytes being pushed. Run with `--only`,
the receipt lists the steps that actually ran and is refused for the ones that did not.
The receipt lives inside the git directory, so it cannot be committed and a committed
approval from another machine is not a thing this repository can contain.

One trap worth knowing before you add a case to `scripts/*.test.mjs`: do not produce a
failing answer by asking pnpm for a script it does not define. The child fails, and it
also fails `pnpm test:scripts` — the process reporting the error is pnpm, inside pnpm —
so a suite whose assertions are all green exits 1. The executors in those scripts take
an injected `execute`/`spawn` for exactly this: state the failure, run the real thing on
the passing side.

## Pull Request Guidelines

- Keep PRs focused on a single concern — split unrelated changes.
- Ensure `pnpm verify` passes before requesting review.
- Add a changeset for any user-facing change (fix, feat, perf).
- Use the commit convention in your PR title.
- Reference related issues when applicable.
- Never commit a credential. API keys travel through environment variables only, and
  `.env` is not tracked.
