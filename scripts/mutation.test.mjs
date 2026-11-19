/**
 * Tests for the mutation runner.
 *
 * The runner has one job it exists for — refusing to start Stryker from
 * anywhere but the repository root — and one behaviour worth pinning besides:
 * `all` stops at the first failing target instead of reporting three scores and
 * exiting with the last one.
 *
 * Stryker itself is never started here. `runOne` takes its `spawn`, so a case
 * can hand it an `EventEmitter` wearing the two events the runner listens for;
 * what is asserted is the environment the child would have received and the code
 * the runner settles on. A test that ran real mutation testing would take an
 * hour per case and prove the same thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, runOne, strykerBin } from "./mutation.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TARGETS = { cluster: {}, operations: {} };

/** A stand-in for the child process: it records how it was started, then settles. */
function fakeSpawn(outcome, settleWith = 0) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    // The runner attaches both listeners before anything fires; settling on the
    // next turn of the loop lets it.
    process.nextTick(() => {
      if (outcome.error) child.emit("error", outcome.error);
      else child.emit("close", settleWith, outcome.signal);
    });
    return child;
  };
  return { spawn, calls };
}

test("the Stryker entry point resolves to a file that exists", () => {
  const bin = strykerBin();

  assert.match(bin, /@stryker-mutator[/\\]core[/\\]bin[/\\]stryker\.js$/);
});

test("runOne starts Stryker on the target, with the mutation target in its environment", async () => {
  const { spawn, calls } = fakeSpawn({}, 0);

  const code = await runOne("operations", ["--mutate", "src/a.ts:1-2"], {
    spawn,
    bin: "/stryker.js",
    execPath: "/node",
    cwd: "/repo",
    env: { PATH: "/bin" },
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    "/stryker.js",
    "run",
    "--mutate",
    "src/a.ts:1-2",
  ]);
  assert.equal(calls[0].command, "/node");
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.env.MUTATION_TARGET, "operations");
  assert.equal(calls[0].options.env.PATH, "/bin");
  assert.equal(calls[0].options.stdio, "inherit");
});

test("a target that fails returns its own exit code", async () => {
  const { spawn } = fakeSpawn({}, 3);

  assert.equal(await runOne("cluster", [], { spawn, bin: "/s.js" }), 3);
});

test("a target killed by a signal is a failure, and says which signal", async () => {
  const { spawn } = fakeSpawn({ signal: "SIGKILL" }, 0);
  const errors = [];

  const code = await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.equal(errors[0], "mutation: cluster was killed by SIGKILL");
});

test("a Stryker that cannot start is a failure, not an exception", async () => {
  const { spawn } = fakeSpawn({ error: new Error("spawn ENOENT") });
  const errors = [];

  const code = await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.match(errors[0], /could not start the cluster run — spawn ENOENT/);
});

test("no target is a usage error that lists what the runner accepts", async () => {
  const errors = [];

  const code = await main([], {
    targets: TARGETS,
    cwd: ROOT,
    error: (line) => errors.push(line),
  });

  assert.equal(code, 2);
  assert.deepEqual(errors, [
    "mutation: expected one of cluster, operations, all, received nothing",
  ]);
});

test("an unknown target is a usage error that names what was received", async () => {
  const errors = [];

  const code = await main(["e2e"], {
    targets: TARGETS,
    cwd: ROOT,
    error: (line) => errors.push(line),
  });

  assert.equal(code, 2);
  assert.match(errors[0], /received e2e$/);
});

test("running from a package directory is refused, and the refusal explains why", async () => {
  const errors = [];
  const ran = [];

  const code = await main(["operations"], {
    targets: TARGETS,
    cwd: resolve(ROOT, "operations"),
    root: ROOT,
    error: (line) => errors.push(line),
    run: async (target) => ran.push(target),
  });

  assert.equal(code, 2);
  assert.deepEqual(ran, []);
  const message = errors.join("\n");
  assert.match(
    message,
    /run this from the repository root, not from .*operations/,
  );
  assert.match(
    message,
    /Stryker copies the working directory into its sandbox/,
  );
  assert.match(message, /pnpm run test:mutation:operations/);
});

test("all runs every target in order", async () => {
  const ran = [];
  const code = await main(["all"], {
    targets: TARGETS,
    cwd: ROOT,
    root: ROOT,
    run: async (target) => {
      ran.push(target);
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(ran, ["cluster", "operations"]);
});

test("all stops at the first failing target and returns its code", async () => {
  const ran = [];
  const code = await main(["all"], {
    targets: TARGETS,
    cwd: ROOT,
    root: ROOT,
    run: async (target) => {
      ran.push(target);
      return target === "cluster" ? 7 : 0;
    },
  });

  assert.equal(code, 7);
  assert.deepEqual(ran, ["cluster"]);
});

test("the --mutate hint names the target when only one is requested", async () => {
  const errors = [];
  await main(["operations"], {
    targets: TARGETS,
    cwd: resolve(ROOT, "operations"),
    root: ROOT,
    error: (line) => errors.push(line),
  });

  assert.match(errors.join("\n"), /pnpm run test:mutation:operations$/m);
});

test("the --mutate hint asks for a target when all was requested", async () => {
  const errors = [];
  await main(["all"], {
    targets: TARGETS,
    cwd: resolve(ROOT, "operations"),
    root: ROOT,
    error: (line) => errors.push(line),
  });

  assert.match(errors.join("\n"), /pnpm run test:mutation:<target>/);
});

test("a child that closes without a code and without a signal is a failure", async () => {
  // `close(undefined, undefined)` is what a process killed by an unhandled
  // error looks like; `code ?? 1` is the line that keeps it a failure.
  const spawn = () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", undefined, undefined));
    return child;
  };

  assert.equal(await runOne("cluster", [], { spawn, bin: "/s.js" }), 1);
});

test("main runs its own runner when none is injected", async () => {
  const { spawn, calls } = fakeSpawn({}, 0);

  const code = await main(["operations", "--mutate", "src/a.ts"], {
    targets: TARGETS,
    cwd: ROOT,
    root: ROOT,
    spawn,
    bin: "/s.js",
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["/s.js", "run", "--mutate", "src/a.ts"]);
});

test("the command line refuses to start without a target, and starts nothing", () => {
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/mutation.mjs")],
    {
      encoding: "utf8",
      cwd: ROOT,
    },
  );

  assert.equal(child.status, 2);
  assert.match(
    child.stderr,
    /expected one of cluster, federation, operations, all, received nothing/,
  );
});

test("the default runner really starts a process and reads its exit code", async () => {
  // No injected `spawn` here: this is the path a person runs. The "Stryker" is a
  // three-line script that exits 3, so the case costs one process and asserts the
  // one thing a fake cannot — that the runner's own spawn wiring works.
  const dir = mkdtempSync(join(tmpdir(), "mutation-"));
  try {
    const bin = join(dir, "stryker.js");
    writeFileSync(bin, "process.exit(3);\n");

    assert.equal(await runOne("cluster", [], { bin, cwd: ROOT, env: {} }), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
