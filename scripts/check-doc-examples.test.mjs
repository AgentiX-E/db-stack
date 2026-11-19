/**
 * Tests for the fenced-example gate.
 *
 * The gate exists because a quick start told readers to call `health.register`,
 * `health.runAllChecks()` and `new InMemoryLogger({ level: 'info' })` — three
 * methods and an options object that do not exist — while the import check that
 * guarded the same block reported success. A gate is only worth its runtime if
 * it fails on those, so every case below is a tree that must produce a finding,
 * paired with the fragment shapes that must not (an undeclared name, a class
 * sketch, a block that builds on the prose).
 *
 * The last cases run over the real repository. They assert that pages were
 * actually found — a gate over zero pages reports perfect compliance — and that
 * the working tree passes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  auditExamples,
  documentedPages,
  exampleSource,
  run,
  sourceAliases,
} from "./check-doc-examples.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const MANIFEST = JSON.stringify({
  name: "@agentix-e/db-fixture",
  exports: { ".": { types: "./dist/index.d.ts" } },
});

const SOURCE = `
export class RaftGroup {
  constructor(private readonly id: string) {}
  propose(value: string): number {
    return value.length;
  }
}
export interface GroupOptions {
  id: string;
  peers?: number[];
}
export function describeGroup(options: GroupOptions): string {
  return options.id;
}
`;

/**
 * A throwaway workspace with one package and one page of documentation.
 *
 * `node_modules/@types` has to exist for the gate to find a place to write its
 * generated fragments; it is empty on purpose, so the fixture compiles with the
 * default libs and no ambient declarations.
 */
function fixture(page, { source = SOURCE } = {}) {
  const root = mkdtempSync(join(tmpdir(), "doc-examples-fixture-"));
  const files = {
    "node_modules/@types/.keep": "",
    "cluster/package.json": MANIFEST,
    "cluster/src/index.ts": source,
    "cluster/docs/api.md": page,
  };
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

/** Run the gate over a fixture tree and return its findings. */
function audit(root) {
  return auditExamples(documentedPages(root), root).findings;
}

const page = (code) => `# API\n\nProse that introduces the value.\n\n\`\`\`ts\n${code}\n\`\`\`\n`;

test("a method the type does not declare is a finding", (t) => {
  const root = fixture(
    page(
      `import { RaftGroup } from "@agentix-e/db-fixture";\nconst group = new RaftGroup("a");\ngroup.proposeTwice("x");`,
    ),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const findings = audit(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 2339);
  assert.match(findings[0].message, /proposeTwice/);
});

test("an argument the constructor cannot accept is a finding", (t) => {
  // The quick start's `new InMemoryLogger({ level: "info" })`: the constructor
  // takes a string, and no reader can tell from prose.
  const root = fixture(
    page(`import { RaftGroup } from "@agentix-e/db-fixture";\nconst group = new RaftGroup({ id: "a" });`),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const findings = audit(root);
  assert.equal(findings.length, 1);
  assert.ok([2345, 2554].includes(findings[0].code), `unexpected code ${findings[0].code}`);
});

test("an object literal with a key the type does not declare is a finding", (t) => {
  // `{ storage, schedule }` passed to a constructor that takes neither.
  const root = fixture(
    page(
      `import { describeGroup } from "@agentix-e/db-fixture";\ndescribeGroup({ id: "a", schedule: 1 });`,
    ),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const findings = audit(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 2353);
  assert.match(findings[0].message, /schedule/);
});

test("a required property the literal omits is a finding", (t) => {
  const root = fixture(
    page(`import { describeGroup } from "@agentix-e/db-fixture";\ndescribeGroup({ peers: [2] });`),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const findings = audit(root);
  assert.equal(findings.length, 1);
  assert.ok([2345, 2561].includes(findings[0].code), `unexpected code ${findings[0].code}`);
});

test("a name the block never declares is not a finding", (t) => {
  // Documentation snippets build on values the prose introduces. `storage` is
  // described above the block; the snippet cannot be judged about it, and an
  // undeclared name is not a claim.
  const root = fixture(
    page(
      `import { RaftGroup } from "@agentix-e/db-fixture";\nconst group = new RaftGroup(storage.id);\ngroup.propose(storage.value);`,
    ),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(audit(root), []);
});

test("a class sketch without method bodies is not a finding", (t) => {
  // Reference pages print signatures. `class RaftGroup { propose(v: string): number }`
  // is a declaration, not an implementation, and TypeScript says so three times
  // over; none of those complaints is a claim about the package.
  const root = fixture(
    page(
      `import type { GroupOptions } from "@agentix-e/db-fixture";\nclass Sketch {\n  private options: GroupOptions;\n  propose(value: string): number;\n  apply(entries: string[]): void;\n}`,
    ),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(audit(root), []);
});

test("blocks are judged one at a time, so a name reused later cannot misreport an earlier block", (t) => {
  // Both blocks are correct on their own. Concatenated, the second block's
  // `snapshot` is the first block's value, and the gate used to report a
  // `MetricsSnapshot` passed to a parameter that takes a `BackupMetadata` — a
  // defect of the gate's assembly, not of the page.
  const root = fixture(
    `# API\n\n\`\`\`ts\nimport { RaftGroup } from "@agentix-e/db-fixture";\nconst snapshot = new RaftGroup("a");\nsnapshot.propose("x");\n\`\`\`\n\n\`\`\`ts\nfor (const snapshot of inventory) {\n  snapshot.propose("y");\n}\n\`\`\`\n`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(audit(root), []);
});

test("the finding points at the line the reader sees", (t) => {
  const root = fixture(
    `# API\n\nProse.\n\n\`\`\`ts\nimport { RaftGroup } from "@agentix-e/db-fixture";\n\nconst group = new RaftGroup("a");\ngroup.proposeTwice("x");\n\`\`\`\n`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const findings = audit(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 9, "the call is on line 9 of the page");
  assert.equal(findings[0].file, join(root, "cluster", "docs", "api.md"));
});

test("a finding inside a multi-line import lands on its own line", (t) => {
  // Lifting imports to the top of a generated file is what makes a fragment a
  // module; a lifted import that keeps its line count is what keeps the map
  // honest. A three-line import mapped to one line shifted every finding after
  // it by two.
  const root = fixture(
    MANIFEST && `# API\n\n\`\`\`ts\nimport {\n  RaftGroup,\n  describeGroup,\n} from "@agentix-e/db-fixture";\n\nconst group = new RaftGroup("a");\ngroup.proposeTwice("x");\n\`\`\`\n`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const findings = audit(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 10, "the call is the tenth line of the page");
});

test("a fenced block in another language is not read", (t) => {
  const root = fixture(`# API\n\n\`\`\`bash\nnpm install @agentix-e/db-fixture\n\`\`\`\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(audit(root), []);
});

test("a page is read whole, so a later block is found too", () => {
  const fragment = exampleSource("page.md", page(`const a = 1;`) + page(`const b = 2;`));
  assert.ok(fragment.map.length >= 4, "both blocks contribute lines");
});

test("every published package maps its entry points to sources", () => {
  // A page is judged against the code, not against whatever `dist/` contained
  // when the gate ran, so the alias table has to point at `src/`.
  const aliases = sourceAliases(ROOT);
  assert.equal(aliases["@agentix-e/db-cluster"][0], "cluster/src/index.ts");
  assert.equal(aliases["@agentix-e/db-operations-core"][0], "operations/packages/core/src/index.ts");
  assert.ok(
    Object.keys(aliases).length >= 20,
    `expected the whole workspace, got ${Object.keys(aliases).length} entries`,
  );
});

test("the repository's own examples are all read", () => {
  const pages = documentedPages(ROOT);
  assert.ok(pages.length >= 50, `a gate over ${pages.length} pages is a gate over nothing`);
  assert.ok(pages.includes(resolve(ROOT, "docs", "user-guide", "operations.md")));
  assert.ok(pages.includes(resolve(ROOT, "operations", "packages", "monitor", "README.md")));
  assert.ok(pages.includes(resolve(ROOT, "operations", "README.md")));
});

test("the real repository's examples all type-check", () => {
  assert.equal(run(ROOT), 0);
});
