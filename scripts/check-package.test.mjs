/**
 * Tests for the packaged-artefact gate.
 *
 * This gate was the one script no test loaded, and the reason was circular:
 * importing the module ran the check, the check needed a build, and the Quality
 * job deliberately does not build. So the rule that has the most to say about a
 * consumer's experience — "a package ships the documentation it gates" — had
 * never been seen to fail, which is the same as not knowing whether it works.
 *
 * Every case here builds a throwaway package and runs the gate the way the
 * command line does, including the child process: an import is only worth
 * checking by importing it, and the probe exists because a compiler cannot see
 * the difference between a module that loads and one that works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkPublishedDocs,
  isEntryPoint,
  labelOf,
  probeModule,
  resolveTarget,
  run,
  summarise,
} from "./check-package.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** A throwaway directory built from `{ relative path: contents }`. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "package-check-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function withFixture(files, body) {
  const dir = fixture(files);
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A package that publishes `dist/index.js` with the named exports.
 *
 * `src/index.ts` and the workspace file are part of it on purpose: the docs rule
 * walks the workspace, so a fixture without them would be a package the gate
 * never looked at — a green assertion about nothing.
 */
function packageFiles({
  name = "cluster",
  type = "module",
  exports,
  files,
} = {}) {
  return {
    "pnpm-workspace.yaml": `packages:\n  - ${name}\n`,
    [`${name}/src/index.ts`]: "export const RaftAdapter = 1;\n",
    [`${name}/package.json`]: JSON.stringify({
      name: `@fixture/${name}`,
      version: "1.0.0",
      ...(type ? { type } : {}),
      ...(files ? { files } : {}),
      exports: exports ?? {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
    }),
    [`${name}/dist/index.js`]: "export const RaftAdapter = 1;\n",
  };
}

const ONE_TARGET = [{ dir: "cluster", entry: ".", expect: ["RaftAdapter"] }];

test("names an entry the way a reader would", () => {
  assert.equal(labelOf({ dir: "cluster", entry: "." }), "cluster");
  assert.equal(
    labelOf({ dir: "cluster", entry: "./testing" }),
    "cluster/testing",
  );
});

test("a target with no manifest is a finding, not a crash", () => {
  withFixture({}, (dir) => {
    const resolved = resolveTarget(ONE_TARGET[0], dir);
    assert.equal(resolved.problem, "package.json missing");
    assert.equal(resolved.entryFile, undefined);
  });
});

test("a target the manifest does not publish is a finding", () => {
  withFixture(
    packageFiles({ exports: { ".": { import: "./dist/index.js" } } }),
    (dir) => {
      assert.equal(
        resolveTarget({ dir: "cluster", entry: "./testing" }, dir).problem,
        'no "exports" entry for "./testing"',
      );
    },
  );
});

test("a declared entry that was never emitted is a finding", () => {
  withFixture(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { import: "./dist/index.js" } },
      }),
    },
    (dir) => {
      assert.equal(
        resolveTarget(ONE_TARGET[0], dir).problem,
        "declared entry not emitted (./dist/index.js)",
      );
    },
  );
});

test("a shorthand export target is a string, and resolves", () => {
  withFixture(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": "./dist/index.js" },
      }),
      "cluster/dist/index.js": "export const RaftAdapter = 1;\n",
    },
    (dir) => {
      const resolved = resolveTarget(ONE_TARGET[0], dir);
      assert.equal(resolved.problem, undefined);
      assert.equal(
        resolved.entryFile,
        join(dir, "cluster", "dist", "index.js"),
      );
    },
  );
});

test("a conditional export with no import condition falls back to default", () => {
  withFixture(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { default: "./dist/index.js" } },
      }),
      "cluster/dist/index.js": "export const RaftAdapter = 1;\n",
    },
    (dir) => {
      assert.equal(
        resolveTarget(ONE_TARGET[0], dir).entryFile,
        join(dir, "cluster", "dist", "index.js"),
      );
    },
  );
});

test("the probe is a module that imports the declared file and lists what is missing", () => {
  const source = probeModule(ONE_TARGET[0], "/tmp/pkg/dist/index.js");
  assert.match(source, /const url = "file:\/\/\/tmp\/pkg\/dist\/index\.js";/);
  assert.match(source, /await import\(url\)/);
  assert.match(source, /const expected = \["RaftAdapter"\];/);
  assert.match(source, /const probeSource = null;/);
  assert.match(source, /missing exports: /);
});

test("a target with a behaviour probe carries it as source", () => {
  const source = probeModule(
    {
      ...ONE_TARGET[0],
      behaviour: async ({ loaded, assert }) =>
        assert.equal(loaded.RaftAdapter, 1),
    },
    "/tmp/pkg/dist/index.js",
  );
  assert.match(source, /behaviour verified/);
  assert.match(source, /new Function\('return \(' \+ probeSource \+ '\)'\)/);
  assert.doesNotMatch(source, /const probeSource = null;/);
});

test("a failing child is summarised from its stderr, not its stdout", () => {
  assert.equal(
    summarise({
      status: 1,
      stdout: "noise\n",
      stderr:
        "\n  AssertionError: the probe message\n  at somewhere\n  at elsewhere\n  at more\n  at the end\n",
    }),
    "AssertionError: the probe message | at somewhere | at elsewhere | at more",
  );
});

test("a child that failed with no stderr is summarised from stdout", () => {
  assert.equal(summarise({ status: 1, stdout: "boom\n", stderr: "" }), "boom");
});

test("run loads a published entry point the way a consumer would", () => {
  withFixture(packageFiles(), (dir) => {
    const lines = [];
    const code = run(dir, {
      log: (line) => lines.push(line),
      error: () => {},
      targets: ONE_TARGET,
    });

    assert.equal(code, 0);
    assert.equal(lines[0], "✓ cluster ok (1 exports)");
    assert.match(lines[1], /Package check passed/);
  });
});

test("run reports an export the artefact does not publish", () => {
  withFixture(packageFiles(), (dir) => {
    const errors = [];
    const code = run(dir, {
      log: () => {},
      error: (line) => errors.push(line),
      targets: [
        {
          dir: "cluster",
          entry: ".",
          expect: ["RaftAdapter", "SqliteStorage"],
        },
      ],
    });

    assert.equal(code, 1);
    assert.match(errors[0], /^✗ cluster: missing exports: SqliteStorage/);
    assert.match(errors[1], /Package check FAILED \(1 finding\(s\)\)/);
  });
});

test("run verifies behaviour in the child process", () => {
  withFixture(packageFiles(), (dir) => {
    const lines = [];
    const code = run(dir, {
      log: (line) => lines.push(line),
      error: () => {},
      targets: [
        {
          ...ONE_TARGET[0],
          behaviour: async ({ loaded, assert }) => {
            assert.equal(loaded.RaftAdapter, 1, "the artefact must export one");
          },
        },
      ],
    });

    assert.equal(code, 0);
    assert.equal(lines[0], "✓ cluster ok (1 exports, behaviour verified)");
  });
});

test("run keeps the assertion message of a probe that fails", () => {
  withFixture(packageFiles(), (dir) => {
    const errors = [];
    const code = run(dir, {
      log: () => {},
      error: (line) => errors.push(line),
      targets: [
        {
          ...ONE_TARGET[0],
          behaviour: async ({ loaded, assert }) => {
            assert.equal(loaded.RaftAdapter, 2, "double the leaf set");
          },
        },
      ],
    });

    assert.equal(code, 1);
    assert.match(errors[0], /^✗ cluster: AssertionError/);
    assert.match(errors[0], /double the leaf set/);
  });
});

test("run counts a missing manifest and a missing entry as findings", () => {
  withFixture(packageFiles(), (dir) => {
    const errors = [];
    const code = run(dir, {
      log: () => {},
      error: (line) => errors.push(line),
      targets: [
        { dir: "cluster", entry: "./absent", expect: [] },
        { dir: "absent", entry: ".", expect: [] },
      ],
    });

    assert.equal(code, 1);
    assert.deepEqual(errors.slice(0, 2), [
      '✗ cluster/absent: no "exports" entry for "./absent"',
      "✗ absent: package.json missing",
    ]);
    assert.match(errors[2], /Package check FAILED \(2 finding\(s\)\)/);
  });
});

test("run takes the child process as a parameter", () => {
  withFixture(packageFiles(), (dir) => {
    const spawns = [];
    const lines = [];
    const code = run(dir, {
      log: (line) => lines.push(line),
      error: () => {},
      targets: ONE_TARGET,
      spawn: (command, args, options) => {
        spawns.push({ command, args, options });
        return { status: 0, stdout: "ok (9 exports)\n", stderr: "" };
      },
    });

    assert.equal(code, 0);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, process.execPath);
    assert.equal(spawns[0].args[0], "--input-type=module");
    assert.equal(spawns[0].options.cwd, join(dir, "cluster"));
    assert.equal(lines[0], "✓ cluster ok (9 exports)");
  });
});

test("run with nothing injected still reports a verdict", () => {
  // The defaults are the path every invocation takes, so they are exercised
  // rather than trusted: an empty root makes every real target a finding, which
  // is the cheapest way to reach the default sinks without a build.
  withFixture({}, (dir) => {
    const written = [];
    const original = { log: console.log, error: console.error };
    console.log = (line) => written.push(line);
    console.error = (line) => written.push(line);
    try {
      assert.equal(run(dir), 1);
    } finally {
      console.log = original.log;
      console.error = original.error;
    }
    assert.ok(
      written.some((line) => line === "✗ cluster: package.json missing"),
      "the default error sink received the findings",
    );
  });
});

test("a package that ships its docs in the tarball passes", () => {
  withFixture(
    {
      ...packageFiles({ files: ["dist", "docs"] }),
      "cluster/docs/guide.md": "# Guide\n",
    },
    (dir) => {
      const errors = [];
      // The real `npm pack`: `files` can name a directory a `.npmignore` then
      // empties, and only the tarball knows what a consumer receives.
      const missing = checkPublishedDocs(dir, {
        error: (line) => errors.push(line),
      });
      assert.equal(missing, 0);
      assert.deepEqual(errors, []);
    },
  );
});

test("a package whose docs are missing from the tarball is a finding", () => {
  withFixture(
    {
      ...packageFiles({ files: ["dist"] }),
      "cluster/docs/guide.md": "# Guide\n",
    },
    (dir) => {
      // Nothing injected: the default sink and the real `npm pack`. `files` names
      // `dist` only, so the docs tree is in the repository and not in the tarball
      // — the defect this rule was written for, and the one it had never been seen
      // to catch.
      const written = [];
      const original = console.error;
      console.error = (line) => written.push(line);
      let missing;
      try {
        missing = checkPublishedDocs(dir);
      } finally {
        console.error = original;
      }
      assert.equal(missing, 1);
      assert.deepEqual(written, [
        "✗ cluster: docs/ exists in the repository but not in the tarball",
      ]);
    },
  );
});

test("a package with no docs tree is not asked to ship one", () => {
  withFixture(packageFiles(), (dir) => {
    const errors = [];
    const missing = checkPublishedDocs(dir, {
      error: (line) => errors.push(line),
      pack: () => assert.fail("a package with no docs/ must not be packed"),
    });
    assert.equal(missing, 0);
    assert.deepEqual(errors, []);
  });
});

test("a pack that fails is a finding", () => {
  withFixture(
    { ...packageFiles(), "cluster/docs/guide.md": "# Guide\n" },
    (dir) => {
      const errors = [];
      const missing = checkPublishedDocs(dir, {
        error: (line) => errors.push(line),
        pack: () => ({ status: 1, stdout: "", stderr: "npm ERR!" }),
      });
      assert.equal(missing, 1);
      assert.deepEqual(errors, ["✗ cluster: npm pack failed"]);
    },
  );
});

test("a pack manifest that cannot be read is a finding", () => {
  withFixture(
    { ...packageFiles(), "cluster/docs/guide.md": "# Guide\n" },
    (dir) => {
      const errors = [];
      const missing = checkPublishedDocs(dir, {
        error: (line) => errors.push(line),
        pack: () => ({ status: 0, stdout: "not json", stderr: "" }),
      });
      assert.equal(missing, 1);
      assert.deepEqual(errors, ["✗ cluster: could not read the pack manifest"]);
    },
  );
});

test("the documentation a package publishes is counted, not merely present", () => {
  withFixture(
    { ...packageFiles(), "cluster/docs/guide.md": "# Guide\n" },
    (dir) => {
      const missing = checkPublishedDocs(dir, {
        error: () => {},
        pack: () => ({
          status: 0,
          stdout: JSON.stringify([
            { files: [{ path: "dist/index.js" }, { path: "docs/guide.md" }] },
          ]),
        }),
      });
      assert.equal(missing, 0);
    },
  );
});

test("isEntryPoint answers the runtime's question", () => {
  assert.equal(
    isEntryPoint(resolve(ROOT, "scripts/check-package.mjs")),
    true,
    "the module recognises its own path",
  );
  assert.equal(isEntryPoint("/tmp/somewhere-else.mjs"), false);
  assert.equal(isEntryPoint(undefined), false);
});
