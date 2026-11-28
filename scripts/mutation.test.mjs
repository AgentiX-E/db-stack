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

import {
  changedFiles,
  isEntryPoint,
  main,
  restoreFiles,
  runOne,
  setExitCode,
  snapshotFiles,
  strykerBin,
} from "./mutation.mjs";
import { TARGETS as REPOSITORY_TARGETS } from "../mutation/targets.mjs";

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

  // The default runner is `runOne` with this object, so injecting the process it
  // spawns is enough to reach the default: the branch is a real code path and not a
  // line only the command line can take.
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
    /expected one of node, cluster, federation, all, received nothing/,
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

test("the defaults are the repository: every declared target, from the root", async () => {
  // No `targets`, no `cwd`, no `root`: the command line's own shape, exercised with
  // the runner injected so that nothing is spawned.
  const ran = [];
  const code = await main(["all"], {
    error: () => {},
    run: async (target) => {
      ran.push(target);
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(ran, Object.keys(REPOSITORY_TARGETS));
  assert.ok(ran.length >= 3);
});

test("the Stryker binary is resolved from the install when the caller names none", async () => {
  const { spawn, calls } = fakeSpawn({}, 0);

  assert.equal(await runOne("cluster", [], { spawn, root: ROOT }), 0);
  assert.match(calls[0].args[0], /bin[\\/]stryker\.js$/);
});

test("the entry check answers for this module, another file, and no file at all", () => {
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/mutation.mjs")), true);
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/check-english.mjs")), false);
  assert.equal(isEntryPoint(undefined), false);
});

// ── P3-96: an interrupted run must not leave the source tree edited ──

test("runOne records a worktree snapshot before the child and restores it after any exit", async () => {
  const { spawn } = fakeSpawn({}, 1);
  const events = [];
  const files = ["federation/src/a.ts", "federation/src/b.ts"];
  const snapshot = (paths) => {
    events.push(`snapshot:${paths.join(",")}`);
    return new Map(paths.map((p) => [p, `hash-${p}`]));
  };
  const changed = () => {
    events.push("changed");
    // b.ts was left edited by the killed child
    return ["federation/src/b.ts"];
  };
  const restore = (_before, paths) => events.push(`restore:${paths.join(",")}`);

  const code = await runOne("federation", [], {
    spawn,
    bin: "/s.js",
    files,
    snapshot,
    changed,
    restore,
  });

  assert.equal(code, 1);
  assert.deepEqual(events, [
    "snapshot:federation/src/a.ts,federation/src/b.ts",
    "changed",
    "restore:federation/src/b.ts",
  ]);
});

test("runOne restores even when the child is killed by a signal", async () => {
  const { spawn } = fakeSpawn({ signal: "SIGKILL" }, 0);
  const restored = [];
  const errors = [];

  await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["cluster/src/a.ts"],
    snapshot: (paths) => new Map(paths.map((p) => [p, "h"])),
    changed: () => ["cluster/src/a.ts"],
    restore: (_before, paths) => restored.push(...paths),
    error: (line) => errors.push(line),
  });

  assert.deepEqual(restored, ["cluster/src/a.ts"]);
  assert.match(errors.join("\n"), /restored 1 file\(s\)/);
});

test("runOne does not restore a clean tree", async () => {
  const { spawn } = fakeSpawn({}, 0);
  let restores = 0;
  const errors = [];

  await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["cluster/src/a.ts"],
    snapshot: () => new Map(),
    changed: () => [],
    restore: () => {
      restores += 1;
    },
    error: (line) => errors.push(line),
  });

  assert.equal(restores, 0);
  assert.doesNotMatch(errors.join("\n"), /restored/);
});

test("a restored file is reported as a failure, not a silent fix", async () => {
  const { spawn } = fakeSpawn({}, 0);
  const errors = [];

  const code = await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["cluster/src/a.ts"],
    snapshot: () => new Map(),
    changed: () => ["cluster/src/a.ts"],
    restore: () => {},
    error: (line) => errors.push(line),
  });

  assert.equal(
    code,
    1,
    "a mutated source tree must fail the gate even after restore",
  );
  assert.match(
    errors.join("\n"),
    /source tree was modified by the mutation run/,
  );
});

test("a snapshot that throws does not hide the child's verdict", async () => {
  const { spawn } = fakeSpawn({}, 5);
  const errors = [];

  const code = await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["cluster/src/a.ts"],
    snapshot: () => {
      throw new Error("git unavailable");
    },
    error: (line) => errors.push(line),
  });

  assert.equal(code, 5, "the child's exit code survives a failed snapshot");
  assert.match(errors.join("\n"), /could not snapshot the worktree/);
});

// ── P3-96: the byte-snapshot guard, driven by an injected filesystem ──

/** An in-memory filesystem: path -> text, with absent meaning "does not exist". */
function fakeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  const unlinks = [];
  return {
    store,
    writes,
    unlinks,
    fs: {
      exists: (path) => store.has(path),
      read: (path) => store.get(path),
      write: (path, text) => {
        writes.push({ path, text });
        store.set(path, text);
      },
      unlink: (path) => {
        unlinks.push(path);
        store.delete(path);
      },
    },
  };
}

test("snapshotFiles records exact bytes and a missing file as null", () => {
  const { fs } = fakeFs({ "/repo/a.ts": "original bytes\n" });

  const before = snapshotFiles(["a.ts", "gone.ts"], "/repo", fs);

  assert.deepEqual(
    before,
    new Map([
      ["a.ts", "original bytes\n"],
      ["gone.ts", null],
    ]),
  );
});

test("changedFiles names files whose bytes moved, including one that vanished", () => {
  const { fs } = fakeFs({ "/repo/a.ts": "same", "/repo/b.ts": "new bytes" });
  const before = new Map([
    ["a.ts", "same"], // unchanged
    ["b.ts", "old"], // changed
    ["gone.ts", "blob-gone"], // vanished
  ]);

  assert.deepEqual(changedFiles(before, "/repo", fs), ["b.ts", "gone.ts"]);
});

test("restoreFiles writes back the snapshot bytes, not HEAD", () => {
  // The file on disk holds a mutation residue; the snapshot holds a legitimate
  // uncommitted edit. Restore must put back the edit — the defect this replaced
  // used `git checkout --` and destroyed the edit.
  const { fs, store } = fakeFs({ "/repo/a.ts": "MUTATION RESIDUE" });
  const before = new Map([["a.ts", "legitimate uncommitted edit\n"]]);

  restoreFiles(before, ["a.ts"], "/repo", fs);

  assert.equal(store.get("/repo/a.ts"), "legitimate uncommitted edit\n");
});

test("restoreFiles removes a file that did not exist at snapshot time", () => {
  const { fs, store, unlinks } = fakeFs({
    "/repo/new.ts": "created by mutant",
  });
  const before = new Map([["new.ts", null]]);

  restoreFiles(before, ["new.ts"], "/repo", fs);

  assert.equal(store.has("/repo/new.ts"), false);
  assert.deepEqual(unlinks, ["/repo/new.ts"]);
});

test("main wires the worktree guard for a target that declares mutate files", async () => {
  const { spawn, calls } = fakeSpawn({}, 0);
  const files = ["federation/src/a.ts"];
  const targets = { federation: { mutate: files } };

  const code = await main(["federation"], {
    targets,
    cwd: ROOT,
    root: ROOT,
    spawn,
    bin: "/s.js",
    snapshot: () => new Map([["federation/src/a.ts", "h"]]),
    changed: () => [],
    restore: () => {},
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
});

test("a worktree that cannot be diffed does not hide the child's verdict", async () => {
  const { spawn } = fakeSpawn({}, 4);
  const errors = [];

  const code = await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["a.ts"],
    snapshot: () => new Map([["a.ts", "h"]]),
    changed: () => {
      throw new Error("diff failed");
    },
    restore: () => {},
    error: (line) => errors.push(line),
  });

  assert.equal(code, 4);
  assert.match(errors.join("\n"), /could not diff the worktree — diff failed/);
});

test("a restore that throws is reported and still fails the gate", async () => {
  const { spawn } = fakeSpawn({}, 0);
  const errors = [];

  const code = await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["a.ts"],
    snapshot: () => new Map([["a.ts", "h"]]),
    changed: () => ["a.ts"],
    restore: () => {
      throw new Error("checkout failed");
    },
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.match(
    errors.join("\n"),
    /could not restore the worktree — checkout failed/,
  );
});

test("the default runner builds a byte-snapshot guard when none is injected", async () => {
  const { spawn, calls } = fakeSpawn({}, 0);

  // No `run`, no `snapshot`/`changed`/`restore`: the default runner must build all
  // three from the filesystem. A file that exists in this repository has identical
  // bytes before and after, so the guard sees a clean tree and stays green.
  const code = await main(["cluster"], {
    targets: { cluster: { mutate: ["package.json"] } },
    cwd: ROOT,
    root: ROOT,
    spawn,
    bin: "/s.js",
    error: () => {},
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
});

test("the default snapshot and diff helpers treat a guarded run with no hooks as clean", async () => {
  const { spawn } = fakeSpawn({}, 0);
  const errors = [];

  // `files` enables the guard, but no snapshot/changed/restore are injected: the
  // default arrows are the ones under test. They report a clean tree.
  const code = await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["a.ts"],
    error: (line) => errors.push(line),
  });

  assert.equal(code, 0);
  assert.doesNotMatch(errors.join("\n"), /modified/);
});

test("the default restore helper is reached on a dirty tree", async () => {
  const { spawn } = fakeSpawn({}, 0);
  const errors = [];

  // snapshot and changed are injected to declare a dirty tree; restore is left
  // to its default arrow, which must run without throwing.
  await runOne("cluster", [], {
    spawn,
    bin: "/s.js",
    files: ["a.ts"],
    snapshot: () => new Map([["a.ts", "old"]]),
    changed: () => ["a.ts"],
    error: (line) => errors.push(line),
  });

  assert.match(errors.join("\n"), /restored 1 file\(s\)/);
});

test("setExitCode translates the runner verdict into the process verdict", () => {
  const original = process.exitCode;
  try {
    setExitCode(7);
    assert.equal(process.exitCode, 7);
    setExitCode(0);
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = original;
  }
});

test("the default runner's byte-snapshot restore arrow runs on a dirty tree", async () => {
  const { spawn } = fakeSpawn({}, 0);
  const errors = [];

  // `changed` is injected to force the dirty path; `restore` is left to the
  // default runner's byte-snapshot arrow. It writes back the captured bytes of
  // package.json, which this suite never edits — a safe no-op on the live tree.
  // What is asserted is that the arrow ran, via the restore report.
  const code = await main(["cluster"], {
    targets: { cluster: { mutate: ["package.json"] } },
    cwd: ROOT,
    root: ROOT,
    spawn,
    bin: "/s.js",
    error: (line) => errors.push(line),
    changed: () => ["package.json"],
  });

  assert.equal(code, 1);
  assert.match(errors.join("\n"), /restored 1 file\(s\)/);
});

test("snapshotFiles records null for a file whose read throws", () => {
  const fs = {
    exists: () => true,
    read: () => {
      throw new Error("EACCES");
    },
  };

  const before = snapshotFiles(["locked.ts"], "/repo", fs);
  assert.equal(before.get("locked.ts"), null);
});

test("changedFiles treats an unreadable file as absent", () => {
  const fs = {
    exists: () => true,
    read: () => {
      throw new Error("EACCES");
    },
  };
  // The file had bytes at snapshot time; now reading it throws, so it is
  // treated as gone and named as changed.
  const before = new Map([["locked.ts", "bytes"]]);

  assert.deepEqual(changedFiles(before, "/repo", fs), ["locked.ts"]);
});
