/**
 * Tests for the test-count gate.
 *
 * `operations/README.md` stated its test totals five times and three of the
 * five were wrong — by an order of magnitude per package, in both directions.
 * The gate that now compares them is worth exactly as much as these cases make
 * it: a checker that passes a page it cannot read is the same defect one layer
 * out, so every case below either proves a finding is produced at the right
 * line, or proves the gate stays quiet on a page that is right.
 *
 * The last two cases run over the real page. They are the ones that keep the
 * gate from passing vacuously: one asserts the real page still contains the
 * five sentences the gate reads (a pattern that matches nothing is a pattern
 * that checks nothing), the other recounts the table with independent
 * arithmetic instead of trusting the gate's own numbers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  auditPage,
  formatCount,
  measure,
  parseCount,
  run,
  statements,
  TARGETS,
} from "./check-test-counts.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** A report in the shape `vitest --reporter=json` writes. */
const reportOf = (...files) => ({
  testResults: files.map(([name, cases]) => ({
    name,
    ...(cases === null
      ? {}
      : { assertionResults: Array.from({ length: cases }, () => ({})) }),
  })),
});

// The fixtures follow the layout: a module is a directory inside a package, so the
// package a file counts towards is the first segment under `packages/`, not the
// module name. `registry.test.ts` and `probe.test.ts` belong to `node`; the e2e
// suite under `core` belongs to `node` as well.
const CORE =
  "/repo/operations/packages/node/src/core/__tests__/registry.test.ts";
const HEALTH =
  "/repo/operations/packages/node/src/health/__tests__/probe.test.ts";
const E2E =
  "/repo/operations/packages/node/src/core/__tests__/e2e/cluster.test.ts";
const FEDERATION =
  "/repo/operations/packages/federation/src/__tests__/router.test.ts";
const LOOSE = "/repo/operations/src/loose.test.ts";

/** A page that states all five numbers the gate reads, and states them right. */
const PAGE = `# Operations

**A production-grade layer — 2 packages, 2 test cases in 3 files, every
coverage dimension at or above 95 %.**

## Packages

| Package | Status | Tests | Description |
|---------|--------|-------|-------------|
| [\`node\`](./packages/node/) | ✅ | 2 | Node-local modules |
| [\`federation\`](./packages/federation/) | ✅ | 0 | Cross-datacenter binding |

**Total: \`pnpm coverage\` reports 3 files and 2 tests, 0 failures** (\`test:unit\`: 3 files /
2; \`test:integration\`: 0 files / 0).

## Testing

\`\`\`bash
npm test              # 3 files, 2 tests
\`\`\`
`;

const measuredOf = () =>
  measure(reportOf([CORE, 2], [HEALTH, null], [FEDERATION, null]));

test("counts cases and files per package", () => {
  const measured = measure(
    reportOf([CORE, 3], [HEALTH, 2], [E2E, 1], [FEDERATION, 4]),
  );

  // Two modules of one package, one integration file, one other package.
  assert.deepEqual(measured.packages.get("node"), { cases: 6, files: 3 });
  assert.deepEqual(measured.packages.get("federation"), { cases: 4, files: 1 });
  assert.deepEqual(measured.total, { cases: 10, files: 4 });
});

test("splits the suites at the e2e directory", () => {
  const measured = measure(reportOf([CORE, 3], [E2E, 1]));

  assert.deepEqual(measured.suites.unit, { files: 1, cases: 3 });
  assert.deepEqual(measured.suites.integration, { files: 1, cases: 1 });
});

test("a test file outside every package is reported, not dropped", () => {
  const measured = measure(reportOf([CORE, 2], [LOOSE, 5]));

  assert.equal(measured.packages.has("loose"), false);
  assert.deepEqual(measured.unowned, [{ path: LOOSE, cases: 5 }]);
  // The total still counts it: a total that silently omits a file is a total
  // that agrees with a table nobody can add up.
  assert.deepEqual(measured.total, { cases: 7, files: 2 });
});

test("a file that failed to collect still counts as a file, with no cases", () => {
  const measured = measure(reportOf([HEALTH, null]));

  assert.deepEqual(measured.packages.get("node"), { cases: 0, files: 1 });
  assert.deepEqual(measured.total, { cases: 0, files: 1 });
});

test("reads a count the way a page writes it", () => {
  assert.equal(parseCount("3 155"), 3155);
  assert.equal(parseCount("3,155"), 3155);
  assert.equal(parseCount("3155"), 3155);
  assert.equal(parseCount("2 824"), 2824);
  assert.equal(parseCount("0"), 0);
  assert.ok(Number.isNaN(parseCount("many")));
});

test("groups thousands the way the page does", () => {
  assert.equal(formatCount(7), "7");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1 000");
  assert.equal(formatCount(3155), "3 155");
  assert.equal(formatCount(12000), "12 000");
});

test("a page whose five statements agree produces no finding", () => {
  const { findings, edits } = auditPage(PAGE, measuredOf());

  assert.deepEqual(findings, []);
  assert.deepEqual(edits, []);
});

test("a total the run disagrees with is a finding at the sentence that states it", () => {
  const text = PAGE.replace(
    "2 packages, 2 test cases in 3 files",
    "2 packages, 3 149 test cases in 3 files",
  );
  const { findings } = auditPage(text, measuredOf());

  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /says `3 149` where the run reports `2`/);
  assert.equal(findings[0].line, 3);
});

test("the unit and integration split is checked too", () => {
  const text = PAGE.replace("`test:unit`: 3 files /", "`test:unit`: 4 files /");
  const { findings } = auditPage(text, measuredOf());

  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /says `4` where the run reports `3`/);
  assert.match(
    findings[0].message,
    /\(3 files and 2 tests, unit 3 files \/ 2, integration 0 files \/ 0\)/,
  );
});

test("a row that understates a package is a finding on that row", () => {
  const text = PAGE.replace(
    "| [`node`](./packages/node/) | ✅ | 2 |",
    "| [`node`](./packages/node/) | ✅ | 549 |",
  );
  const { findings } = auditPage(text, measuredOf());

  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /`node` has 549 test case\(s\); the run reports 2/,
  );
  assert.equal(findings[0].line, 10);
});

test("a row for a package with no test file is a finding", () => {
  const text = PAGE.replace(
    "| [`federation`](./packages/federation/) | ✅ | 0 | Cross-datacenter binding |",
    "| [`federation`](./packages/federation/) | ✅ | 0 | Cross-datacenter binding |\n| [`logger`](./packages/logger/) | ✅ | 55 | Logs |",
  );
  const { findings } = auditPage(text, measuredOf());

  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /lists `logger` with 55 test case\(s\), and no test file/,
  );
});

test("a package the run measured and the table omits is a finding", () => {
  const text = PAGE.replace(
    "| [`federation`](./packages/federation/) | ✅ | 0 | Cross-datacenter binding |\n",
    "",
  );
  const { findings } = auditPage(text, measuredOf());

  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /has a package `federation` with 0 test case\(s\) and no row/,
  );
});

test("a table that lists the same package twice is a finding", () => {
  const text = PAGE.replace(
    "| [`federation`](./packages/federation/) | ✅ | 0 | Cross-datacenter binding |",
    "| [`federation`](./packages/federation/) | ✅ | 0 | Cross-datacenter binding |\n| [`federation`](./packages/federation/) | ✅ | 0 | Again |",
  );
  const { findings } = auditPage(text, measuredOf());

  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /lists `federation` twice/);
});

test("a page that dropped a sentence fails instead of passing vacuously", () => {
  const text = PAGE.replace(
    "npm test              # 3 files, 2 tests",
    "npm test",
  );
  const { findings } = auditPage(text, measuredOf());

  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /no longer states npm test runs 3 files, 2 tests/,
  );
});

test("an unowned test file is a finding, because no row can describe it", () => {
  const measured = measure(
    reportOf([CORE, 2], [HEALTH, null], [FEDERATION, null], [LOOSE, 1]),
  );
  // The page has to be right about everything else, or the case would pass for
  // the wrong reason: nine findings would include the one under test.
  const page = PAGE.replaceAll(
    "2 test cases in 3 files",
    "3 test cases in 4 files",
  )
    .replace("reports 3 files and 2 tests", "reports 4 files and 3 tests")
    .replace("`test:unit`: 3 files /\n2;", "`test:unit`: 4 files /\n3;")
    .replace(
      "npm test              # 3 files, 2 tests",
      "npm test              # 4 files, 3 tests",
    );
  const { findings } = auditPage(page, measured);

  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /belongs to no package/);
  assert.match(findings[0].message, /operations\/src\/loose\.test\.ts/);
});

test("--write is what the fixture needs: it rewrites and reports how many numbers moved", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-counts-"));
  try {
    const page = join(dir, "README.md");
    const report = join(dir, "report.json");
    const wrong = PAGE.replace(
      "2 packages, 2 test cases in 3 files",
      "2 packages, 3 149 test cases in 146 files",
    ).replace(
      "| [`node`](./packages/node/) | ✅ | 2 |",
      "| [`node`](./packages/node/) | ✅ | 22 |",
    );
    writeFileSync(page, wrong);
    writeFileSync(
      report,
      JSON.stringify(reportOf([CORE, 2], [HEALTH, null], [FEDERATION, null])),
    );

    const lines = [];
    const code = run(["--write"], {
      page,
      report,
      log: (line) => lines.push(line),
    });

    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /rewrote 3 number\(s\)/);
    assert.match(lines[0], /README\.md$/);
    assert.equal(readFileSync(page, "utf8"), PAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing report is a failure, not a pass", () => {
  const errors = [];
  const code = run(["--report", join(tmpdir(), "does-not-exist.json")], {
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.match(errors.join("\n"), /no report at/);
  assert.match(errors.join("\n"), /run coverage/);
});

test("--report without a path is a usage error", () => {
  const errors = [];
  const code = run(["--report"], { error: (line) => errors.push(line) });

  assert.equal(code, 1);
  assert.deepEqual(errors, ["✗ test-counts: --report needs a path"]);
});

test("a page the run disagrees with exits non-zero and names the page", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-counts-"));
  try {
    const page = join(dir, "README.md");
    const report = join(dir, "report.json");
    writeFileSync(page, PAGE.replace("3 files, 2 tests", "3 files, 9 tests"));
    writeFileSync(
      report,
      JSON.stringify(reportOf([CORE, 2], [HEALTH, null], [FEDERATION, null])),
    );

    const errors = [];
    const code = run([], { page, report, error: (line) => errors.push(line) });

    assert.equal(code, 1);
    assert.match(errors[0], /1 finding\(s\)/);
    assert.match(errors[1], /README\.md:19 says `9` where the run reports `2`/);
    assert.match(errors.at(-1), /making a claim about a run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository's page still contains every sentence the gate reads", () => {
  const text = readFileSync(resolve(ROOT, "node/README.md"), "utf8");
  const measured = measuredOf();

  // Vacuity guard: a statement whose pattern matches nothing produces a finding
  // in the gate, but a statement whose pattern was *deleted from the gate* would
  // produce silence. These five anchors are the gate's contract with the page.
  for (const statement of statements(measured)) {
    assert.match(
      text,
      statement.pattern,
      `node/README.md no longer states ${statement.id}`,
    );
  }
});

test("the repository's table adds up to the totals the page states, by its own arithmetic", () => {
  const text = readFileSync(resolve(ROOT, "node/README.md"), "utf8");
  const rows = [
    ...text.matchAll(
      /^\|\s*\[`([a-z0-9-]+)`\]\(\.\/(?:packages|src)\/\1\/\)\s*\|[^|]*\|\s*([\d\s,]+?)\s*\|/gm,
    ),
  ];

  const sum = rows.reduce((total, row) => total + parseCount(row[2]), 0);
  const stated =
    /reports\s+(\d+)\s+files\s+and\s+([\d\s,]+?)\s+tests?,\s+0\s+failures/.exec(
      text,
    );
  assert.ok(stated, "the total sentence is gone from node/README.md");

  assert.equal(
    rows.length,
    20,
    "the table has one row per module: twenty directories under node/src",
  );
  assert.equal(
    sum,
    parseCount(stated[2]),
    "the rows add up to the stated total",
  );
});

test("--write on a page that is already right changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-counts-"));
  try {
    const page = join(dir, "README.md");
    const report = join(dir, "report.json");
    writeFileSync(page, PAGE);
    writeFileSync(
      report,
      JSON.stringify(reportOf([CORE, 2], [HEALTH, null], [FEDERATION, null])),
    );

    const lines = [];
    const code = run(["--write"], {
      page,
      report,
      log: (line) => lines.push(line),
    });

    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /✓ test-counts: 2 cases in 3 files/);
    assert.equal(readFileSync(page, "utf8"), PAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report with no test results is zero cases, not a crash", () => {
  // The `?? []` is the difference between a run that collected nothing and a gate
  // that threw: `vitest` omits `testResults` when every file failed to collect.
  const measured = measure({});
  assert.deepEqual(measured.total, { cases: 0, files: 0 });
  assert.equal(measured.packages.size, 0);
});

test("a page the caller supplies is named by the path the caller supplied", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-counts-page-"));
  try {
    const pagePath = join(dir, "README.md");
    const reportPath = join(dir, "test-report.json");
    // One number off, so the finding has to name the page it came from: a page
    // outside the repository named `operations/README.md` would send the reader to
    // a file the finding is not about.
    writeFileSync(
      pagePath,
      PAGE.replace("3 files and 2 tests", "4 files and 2 tests"),
    );
    writeFileSync(
      reportPath,
      JSON.stringify(reportOf([CORE, 2], [HEALTH, null], [FEDERATION, null])),
    );

    const errors = [];
    const code = run(["--report", reportPath], {
      page: pagePath,
      log: () => {},
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.match(errors[0], /✗ test-counts: 1 finding\(s\)/);
    assert.ok(
      errors.some((line) => line.includes(pagePath)),
      `a finding about a supplied page names that page, got: ${errors.join(" / ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default report path is this tree's report, and its absence names it", () => {
  // `--report` is the escape hatch; the path the gate takes with no arguments is
  // the one every reader of the log sees. Pointing the gate at a temporary tree is
  // the only way to assert it without asserting something about this checkout.
  const dir = mkdtempSync(join(tmpdir(), "test-counts-default-"));
  try {
    const errors = [];
    const code = run([], {
      root: dir,
      log: () => {},
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.match(errors[0], /no report at node\/coverage\/test-report\.json/);
    assert.match(errors[0], /writes one\.$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line is the command line: a missing report exits 1 and says what to run", () => {
  // The entry point is six lines no import can reach, and it is the half of the
  // gate a person actually runs. Spawning it is the only way to assert that the
  // exit code is 1 rather than an unhandled throw.
  //
  // The report path is named rather than assumed. Without it this case asserted
  // that the *working tree* has no `operations/coverage/test-report.json`, so it
  // passed in the Quality job, which never writes one, and failed in any tree
  // that had just run `pnpm coverage` — a red suite caused by a leftover file,
  // which is the least useful kind of red.
  const dir = mkdtempSync(join(tmpdir(), "test-counts-cli-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "scripts/check-test-counts.mjs"),
        "--report",
        join(dir, "test-report.json"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(child.status, 1);
    assert.match(child.stderr, /no report at .*test-report\.json/);
    assert.match(child.stderr, /writes one\.$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── A page that states one total ────────────────────────────────────────────

/** A package page in the shape `cluster/README.md` and `federation/README.md` use. */
const summaryPage = (cases, files) =>
  [
    "# Package",
    "",
    "| **Testing** | chaos, soak |",
    "",
    "## Testing",
    "",
    "```bash",
    `pnpm test                  # ${cases} tests, ${files} test files`,
    "```",
    "",
    `- **${files} test files, ${cases} tests** — unit, integration, chaos`,
    "",
  ].join("\n");

/** Two files, three cases: the numbers a page has to state to be right. */
const THREE_IN_TWO = {
  testResults: [
    {
      name: "/repo/cluster/src/raft/group.test.ts",
      assertionResults: [{}, {}],
    },
    { name: "/repo/cluster/src/raft/log.test.ts", assertionResults: [{}] },
  ],
};

test("a page with one total is checked in both places it states it", () => {
  const right = auditPage(summaryPage("3", "2"), measure(THREE_IN_TWO), {
    shapes: "summary",
  });
  assert.deepEqual(right.findings, []);

  // Each statement is wrong on its own, because a page being right in one place
  // is the shape that hides a wrong number in the other: the union check would
  // pass if either statement were read.
  const boldWrong = summaryPage("3", "2").replace(
    "- **2 test files, 3 tests**",
    "- **131 test files, 3 tests**",
  );
  const boldFindings = auditPage(boldWrong, measure(THREE_IN_TWO), {
    shapes: "summary",
  }).findings;

  assert.equal(boldFindings.length, 1);
  assert.match(boldFindings[0].message, /says `131` where the run reports `2`/);

  const commandWrong = summaryPage("3", "2").replace(
    "# 3 tests, 2 test files",
    "# 613 tests, 2 test files",
  );
  const commandFindings = auditPage(commandWrong, measure(THREE_IN_TWO), {
    shapes: "summary",
  }).findings;

  assert.equal(commandFindings.length, 1);
  assert.match(
    commandFindings[0].message,
    /says `613` where the run reports `3`/,
  );
});

test("a page with no module table is not asked for one", () => {
  // The table pass is the node page's contract. Running it over a package page
  // would report every module in the run as a row the page forgot — twenty
  // findings about a table the page never claimed to have.
  const { findings } = auditPage(summaryPage("3", "2"), measure(THREE_IN_TWO), {
    shapes: "summary",
  });

  assert.equal(
    findings.filter((finding) => /no row in the table/.test(finding.message))
      .length,
    0,
  );
});

test("a summary statement the page no longer carries is a finding", () => {
  const { findings } = auditPage(
    "# Package\n\nNo numbers here.\n",
    measure(THREE_IN_TWO),
    {
      shapes: "summary",
    },
  );

  assert.equal(findings.length, 2);
  assert.ok(
    findings.every((finding) => /no longer states/.test(finding.message)),
  );
});

test("every page in the table is audited, and a missing report names its own command", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-counts-targets-"));
  try {
    const node = join(dir, "node.md");
    const cluster = join(dir, "cluster.md");
    writeFileSync(node, summaryPage("3", "2"));
    writeFileSync(cluster, summaryPage("3", "2"));
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify(THREE_IN_TWO));

    const lines = [];
    const code = run([], {
      targets: [
        { page: node, report, shapes: "summary" },
        { page: cluster, report, shapes: "summary" },
      ],
      log: (line) => lines.push(line),
    });

    assert.equal(code, 0);
    assert.equal(
      lines.length,
      2,
      `one line per page, got ${lines.join(" / ")}`,
    );
    assert.match(lines[0], /✓ test-counts: .*node\.md says 3 cases in 2 files/);
    assert.match(
      lines[1],
      /✓ test-counts: .*cluster\.md says 3 cases in 2 files/,
    );

    const errors = [];
    const missing = run([], {
      targets: [
        { page: node, report, shapes: "summary" },
        { page: cluster, report: join(dir, "absent.json"), shapes: "summary" },
      ],
      error: (line) => errors.push(line),
    });

    assert.equal(missing, 1);
    assert.match(errors[0], /no report at/);
    assert.match(errors[0], /pnpm --filter @agentix-e\/db-.* run coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository's own table is every page that states a total", () => {
  assert.equal(TARGETS.length, 3);

  for (const target of TARGETS) {
    const text = readFileSync(resolve(ROOT, target.page), "utf8");
    const module = target.page.split("/")[0];
    const measured = measure({
      testResults: [
        { name: `/${module}/src/a.test.ts`, assertionResults: [{}] },
        { name: `/${module}/src/b.test.ts`, assertionResults: [{}] },
      ],
    });
    const shapes = statements(measured, target.shapes);

    assert.ok(
      shapes.length >= 2,
      `${target.page} declares a shape with ${shapes.length} statement(s)`,
    );
    for (const statement of shapes) {
      assert.ok(
        statement.pattern.test(text),
        `${target.page} no longer carries the sentence for \`${statement.id}\`, so the gate ` +
          `reads nothing there`,
      );
    }
  }
});
