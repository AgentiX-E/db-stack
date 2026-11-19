/**
 * Tests for the dependency policy.
 *
 * The policy exists because `continue-on-error` and a stale ignore list both
 * turn a gate into a comment. Its three rules are therefore pinned against
 * advisory sets written here rather than against whatever the registry says
 * today — a test that read the live tree would pass the day the tree is clean
 * and say nothing about the rule.
 *
 * `advisories()` is tested with an injected `exec`, because its interesting case
 * is the one that never happens on a good day: `pnpm audit` exits non-zero with
 * the JSON still on stdout, and an empty stdout has to be re-thrown rather than
 * read as "no advisories".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  advisories,
  evaluate,
  idOf,
  isEntryPoint,
  replay,
  run,
  toMap,
} from "./audit-policy.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const advisory = (overrides) => ({
  id: 1,
  module_name: "left-pad",
  severity: "high",
  title: "Prototype pollution",
  github_advisory_id: "GHSA-1111-2222-3333",
  ...overrides,
});

/** A map keyed the way `pnpm audit --json` keys advisories: by numeric id. */
const mapOf = (...entries) =>
  new Map(entries.map(([key, value]) => [key, value]));

test("idOf prefers the GHSA id and falls back to the npm one", () => {
  assert.equal(idOf(advisory({})), "GHSA-1111-2222-3333");
  assert.equal(
    idOf(advisory({ github_advisory_id: undefined, id: 42 })),
    "npm-42",
  );
});

test("toMap keeps every advisory and tolerates a report with none", () => {
  assert.deepEqual(
    [...toMap({ advisories: { 1: advisory({}) } }).keys()],
    ["1"],
  );
  assert.equal(toMap({}).size, 0);
});

test("a blocking advisory in the production tree fails, and no exception can cover it", () => {
  const { failures, exceptions } = evaluate({
    all: mapOf(["1", advisory({})]),
    production: mapOf(["1", advisory({})]),
    allow: [
      {
        advisory: "GHSA-1111-2222-3333",
        reason: "we do not ship it",
        reviewed: "2026-11-19",
      },
    ],
  });

  // One finding, not two: the entry is not stale (the advisory is in the tree),
  // and it still did not silence anything — the production loop never reads the
  // allowlist, which is the whole point of splitting the question in three.
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /^production: left-pad — high — GHSA-1111-2222-3333 — Prototype pollution\./,
  );
  assert.match(failures[0], /No exception can cover a dependency that ships\./);
  assert.deepEqual(exceptions, []);
});

test("a moderate advisory is reported by neither rule", () => {
  const { failures, exceptions } = evaluate({
    all: mapOf(["1", advisory({ severity: "moderate" })]),
    production: mapOf(["1", advisory({ severity: "moderate" })]),
    allow: [],
  });

  assert.deepEqual(failures, []);
  assert.deepEqual(exceptions, []);
});

test("a dev-tree advisory needs a named exception", () => {
  const { failures } = evaluate({
    all: mapOf([
      "7",
      advisory({ id: 7, severity: "critical", title: undefined }),
    ]),
    production: new Map(),
    allow: [],
  });

  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /^dev tree: left-pad — critical — GHSA-1111-2222-3333 — no title\./,
  );
  assert.match(failures[0], /Add an entry to auditPolicy\.allow with a reason/);
});

test("an exception that matches is reported with its reason and review date", () => {
  const { failures, exceptions } = evaluate({
    all: mapOf(["7", advisory({ id: 7 })]),
    production: new Map(),
    allow: [
      {
        advisory: "GHSA-1111-2222-3333",
        reason: "Stryker only",
        reviewed: "2026-11-19",
      },
    ],
  });

  assert.deepEqual(failures, []);
  assert.deepEqual(exceptions, [
    "left-pad (GHSA-1111-2222-3333) — Stryker only — reviewed 2026-11-19",
  ]);
});

test("an exception that matches nothing fails, so the list cannot rot", () => {
  const { failures } = evaluate({
    all: new Map(),
    production: new Map(),
    allow: [
      {
        advisory: "GHSA-9999-8888-7777",
        reason: "fixed two years ago",
        reviewed: "2024-01-01",
      },
    ],
  });

  assert.deepEqual(failures, [
    "stale exception: GHSA-9999-8888-7777 matches no advisory in the tree. Remove it, or the next " +
      "advisory that reuses the id is exempt without anybody deciding that.",
  ]);
});

test("a dev advisory that is also in production is judged once, as production", () => {
  const { failures } = evaluate({
    all: mapOf(["3", advisory({ id: 3 })]),
    production: mapOf(["3", advisory({ id: 3 })]),
    allow: [
      {
        advisory: "GHSA-1111-2222-3333",
        reason: "counts as present",
        reviewed: "2026-11-19",
      },
    ],
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0], /^production:/);
});

test("advisories parses the JSON that arrives with a non-zero exit", () => {
  const exec = () => {
    const error = new Error("exit 1");
    error.stdout = JSON.stringify({ advisories: { 1: advisory({}) } });
    throw error;
  };

  assert.deepEqual([...advisories([], exec).keys()], ["1"]);
});

test("an audit that could not look is re-thrown, not reported as clean", () => {
  const exec = () => {
    const error = new Error("ERR_PNPM_META_FETCH_FAIL");
    error.stdout = "   \n";
    throw error;
  };

  assert.throws(() => advisories([], exec), /ERR_PNPM_META_FETCH_FAIL/);
});

/** A recording in the shape `--from` reads. */
function recording(dir, { all = {}, production = {} } = {}) {
  const path = join(dir, "audit.json");
  writeFileSync(
    path,
    JSON.stringify({
      all: { advisories: all },
      production: { advisories: production },
    }),
  );
  return path;
}

test("run replays a recording and passes when the tree is clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-policy-"));
  try {
    const lines = [];
    const code = run(["--from", recording(dir)], {
      log: (line) => lines.push(line),
      pkg: {},
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, [
      "Dependency policy passed: 0 advisories in the production tree, 0 exception(s) in the dev tree.",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run replays a recording, prints the exceptions it granted, and fails on the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-policy-"));
  try {
    const path = recording(dir, {
      all: {
        7: advisory({ id: 7, severity: "high" }),
        8: advisory({ id: 8, module_name: "jsdom", severity: "critical" }),
      },
      production: {
        9: advisory({ id: 9, module_name: "pg", severity: "high" }),
      },
    });
    const lines = [];
    const errors = [];
    const code = run(["--from", path], {
      pkg: {
        auditPolicy: {
          allow: [
            {
              advisory: "GHSA-1111-2222-3333",
              reason: "jsdom only",
              reviewed: "2026-11-19",
            },
          ],
        },
      },
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.deepEqual(lines[0], "Allowlisted, dev tree only:");
    assert.match(
      lines[1],
      /left-pad \(GHSA-1111-2222-3333\) — jsdom only — reviewed 2026-11-19/,
    );
    assert.deepEqual(errors[0], "Dependency policy failed:");
    assert.match(errors[1], /^  - production: pg — high/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay reads both halves of a recording", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-policy-"));
  try {
    const { all, production } = replay(
      recording(dir, { all: { 1: advisory({}) }, production: {} }),
    );

    assert.equal(all.size, 1);
    assert.equal(production.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--from without a path is a usage error", () => {
  const errors = [];
  assert.equal(run(["--from"], { error: (line) => errors.push(line) }), 2);
  assert.deepEqual(errors, ["audit-policy: --from needs a path"]);
});

test("run without a recording asks the registry, and the answer decides", () => {
  const asked = [];
  const read = (args) => {
    asked.push(args);
    return args.includes("--prod")
      ? mapOf(["9", advisory({ module_name: "pg" })])
      : new Map();
  };

  const errors = [];
  const code = run([], {
    advisories: read,
    pkg: {},
    error: (line) => errors.push(line),
    log: () => {},
  });

  assert.equal(code, 1);
  assert.deepEqual(asked, [[], ["--prod"]]);
  assert.match(errors[1], /production: pg/);
});

test("a recording with no halves is read as one undivided tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-policy-"));
  try {
    const path = join(dir, "bare.json");
    writeFileSync(path, JSON.stringify({ advisories: { 1: advisory({}) } }));
    const { all, production } = replay(path);

    assert.equal(all.size, 1);
    assert.equal(production.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line exits with the policy's verdict over a recording", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-policy-"));
  try {
    const path = recording(dir, {
      all: {},
      production: { 9: advisory({ module_name: "pg" }) },
    });
    const child = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/audit-policy.mjs"), "--from", path],
      {
        encoding: "utf8",
      },
    );

    assert.equal(child.status, 1);
    assert.match(child.stderr, /production: pg — high/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an advisory with no title is still named by a sentence that reads", () => {
  const { failures } = evaluate({
    all: new Map(),
    production: new Map([
      ["1", { id: 1, module_name: "left-pad", severity: "high" }],
    ]),
    allow: new Map(),
  });

  assert.match(
    failures[0],
    /no title\. No exception can cover a dependency that ships\.$/,
  );
});

test("a registry that answers nothing is re-thrown, not read as no advisories", () => {
  // `pnpm audit` exits non-zero whenever it has news, so the failure path is the
  // normal one and the JSON still arrives. No stdout at all is a different event —
  // an offline runner — and a policy gate that passes when it could not look is a
  // gate that always passes.
  assert.throws(
    () =>
      advisories([], () => {
        throw new Error("offline");
      }),
    /offline/,
  );

  const withStdout = advisories([], () => {
    const error = new Error("advisories found");
    error.stdout = JSON.stringify({
      advisories: { 9: { id: 9, severity: "low" } },
    });
    throw error;
  });
  assert.deepEqual([...withStdout.keys()], ["9"]);
});

test("the entry check answers for this module, another file, and no file at all", () => {
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/audit-policy.mjs")), true);
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/check-english.mjs")), false);
  assert.equal(isEntryPoint(undefined), false);
});
