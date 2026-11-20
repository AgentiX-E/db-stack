import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import ts from "typescript";

const ROOT = "/workspace/db-stack";
const OPS = join(ROOT, "operations");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name.startsWith(".")
      )
        continue;
      walk(full, out);
    } else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = [
  ...walk(join(ROOT, "docs")),
  ...walk(join(ROOT, "cluster", "docs")),
  ...walk(join(ROOT, "federation", "docs")),
  ...walk(join(ROOT, "operations")),
].sort();

const BLOCK = /```(?:ts|typescript)\n([\s\S]*?)```/g;
const IMPORT =
  /^[ \t]*import\s+(?:type\s+)?[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm;

const out = "/tmp/snippet-probe";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const written = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const blocks = [...text.matchAll(BLOCK)].map((m) => m[1]);
  if (blocks.length === 0) continue;
  const imports = new Set();
  const bodies = [];
  for (const block of blocks) {
    let body = block;
    for (const m of body.matchAll(IMPORT)) imports.add(m[0].trim());
    body = body.replace(IMPORT, "").trim();
    if (body) bodies.push(body);
  }
  const name = relative(ROOT, file)
    .replace(/[\\/]/g, "__")
    .replace(/\.md$/, ".ts");
  const source = `${[...imports].join("\n")}\n\n${bodies.join("\n;\n")}\n`;
  writeFileSync(join(out, name), source, "utf8");
  written.push({ name, file: relative(ROOT, file) });
}

const { config } = ts.readConfigFile(
  join(OPS, "tsconfig.json"),
  ts.sys.readFile,
);
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, OPS);
const program = ts.createProgram({
  rootNames: written.map((w) => join(out, w.name)),
  options: { ...parsed.options, noEmit: true, strict: true },
});
const diagnostics = ts.getPreEmitDiagnostics(program);

const byCode = new Map();
for (const d of diagnostics) {
  byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
}
console.log("files", written.length, "diagnostics", diagnostics.length);
console.log(
  [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `TS${c} x${n}`)
    .join(", "),
);

const TIGHT = [2339, 2345, 2554, 2724, 2353, 2551, 2555, 2556, 2560, 2559];
const interesting = diagnostics.filter((d) => TIGHT.includes(d.code));
console.log("\ninteresting", interesting.length);
for (const d of interesting.slice(0, 60)) {
  const where = d.file ? relative(ROOT, d.file.fileName) : "?";
  const pos =
    d.file && d.start !== undefined
      ? d.file.getLineAndCharacterOfPosition(d.start)
      : null;
  const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
  console.log(
    `TS${d.code} ${where}${pos ? `:${pos.line + 1}` : ""} ${msg.slice(0, 160)}`,
  );
}
