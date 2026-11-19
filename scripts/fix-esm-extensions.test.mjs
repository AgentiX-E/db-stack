/**
 * Tests for the post-build ESM specifier pass.
 *
 * The pass runs between `tsc` and the tarball, so a bug here ships: a missed
 * specifier breaks `import` for every consumer, and a *guessed* one breaks it in
 * a way nobody can read (`ERR_MODULE_NOT_FOUND` for a file the author never
 * named). Both directions are pinned below.
 *
 * The fixtures are real directories with real files, because the pass is a
 * filesystem operation: whether `./sub` becomes `./sub/index.js` depends on what
 * is on disk, and a test that skipped the disk would only prove the regex.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  fixSpecifier,
  main,
  processFile,
  walk,
} from "./fix-esm-extensions.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** A temporary tree, removed when `body` returns or throws. */
async function withTree(files, body) {
  const dir = mkdtempSync(join(tmpdir(), "esm-fix-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a relative specifier that names a file gains its extension", async () => {
  await withTree(
    { "dist/a.js": "export const a = 1;\n", "dist/b.js": "" },
    async (dir) => {
      assert.equal(await fixSpecifier(join(dir, "dist/b.js"), "./a"), "./a.js");
    },
  );
});

test("a directory import becomes its index file", async () => {
  await withTree({ "dist/sub/index.js": "" }, async (dir) => {
    assert.equal(
      await fixSpecifier(join(dir, "dist/main.js"), "./sub"),
      "./sub/index.js",
    );
    assert.equal(
      await fixSpecifier(join(dir, "dist/main.js"), "./sub/"),
      "./sub/index.js",
    );
  });
});

test("an explicit JavaScript extension is left exactly as written", async () => {
  await withTree(
    { "dist/a.mjs": "", "dist/a.cjs": "", "dist/a.js": "" },
    async (dir) => {
      const from = join(dir, "dist/main.js");
      assert.equal(await fixSpecifier(from, "./a.js"), "./a.js");
      assert.equal(await fixSpecifier(from, "./a.mjs"), "./a.mjs");
      assert.equal(await fixSpecifier(from, "./a.cjs"), "./a.cjs");
    },
  );
});

test("a specifier that resolves to nothing is left alone, not guessed at", async () => {
  await withTree({ "dist/a.js": "" }, async (dir) => {
    assert.equal(
      await fixSpecifier(join(dir, "dist/main.js"), "./missing"),
      "./missing",
    );
    // A directory with no index is the same case: the pass must not invent
    // `./empty/index.js` for a file that does not exist.
    mkdirSync(join(dir, "dist/empty"), { recursive: true });
    assert.equal(
      await fixSpecifier(join(dir, "dist/main.js"), "./empty"),
      "./empty",
    );
  });
});

test("every form that takes a specifier is rewritten", async () => {
  await withTree(
    {
      "dist/dep.js": "",
      "dist/main.js": [
        "export * from './dep';",
        "const lazily = import('./dep');",
        "const legacy = require('./dep');",
        "const untouched = './dep';",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const file = join(dir, "dist/main.js");
      assert.equal(await processFile(file), 3);
      const text = readFileSync(file, "utf8");
      assert.equal(text.match(/from '\.\/dep\.js'/g)?.length, 1);
      assert.equal(text.match(/import\('\.\/dep\.js'\)/g)?.length, 1);
      assert.equal(text.match(/require\('\.\/dep\.js'\)/g)?.length, 1);
      // A bare string that is not a specifier stays a bare string.
      assert.match(text, /const untouched = '\.\/dep';/);
    },
  );
});

test("declaration files are rewritten, so the types resolve the same way the code does", async () => {
  // A declaration file points at the JavaScript file that carries the runtime
  // value; both are emitted by the same build, which is why the .js exists.
  await withTree(
    {
      "dist/dep.js": "",
      "dist/dep.d.ts": "",
      "dist/index.d.ts": "export * from './dep';\n",
    },
    async (dir) => {
      const file = join(dir, "dist/index.d.ts");
      assert.equal(await processFile(file), 1);
      assert.match(readFileSync(file, "utf8"), /from '\.\/dep\.js'/);
    },
  );
});

test("a file with no relative specifier is not rewritten and reports zero", async () => {
  await withTree({ "dist/plain.js": "export const x = 1;\n" }, async (dir) => {
    const file = join(dir, "dist/plain.js");
    assert.equal(await processFile(file), 0);
    assert.equal(readFileSync(file, "utf8"), "export const x = 1;\n");
  });
});

test("walk collects JavaScript and declaration files, recursively, and nothing else", async () => {
  await withTree(
    {
      "dist/a.js": "",
      "dist/nested/b.js": "",
      "dist/nested/c.d.ts": "",
      "dist/notes.md": "",
      "dist/data.json": "{}",
    },
    async (dir) => {
      const files = (await walk(join(dir, "dist")))
        .map((file) => file.slice(dir.length + 1))
        .sort();

      assert.deepEqual(files, [
        "dist/a.js",
        "dist/nested/b.js",
        "dist/nested/c.d.ts",
      ]);
    },
  );
});

test("walk returns what it has when a directory cannot be read", async () => {
  await withTree({}, async (dir) => {
    assert.deepEqual(await walk(join(dir, "absent")), []);
  });
});

test("main rewrites a tree and counts what it changed", async () => {
  await withTree(
    {
      "dist/dep.js": "",
      "dist/one.js": "export * from './dep';\n",
      "dist/two.js": "export * from './dep';\nexport * from './dep';\n",
      "dist/three.js": "export const no = 1;\n",
    },
    async (dir) => {
      const lines = [];
      const code = await main(["dist"], {
        cwd: dir,
        log: (line) => lines.push(line),
      });

      assert.equal(code, 0);
      assert.deepEqual(lines, [
        "fix-esm-extensions: 3 specifier(s) in 2 file(s) rewritten",
      ]);
      assert.equal(
        readFileSync(join(dir, "dist/two.js"), "utf8"),
        "export * from './dep.js';\nexport * from './dep.js';\n",
      );
    },
  );
});

test("main skips a target that is not a directory", async () => {
  await withTree({ "dist/a.js": "" }, async (dir) => {
    const lines = [];
    const code = await main(["absent", "dist"], {
      cwd: dir,
      log: (line) => lines.push(line),
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, [
      "fix-esm-extensions: 0 specifier(s) in 0 file(s) rewritten",
    ]);
  });
});

test("main without a target is a usage error, not a silent success", async () => {
  const errors = [];
  const code = await main([], { error: (line) => errors.push(line) });

  assert.equal(code, 2);
  assert.deepEqual(errors, ["usage: fix-esm-extensions.mjs <dist-dir> [...]"]);
});

test("the command line reports the usage error and exits 2", () => {
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/fix-esm-extensions.mjs")],
    {
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 2);
  assert.match(child.stderr, /usage: fix-esm-extensions\.mjs/);
});
