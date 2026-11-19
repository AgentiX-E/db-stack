/**
 * Tests for the structural gate.
 *
 * Every rule in `check-gates` was previously asserted the same way: point the gate at
 * this repository, read the output, and believe it. That proves the rules hold *here*
 * and says nothing about what they would do to a tree that was wrong — which is the
 * only thing a gate is for.
 *
 * So the gate is a function of the tree it reads, and these cases build trees: one that
 * is clean, and then one per rule, each wrong in exactly one way. A case that expects a
 * failure asserts the sentence it fails with, because a gate whose message does not name
 * the file it is about is a gate that sends its reader looking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { audit, isEntryPoint, report, run } from "./check-gates.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * A workspace that satisfies every rule, in miniature.
 *
 * One package, one turbo task per script, one workflow step per script, one mutation
 * target that names its own package and a test config that declares what it covers and
 * how long it may take. Every mutation below removes or corrupts exactly one of these.
 */
const FILES = {
  "package.json": JSON.stringify({
    name: "fixture",
    scripts: {
      build: "tsc -p tsconfig.json",
      "test:mutation:one": "node scripts/mutation.mjs one",
    },
  }),
  "tsconfig.json": "{}\n",
  "pnpm-workspace.yaml": "packages:\n  - one\n",
  "turbo.json": JSON.stringify({ tasks: { build: {}, test: {} } }),
  ".gitignore": "reports/mutation/\n.stryker-tmp/\n",
  "stryker.config.mjs":
    "export const IN_PLACE_FLAG = '--inPlace';\n" +
    "export default () => {\n  throw new Error('a target is required');\n};\n",
  "mutation/targets.mjs":
    "export const TARGETS = {\n" +
    "  one: {\n" +
    "    mutate: ['one/src/**/*.ts'],\n" +
    "    testConfig: 'one/vitest.config.ts',\n" +
    "    thresholds: { break: 70 },\n" +
    "  },\n" +
    "};\n" +
    "export const SHARED = { timeoutMS: 30000 };\n",
  "scripts/mutation.mjs":
    "// the runner, present so the gate finds it\nexport const run = () => {};\n",
  ".github/workflows/ci.yml":
    "jobs:\n  build:\n    steps:\n" +
    "      - run: pnpm run build\n" +
    "      - run: pnpm -w run test:mutation:one\n",
  "one/package.json": JSON.stringify({
    name: "@scope/one",
    scripts: {
      build: "tsc -p tsconfig.json",
      test: "vitest run",
      "test:mutation": "pnpm -w run test:mutation:one",
    },
  }),
  "one/tsconfig.json": "{}\n",
  "one/vitest.config.ts":
    "export default {\n  test: {\n" +
    "    include: ['src/**/*.test.ts'],\n" +
    "    testTimeout: 10000,\n    hookTimeout: 10000,\n" +
    "  },\n};\n",
  "one/src/one.ts": "export const one = 1;\n",
  "one/src/__tests__/one.test.ts": "export const covered = true;\n",
};

/** Write `files` into a fresh directory and hand it to `body`, then remove it. */
async function withTree(files, body) {
  const dir = mkdtempSync(join(tmpdir(), "check-gates-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The clean tree, with one edit applied. */
const auditWith = (edit) =>
  withTree(FILES, async (dir) => {
    if (edit) await edit(dir);
    return audit(dir);
  });

const write = (dir, path, content) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};

const readOf = (path) => JSON.parse(FILES[path]);

test("a clean tree has nothing to report", async () => {
  const { failures, notes, packages, turboTasks } = await auditWith();

  assert.deepEqual(failures, []);
  assert.equal(packages.length, 1);
  assert.equal(packages[0].name, "@scope/one");
  assert.equal(turboTasks.size, 2);
  assert.deepEqual(notes, [], "notes are only collected in verbose mode");
});

test("a clean tree reports its notes in verbose mode, and only then", async () => {
  const quiet = await auditWith();
  assert.deepEqual(quiet.notes, []);

  const loud = await withTree(FILES, (dir) => audit(dir, { verbose: true }));
  assert.ok(loud.notes.some((note) => note.includes("tsconfig.json is wired")));
  assert.ok(
    loud.notes.some((note) => note.includes("is invoked by a workflow")),
  );
  assert.ok(loud.notes.some((note) => note.includes("file(s) for one/src")));
});

test("a workspace with no packages is a finding, not an empty pass", async () => {
  const { failures, packages } = await auditWith((dir) =>
    rmSync(join(dir, "one"), { recursive: true, force: true }),
  );

  assert.deepEqual(packages, []);
  assert.equal(failures[0], "workspace discovery found no packages");
  // Everything that depended on the package goes with it. The point of the case is that
  // an empty workspace is *said* rather than passed, not that it is said quietly.
  assert.ok(failures.length > 1);
});

test("a tsconfig nothing references is an orphan", async () => {
  const { failures } = await auditWith((dir) =>
    write(dir, "one/tsconfig.extra.json", "{}\n"),
  );

  assert.deepEqual(failures, [
    "@scope/one: tsconfig.extra.json exists but no script references it — an orphan configuration is not a gate",
  ]);
});

test("a tsconfig extended by another config is wired, because it is imported rather than executed", async () => {
  const { failures } = await auditWith((dir) => {
    write(dir, "one/tsconfig.base.json", "{}\n");
    write(
      dir,
      "one/tsconfig.json",
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );
  });

  assert.deepEqual(failures, []);
});

test("a config that does not parse is left to tsc rather than reported twice", async () => {
  const { failures } = await auditWith((dir) => {
    write(dir, "one/tsconfig.base.json", "{ not json");
    write(
      dir,
      "one/tsconfig.json",
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );
  });

  // The broken file is still cited by the working config, so rule 1 is satisfied;
  // parsing it is tsc's job and the gate stays out of the way.
  assert.deepEqual(failures, []);
});

test("a script that names a file which does not exist points at air", async () => {
  const { failures } = await auditWith((dir) => {
    const manifest = readOf("one/package.json");
    manifest.scripts.test = "vitest run --config missing.config.ts";
    write(dir, "one/package.json", JSON.stringify(manifest));
  });

  assert.deepEqual(failures, [
    '@scope/one: script "test" references missing.config.ts, which does not exist',
  ]);
});

test("a tsc target without an extension is checked as a path too", async () => {
  const { failures } = await auditWith((dir) => {
    const manifest = readOf("one/package.json");
    manifest.scripts.typecheck = "tsc -p tsconfig.gone";
    write(dir, "one/package.json", JSON.stringify(manifest));
  });

  assert.deepEqual(failures, [
    '@scope/one: script "typecheck" runs tsc -p tsconfig.gone, which does not exist',
  ]);
});

test("a version-looking argument is not treated as a path", async () => {
  const { failures } = await auditWith((dir) => {
    const manifest = readOf("one/package.json");
    manifest.scripts.publish = "npm publish --tag 1.2.3";
    write(dir, "one/package.json", JSON.stringify(manifest));
  });

  assert.deepEqual(failures, []);
});

test("a turbo task that turbo.json does not declare is a finding, in a package and in the root", async () => {
  const inPackage = await auditWith((dir) => {
    const manifest = readOf("one/package.json");
    manifest.scripts.all = "turbo run nope";
    write(dir, "one/package.json", JSON.stringify(manifest));
  });
  assert.deepEqual(inPackage.failures, [
    '@scope/one: script "all" runs turbo task "nope", not declared in turbo.json',
  ]);

  // The root manifest is not a workspace package. Leaving it out of this rule was the
  // shape of the `coverage:merge` failure the gate exists for, one layer up.
  const inRoot = await auditWith((dir) => {
    const manifest = readOf("package.json");
    manifest.scripts.all = "turbo run nope";
    write(dir, "package.json", JSON.stringify(manifest));
  });
  assert.deepEqual(inRoot.failures, [
    'fixture: script "all" runs turbo task "nope", not declared in turbo.json',
  ]);
});

test("a turbo task no package implements would run nothing and pass", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      "turbo.json",
      JSON.stringify({ tasks: { build: {}, test: {}, lint: {} } }),
    ),
  );

  assert.deepEqual(failures, [
    'turbo.json declares task "lint" that no package implements — it would run nothing and pass',
  ]);
});

test("a turbo task that is persistent or extends another is exempt, because it does not need an implementer", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      "turbo.json",
      JSON.stringify({
        tasks: {
          build: {},
          test: {},
          dev: { persistent: true },
          lint: { extends: ["build"] },
        },
      }),
    ),
  );

  assert.deepEqual(failures, []);
});

test("a workflow that runs a root script which does not exist is a finding", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm run build\n      - run: pnpm run nope\n",
    ),
  );

  assert.ok(
    failures.includes(
      'ci.yml:5 runs "pnpm run nope" but the root package does not define it',
    ),
    failures.join("\n"),
  );
});

test("a workflow that runs a script in a package which does not define it is a finding", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm --filter @scope/one run nope\n",
    ),
  );

  assert.ok(
    failures.includes(
      'ci.yml:4 runs "nope" in @scope/one, which does not define it',
    ),
    failures.join("\n"),
  );
});

test("a workflow may name a package by directory, and a matrix expression is not guessed at", async () => {
  const byDirectory = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm --filter ./one run build\n" +
        "      - run: pnpm --filter ${{ matrix.package }} run build\n" +
        "      - run: pnpm -w run test:mutation:one\n",
    ),
  );
  assert.deepEqual(byDirectory.failures, []);

  // `./one...` is turbo's dependency syntax for the same directory.
  const turboSyntax = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm --filter ./one... run build\n" +
        "      - run: pnpm -w run test:mutation:one\n",
    ),
  );
  assert.deepEqual(turboSyntax.failures, []);
});

test("a filter naming no package is reported rather than ignored", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm --filter ghcr.io/nope run build\n",
    ),
  );

  assert.ok(
    failures.includes(
      'workflow filter "ghcr.io/nope" does not name a workspace package',
    ),
    failures.join("\n"),
  );
});

test("a workflow turbo step must name a declared task that some package implements", async () => {
  const undeclared = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm --filter=@scope/one turbo run nope\n" +
        "      - run: pnpm -w run test:mutation:one\n",
    ),
  );
  assert.deepEqual(undeclared.failures, [
    'ci.yml:4 runs turbo task "nope", not declared',
  ]);

  const unimplemented = await auditWith((dir) => {
    write(
      dir,
      "turbo.json",
      JSON.stringify({
        tasks: { build: {}, test: {}, lint: { extends: ["build"] } },
      }),
    );
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm --filter=@scope/one turbo run lint\n" +
        "      - run: pnpm -w run test:mutation:one\n",
    );
  });
  assert.deepEqual(unimplemented.failures, [
    'ci.yml:4 runs turbo task "lint" that no package implements',
  ]);
});

test("a commented-out command is prose, not a command", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      # - run: pnpm run nope\n" +
        "      - run: pnpm run build\n" +
        "      - run: pnpm -w run test:mutation:one\n",
    ),
  );

  assert.deepEqual(failures, []);
});

test("a mutation target without a break threshold is a report, not a gate", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      "mutation/targets.mjs",
      "export const TARGETS = {\n" +
        "  one: {\n    mutate: ['one/src/**/*.ts'],\n" +
        "    testConfig: 'one/vitest.config.ts',\n    thresholds: {},\n  },\n};\n" +
        "export const SHARED = { timeoutMS: 30000 };\n",
    ),
  );

  assert.deepEqual(failures, [
    'mutation target "one": no numeric thresholds.break — a score nobody fails on is a report, not a gate',
  ]);
});

test("a mutate pattern that matches nothing would report a perfect score over no mutants", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      "mutation/targets.mjs",
      "export const TARGETS = {\n" +
        "  one: {\n    mutate: [],\n" +
        "    testConfig: 'one/vitest.config.ts',\n    thresholds: { break: 70 },\n  },\n};\n" +
        "export const SHARED = { timeoutMS: 30000 };\n",
    ),
  );

  assert.deepEqual(failures, ['mutation target "one": mutates nothing']);
});

test("a mutate pattern that matches no file names the pattern", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      "mutation/targets.mjs",
      "export const TARGETS = {\n" +
        "  one: {\n    mutate: ['one/src/**/*.gone'],\n" +
        "    testConfig: 'one/vitest.config.ts',\n    thresholds: { break: 70 },\n  },\n};\n" +
        "export const SHARED = { timeoutMS: 30000 };\n",
    ),
  );

  assert.deepEqual(failures, [
    'mutation target "one": mutate pattern "one/src/**/*.gone" matches no file',
  ]);
});

test("a test config that does not exist, declares no include, or covers nothing", async () => {
  const target = (testConfig) =>
    "export const TARGETS = {\n" +
    "  one: {\n    mutate: ['one/src/**/*.ts'],\n" +
    `    testConfig: '${testConfig}',\n    thresholds: { break: 70 },\n  },\n};\n` +
    "export const SHARED = { timeoutMS: 30000 };\n";

  const missing = await auditWith((dir) =>
    write(dir, "mutation/targets.mjs", target("one/gone.config.ts")),
  );
  assert.deepEqual(missing.failures, [
    'mutation target "one": testConfig "one/gone.config.ts" does not exist',
  ]);

  const noInclude = await auditWith((dir) => {
    write(dir, "mutation/targets.mjs", target("one/vitest.config.ts"));
    write(dir, "one/vitest.config.ts", "export default { test: {} };\n");
  });
  assert.ok(
    noInclude.failures.includes(
      'mutation target "one": one/vitest.config.ts declares no include list — the verdict would come from the whole suite',
    ),
    noInclude.failures.join("\n"),
  );

  const emptyInclude = await auditWith((dir) => {
    write(dir, "mutation/targets.mjs", target("one/vitest.config.ts"));
    write(
      dir,
      "one/vitest.config.ts",
      "export default { test: { include: ['src/gone/*.ts'] } };\n",
    );
  });
  assert.ok(
    emptyInclude.failures.includes(
      'mutation target "one": one/vitest.config.ts includes "src/gone/*.ts", which matches no test file',
    ),
    emptyInclude.failures.join("\n"),
  );
});

test("a test timeout at or above the runner's cap would record a hang as an abandoned mutant", async () => {
  const missing = await auditWith((dir) =>
    write(
      dir,
      "one/vitest.config.ts",
      "export default { test: { include: ['src/**/*.test.ts'] } };\n",
    ),
  );
  assert.equal(missing.failures.length, 2);
  assert.match(missing.failures[0], /does not declare testTimeout/);
  assert.match(missing.failures[1], /does not declare hookTimeout/);

  // Two settings on one line are two settings: the check reads the code on a line, so
  // where on the line it sits does not decide whether it is seen.
  const atCap = await auditWith((dir) =>
    write(
      dir,
      "one/vitest.config.ts",
      "export default { test: { include: ['src/**/*.test.ts'], testTimeout: 30000, hookTimeout: 60000 } };\n",
    ),
  );
  assert.match(
    atCap.failures[0],
    /sets testTimeout 30000ms, at or above the runner's 30000ms cap/,
  );
  assert.match(atCap.failures[1], /sets hookTimeout 60000ms/);

  // A number quoted in a comment is prose: the check reads the assignment only.
  const quoted = await auditWith((dir) =>
    write(
      dir,
      "one/vitest.config.ts",
      "// was testTimeout: 60000, now below the cap\nexport default { test: { include: ['src/**/*.test.ts'], testTimeout: 10_000, hookTimeout: 10_000 } };\n",
    ),
  );
  assert.deepEqual(quoted.failures, []);
});

test("a target whose package is missing, or whose test:mutation does not delegate", async () => {
  const ghost = await auditWith((dir) =>
    write(
      dir,
      "mutation/targets.mjs",
      "export const TARGETS = {\n" +
        "  two: {\n    mutate: ['one/src/**/*.ts'],\n" +
        "    testConfig: 'one/vitest.config.ts',\n    thresholds: { break: 70 },\n  },\n};\n" +
        "export const SHARED = { timeoutMS: 30000 };\n",
    ),
  );
  assert.ok(
    ghost.failures.includes(
      'mutation target "two" names no workspace package — the target and its package directory are the same word by convention',
    ),
  );
  assert.ok(
    ghost.failures.some((line) =>
      line.includes('nothing in .github/workflows runs "test:mutation:two"'),
    ),
  );

  const noScript = await auditWith((dir) => {
    const manifest = readOf("one/package.json");
    delete manifest.scripts["test:mutation"];
    write(dir, "one/package.json", JSON.stringify(manifest));
  });
  assert.ok(
    noScript.failures.includes(
      '@scope/one: no "test:mutation" script — the gate is not runnable from its own package',
    ),
  );

  const notDelegating = await auditWith((dir) => {
    const manifest = readOf("one/package.json");
    manifest.scripts["test:mutation"] = "stryker run";
    write(dir, "one/package.json", JSON.stringify(manifest));
  });
  assert.ok(
    notDelegating.failures.includes(
      '@scope/one: "test:mutation" does not delegate to "test:mutation:one" — a run started in the package directory gets a sandbox with no parent',
    ),
  );
  assert.ok(
    notDelegating.failures.some((line) =>
      line.includes(
        '"test:mutation" runs something other than a root target ("stryker run")',
      ),
    ),
  );
});

test("a target no workflow invokes is a claim nobody checks", async () => {
  const { failures } = await auditWith((dir) =>
    write(
      dir,
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - run: pnpm run build\n",
    ),
  );

  assert.deepEqual(failures, [
    'nothing in .github/workflows runs "test:mutation:one" — a gate no workflow executes is a claim nobody checks',
  ]);
});

test("a root script for a target the table does not declare is a name nobody can run", async () => {
  const { failures } = await auditWith((dir) => {
    const manifest = readOf("package.json");
    manifest.scripts["test:mutation:ghost"] = "node scripts/mutation.mjs ghost";
    write(dir, "package.json", JSON.stringify(manifest));
  });

  assert.deepEqual(failures, [
    'package.json defines "test:mutation:ghost" for a target that stryker.config.mjs does not declare',
  ]);
});

test("an in-place instrument, or none at all, is a finding", async () => {
  const noConfig = await auditWith((dir) =>
    rmSync(join(dir, "stryker.config.mjs")),
  );
  assert.ok(
    noConfig.failures.includes(
      "stryker.config.mjs is missing from the root — the mutation gate has no instrument",
    ),
  );

  const inPlace = await auditWith((dir) =>
    write(dir, "stryker.config.mjs", "export default () => ({});\n"),
  );
  assert.deepEqual(inPlace.failures, [
    "stryker.config.mjs does not refuse --inPlace — an in-place run is not a sandbox, and its verdicts cannot be trusted",
  ]);

  const noRunner = await auditWith((dir) =>
    rmSync(join(dir, "scripts/mutation.mjs")),
  );
  assert.ok(
    noRunner.failures.includes(
      "scripts/mutation.mjs is missing — nothing anchors the run to the repository root",
    ),
  );

  const badTable = await auditWith((dir) =>
    write(dir, "mutation/targets.mjs", "throw new Error('no');\n"),
  );
  assert.match(
    badTable.failures[0],
    /mutation\/targets\.mjs cannot be imported: no/,
  );
});

test("the mutation output directories have to be ignored, or a run stages its own output", async () => {
  const { failures } = await auditWith((dir) =>
    write(dir, ".gitignore", "node_modules/\n"),
  );

  assert.deepEqual(failures, [
    ".gitignore does not ignore reports/mutation/ — a mutation run would stage its own output",
    ".gitignore does not ignore .stryker-tmp/ — a mutation run would stage its own output",
  ]);
});

test("a dependency patch is a gate only if it is still applied, and says why it exists", async () => {
  const patched = (patchPath, body, lock) =>
    auditWith((dir) => {
      const manifest = readOf("package.json");
      manifest.pnpm = { patchedDependencies: { "some-dep@1.0.0": patchPath } };
      write(dir, "package.json", JSON.stringify(manifest));
      if (body !== null) write(dir, patchPath, body);
      write(dir, "pnpm-lock.yaml", lock ?? "");
    });

  const missing = await patched("patches/some-dep.patch", null);
  assert.ok(
    missing.failures.includes(
      'patchedDependencies names "some-dep@1.0.0" but patches/some-dep.patch does not exist',
    ),
  );

  const noMarker = await patched(
    "patches/some-dep.patch",
    "diff\n",
    "patches/some-dep.patch\n",
  );
  assert.ok(
    noMarker.failures.includes(
      "patches/some-dep.patch carries no PATCH(db-stack) marker, so it does not say why it exists",
    ),
  );

  const notLocked = await patched(
    "patches/some-dep.patch",
    "PATCH(db-stack)\n",
    "",
  );
  assert.ok(
    notLocked.failures.includes(
      "patches/some-dep.patch is not referenced by pnpm-lock.yaml, so --frozen-lockfile would not apply it",
    ),
  );

  const good = await patched(
    "patches/some-dep.patch",
    "PATCH(db-stack)\n",
    "patches/some-dep.patch\n",
  );
  assert.deepEqual(good.failures, []);
  assert.ok(
    good.notes.includes("patch some-dep@1.0.0 -> patches/some-dep.patch"),
  );
});

test("report says what the gate found, and its exit code says whether that is a pass", async () => {
  const lines = [];
  const errors = [];
  const sink = {
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    verbose: false,
  };

  assert.equal(
    report(
      { failures: [], notes: [], packages: [1, 2], turboTasks: new Set(["a"]) },
      sink,
    ),
    0,
  );
  assert.deepEqual(lines, [
    "check-gates: 2 packages, 1 turbo tasks — every gate is wired",
  ]);

  lines.length = 0;
  const failing = report(
    {
      failures: ["something"],
      notes: ["a note"],
      packages: [],
      turboTasks: new Set(),
    },
    { ...sink, verbose: true },
  );
  assert.equal(failing, 1);
  assert.deepEqual(lines, ["ok   a note"]);
  assert.deepEqual(errors, [
    "check-gates: 1 structural problem(s)",
    "  ✗ something",
  ]);
});

test("the entry check answers for this module, another file, and no file at all", () => {
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/check-gates.mjs")), true);
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/check-english.mjs")), false);
  assert.equal(isEntryPoint(undefined), false);
});

test("the command line reports this repository as wired", async () => {
  const lines = [];
  const errors = [];

  const code = await run(ROOT, {
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    verbose: false,
  });

  assert.deepEqual(errors, []);
  assert.equal(code, 0);
  assert.match(
    lines.join("\n"),
    /check-gates: \d+ packages, \d+ turbo tasks — every gate is wired/,
  );
});

test("a workspace pattern that names nothing, and a directory that is not a package", async () => {
  // `expand` walks each segment; a wildcard over a directory that does not exist is a
  // pattern nobody can satisfy, and a directory without a manifest is not a package.
  const { failures, packages } = await withTree(
    {
      ...FILES,
      "pnpm-workspace.yaml": "packages:\n  - one\n  - gone/*\n  - loose\n",
      "loose/README.md": "no manifest here\n",
    },
    (dir) => audit(dir),
  );

  assert.deepEqual(
    packages.map((pkg) => pkg.name),
    ["@scope/one"],
  );
  assert.deepEqual(failures, []);
});

test("a manifest without a name or scripts falls back to its directory, and to no scripts", async () => {
  const { failures, packages } = await withTree(
    {
      ...FILES,
      "pnpm-workspace.yaml": "packages:\n  - one\n  - bare\n",
      "bare/package.json": JSON.stringify({}),
    },
    (dir) => audit(dir),
  );

  // The package is named by its directory when the manifest does not name it, so the
  // finding a reader sees still points at something they can open.
  assert.deepEqual(
    packages.map((pkg) => pkg.name),
    ["@scope/one", "bare"],
  );
  assert.deepEqual(packages[1].scripts, {});
  assert.deepEqual(failures, []);
});

test("a root manifest with no name, no scripts and no patches is a small root, not a crash", async () => {
  const { failures } = await withTree(
    { ...FILES, "package.json": JSON.stringify({ name: "fixture" }) },
    (dir) => audit(dir),
  );

  // No scripts means the `pnpm run build` step has nothing to point at; that is the
  // finding, and it is the only one.
  assert.deepEqual(failures, [
    'ci.yml:4 runs "pnpm run build" but the root package does not define it',
  ]);

  const unnamed = await withTree(
    {
      ...FILES,
      "package.json": JSON.stringify({
        scripts: {
          build: "tsc -p tsconfig.json",
          "test:mutation:one": "node scripts/mutation.mjs one",
        },
      }),
    },
    (dir) => audit(dir),
  );
  assert.deepEqual(unnamed.failures, []);
});

test("a turbo.json with no tasks declares nothing, so every turbo call is a finding", async () => {
  const quiet = await withTree(
    { ...FILES, "turbo.json": JSON.stringify({}) },
    (dir) => audit(dir),
  );
  assert.equal(quiet.turboTasks.size, 0);
  assert.deepEqual(
    quiet.failures,
    [],
    "no script calls turbo, so there is nothing to report",
  );

  const calling = await withTree(
    {
      ...FILES,
      "turbo.json": JSON.stringify({}),
      "one/package.json": JSON.stringify({
        name: "@scope/one",
        scripts: {
          build: "turbo run build",
          "test:mutation": "pnpm -w run test:mutation:one",
        },
      }),
      // `turbo run build` in a script needs a tsconfig no longer: the script that
      // referenced one is gone, so the file becomes an orphan and that is a finding.
    },
    (dir) => audit(dir),
  );
  assert.ok(
    calling.failures.includes(
      '@scope/one: script "build" runs turbo task "build", not declared in turbo.json',
    ),
    calling.failures.join("\n"),
  );
  assert.ok(
    calling.failures.includes(
      "@scope/one: tsconfig.json exists but no script references it — an orphan configuration is not a gate",
    ),
    calling.failures.join("\n"),
  );
});

test("a script quoting a matrix expression is not a path", async () => {
  const { failures } = await withTree(
    {
      ...FILES,
      "one/package.json": JSON.stringify({
        name: "@scope/one",
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "vitest run ${{ matrix.shard }}.ts",
          "test:mutation": "pnpm -w run test:mutation:one",
        },
      }),
    },
    (dir) => audit(dir),
  );

  assert.deepEqual(failures, []);
});

test("a target with no mutate list and no test config is named twice, not guessed at", async () => {
  const { failures } = await withTree(
    {
      ...FILES,
      "mutation/targets.mjs":
        "export const TARGETS = { one: { thresholds: { break: 70 } } };\n" +
        "export const SHARED = { timeoutMS: 30000 };\n",
    },
    (dir) => audit(dir),
  );

  assert.ok(
    failures.includes('mutation target "one": mutates nothing'),
    failures.join("\n"),
  );
  assert.ok(
    failures.includes(
      'mutation target "one": testConfig "undefined" does not exist',
    ),
    failures.join("\n"),
  );
});

test("an include list written with double quotes is read the same way", async () => {
  const { failures } = await withTree(
    {
      ...FILES,
      "one/vitest.config.ts":
        'export default {\n  test: {\n    include: ["src/**/*.test.ts"],\n' +
        "    testTimeout: 10000,\n    hookTimeout: 10000,\n  },\n};\n",
    },
    (dir) => audit(dir),
  );

  assert.deepEqual(failures, []);
});

test("a repository with no workflows directory still checks the mutation targets", async () => {
  const files = { ...FILES };
  delete files[".github/workflows/ci.yml"];

  const { failures } = await withTree(files, (dir) => audit(dir));

  assert.deepEqual(failures, [
    'nothing in .github/workflows runs "test:mutation:one" — a gate no workflow executes is a claim nobody checks',
  ]);
});

test("a question mark in a glob matches one character, not any run of them", async () => {
  const { failures } = await withTree(
    {
      ...FILES,
      "mutation/targets.mjs":
        "export const TARGETS = {\n" +
        "  one: {\n    mutate: ['one/src/on?.ts'],\n" +
        "    testConfig: 'one/vitest.config.ts',\n    thresholds: { break: 70 },\n  },\n};\n" +
        "export const SHARED = { timeoutMS: 30000 };\n",
    },
    (dir) => audit(dir),
  );

  assert.deepEqual(failures, []);
});
