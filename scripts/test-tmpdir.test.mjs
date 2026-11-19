/**
 * Tests for the test-temp router.
 *
 * This module decides where ninety seconds of fsync-bound test writes land, and
 * every branch of that decision is a machine this suite will run on: a container
 * with a big `/dev/shm`, one with a small one, one where `statfs` is
 * unsupported, and one where a developer set an override to an empty string and
 * expected it to be ignored.
 *
 * The filesystem is injected rather than simulated by a library: each case hands
 * in the three calls the module makes and reads back what it asked for. Nothing
 * is stubbed at the module level, so the module under test is the one that ships.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIN_SHM_BYTES,
  ensureTestTmpRoot,
  resolveSharedTempDir,
  resolveTestTmpRoot,
  useTestTmpRoot,
  workerSuffix,
} from "./test-tmpdir.mjs";

/** A filesystem that records what was asked of it and answers from a fixed story. */
function fakeFs({ present = [], freeBytes = 0, statfsFails = false } = {}) {
  const calls = [];
  return {
    calls,
    fs: {
      existsSync: (path) => present.includes(path),
      statfsSync: (path) => {
        calls.push(["statfsSync", path]);
        if (statfsFails) throw new Error("ENOSYS: statfs");
        return { bavail: freeBytes / 4096, bsize: 4096 };
      },
      mkdirSync: (path, options) => calls.push(["mkdirSync", path, options]),
    },
  };
}

test("workerSuffix isolates each worker, and falls back to w0", () => {
  assert.equal(workerSuffix({}), "-w0");
  assert.equal(workerSuffix({ VITEST_WORKER_ID: "" }), "-w0");
  assert.equal(workerSuffix({ VITEST_WORKER_ID: "3" }), "-w3");
  assert.equal(workerSuffix({ VITEST_POOL_ID: "7" }), "-w7");
  // A worker id wins over a pool id: two workers in one pool still need
  // separate roots, which is the whole reason the suffix exists.
  assert.equal(
    workerSuffix({ VITEST_WORKER_ID: "1", VITEST_POOL_ID: "9" }),
    "-w1",
  );
});

test("an explicit override wins over everything and is created", () => {
  const { fs, calls } = fakeFs({
    present: ["/dev/shm"],
    freeBytes: 64 * 1024 ** 3,
  });

  const root = resolveTestTmpRoot("backup", {
    fs,
    env: { DBSTACK_TEST_TMPDIR: "/scratch" },
    shm: "/dev/shm",
  });

  assert.equal(root, "/scratch");
  assert.deepEqual(calls, [["mkdirSync", "/scratch", { recursive: true }]]);
});

test("an empty override is not an override", () => {
  const { fs } = fakeFs({ present: ["/dev/shm"], freeBytes: 64 * 1024 ** 3 });

  const root = resolveTestTmpRoot("backup", {
    fs,
    env: { DBSTACK_TEST_TMPDIR: "" },
    shm: "/dev/shm",
  });

  assert.equal(root, "/dev/shm/db-stack-tests/backup-w0");
});

test("a /dev/shm with room is preferred, per worker", () => {
  const { fs } = fakeFs({ present: ["/dev/shm"], freeBytes: 64 * 1024 ** 3 });

  const root = resolveTestTmpRoot("raft", {
    fs,
    env: { VITEST_WORKER_ID: "2" },
    shm: "/dev/shm",
    cwd: "/repo",
  });

  assert.equal(root, "/dev/shm/db-stack-tests/raft-w2");
});

test("a /dev/shm without room is skipped for the workspace directory", () => {
  const { fs } = fakeFs({ present: ["/dev/shm"], freeBytes: MIN_SHM_BYTES });

  const root = resolveTestTmpRoot("raft", {
    fs,
    env: {},
    shm: "/dev/shm",
    cwd: "/repo",
  });

  assert.equal(root, "/repo/.tmp/raft-w0");
});

test("a statfs that throws is a reason to move on, not to crash", () => {
  const { fs } = fakeFs({ present: ["/dev/shm"], statfsFails: true });

  const root = resolveTestTmpRoot("raft", {
    fs,
    env: {},
    shm: "/dev/shm",
    cwd: "/repo",
  });

  assert.equal(root, "/repo/.tmp/raft-w0");
});

test("a machine without /dev/shm uses the workspace directory", () => {
  const { fs, calls } = fakeFs({ present: [] });

  const root = resolveTestTmpRoot("raft", {
    fs,
    env: {},
    shm: "/dev/shm",
    cwd: "/repo",
  });

  assert.equal(root, "/repo/.tmp/raft-w0");
  assert.deepEqual(calls, [
    ["mkdirSync", "/repo/.tmp/raft-w0", { recursive: true }],
  ]);
});

test("the shared directory is never per worker, so port leases are visible to all of them", () => {
  const { fs } = fakeFs({ present: ["/dev/shm"] });

  assert.equal(
    resolveSharedTempDir("ports", {
      fs,
      env: { VITEST_WORKER_ID: "4" },
      shm: "/dev/shm",
      cwd: "/repo",
    }),
    "/dev/shm/db-stack-tests/ports",
  );
});

test("the shared directory falls back to the workspace too", () => {
  const { fs } = fakeFs({ present: [] });

  assert.equal(
    resolveSharedTempDir("ports", { fs, shm: "/dev/shm", cwd: "/repo" }),
    "/repo/.tmp/ports",
  );
});

test("useTestTmpRoot points all three temp variables at the root", () => {
  const env = {};
  const { fs } = fakeFs({ present: [] });

  const root = useTestTmpRoot("suite", {
    fs,
    env,
    shm: "/dev/shm",
    cwd: "/repo",
  });

  assert.equal(root, "/repo/.tmp/suite-w0");
  assert.equal(env.TMPDIR, root);
  assert.equal(env.TMP, root);
  assert.equal(env.TEMP, root);
});

test("ensureTestTmpRoot refuses to run before a root was chosen", () => {
  assert.throws(
    () => ensureTestTmpRoot({ env: {} }),
    /ensureTestTmpRoot: TMPDIR is unset — call useTestTmpRoot\(label\) first/,
  );
  assert.throws(
    () => ensureTestTmpRoot({ env: { TMPDIR: "" } }),
    /TMPDIR is unset/,
  );
});

test("ensureTestTmpRoot re-creates a root that was removed and leaves one that exists alone", () => {
  const { fs, calls } = fakeFs({ present: [] });
  assert.equal(ensureTestTmpRoot({ fs, env: { TMPDIR: "/gone" } }), "/gone");
  assert.deepEqual(calls, [["mkdirSync", "/gone", { recursive: true }]]);

  const existing = fakeFs({ present: ["/here"] });
  assert.equal(
    ensureTestTmpRoot({ fs: existing.fs, env: { TMPDIR: "/here" } }),
    "/here",
  );
  assert.deepEqual(existing.calls, []);
});

test("against the real filesystem, the root exists and is usable", () => {
  // The fake proves the decision; this proves the module still works when the
  // calls are Node's. `os.tmpdir()` is not consulted, so the assertion is about
  // the directory the suite will actually write into.
  const dir = mkdtempSync(join(tmpdir(), "tmpdir-root-"));
  try {
    const root = useTestTmpRoot("real", {
      env: { DBSTACK_TEST_TMPDIR: dir },
      cwd: dir,
    });
    assert.equal(root, dir);

    const nested = resolveTestTmpRoot("nested", { env: {}, cwd: dir });
    assert.equal(existsSync(nested), true);
    mkdirSync(join(nested, "file"), { recursive: true });
    assert.equal(statSync(join(nested, "file")).isDirectory(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with nothing injected, every step uses the real filesystem and the real environment", () => {
  // The defaults (`deps.fs ?? fs`, `deps.shm ?? "/dev/shm"`, ...) are the half a
  // suite actually runs. Exercising them costs one directory and proves the
  // wiring, which is the part a fake cannot.
  const saved = {
    TMPDIR: process.env.TMPDIR,
    DBSTACK_TEST_TMPDIR: process.env.DBSTACK_TEST_TMPDIR,
  };
  delete process.env.DBSTACK_TEST_TMPDIR;
  const created = [];
  try {
    const root = resolveTestTmpRoot("defaults");
    created.push(root);
    assert.equal(existsSync(root), true);

    const shared = resolveSharedTempDir("defaults-ports");
    created.push(shared);
    assert.equal(existsSync(shared), true);

    const used = useTestTmpRoot("defaults-suite");
    created.push(used);
    assert.equal(process.env.TMPDIR, used);

    assert.equal(ensureTestTmpRoot(), used);
  } finally {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
