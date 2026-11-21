/**
 * The edit a Stryker report describes, as text.
 *
 * Both `replay-mutant.mjs` and `resolve-timeouts.mjs` need the same three things:
 * turn a report position into a string offset, splice a replacement into a file,
 * and put the file back. The splicing is the part that has to be identical in
 * both, because it is the part a near-miss hides in: the report's positions are
 * 1-based in both axes, and treating the column as 0-based — which is what
 * Stryker's own `Position` type says — shifts every replay one character to the
 * right. Iteration 30 drew conclusions from exactly that mistake.
 *
 * Kept separate from the callers so that "the tool applied the edit the report
 * named" is one implementation rather than two that agree by review.
 */

import fs from "node:fs";

/**
 * The absolute index of a 1-based line/column position.
 *
 * @param {string} text
 * @param {{ line: number, column: number }} position
 * @returns {number}
 */
export function offsetOf(text, { line, column }) {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf("\n", offset);
    if (next === -1)
      throw new Error(`line ${line} is past the end of the file`);
    offset = next + 1;
  }
  const lineEnd =
    text.indexOf("\n", offset) === -1
      ? text.length
      : text.indexOf("\n", offset);
  const absolute = offset + column - 1;
  if (absolute > lineEnd)
    throw new Error(`column ${column} is past the end of line ${line}`);
  return absolute;
}

/**
 * The text a mutant replaces and the text it puts in its place.
 *
 * `mutant.location.end` is exclusive, so the removed text is `[from, to)`. A
 * replacement that is already present at that range means the report and the
 * file disagree about the original — which is the signal that the report was
 * written against a different revision, not a reason to splice anyway.
 *
 * @param {string} text
 * @param {{ location: { start: { line: number, column: number }, end: { line: number, column: number } }, replacement?: string }} mutant
 * @returns {{ from: number, to: number, removed: string, replacement: string, updated: string }}
 */
export function splice(text, mutant) {
  const from = offsetOf(text, mutant.location.start);
  const to = offsetOf(text, mutant.location.end);
  const removed = text.slice(from, to);
  const replacement = mutant.replacement ?? "";
  return {
    from,
    to,
    removed,
    replacement,
    updated: text.slice(0, from) + replacement + text.slice(to),
  };
}

/**
 * Replace a file's contents, keeping a copy and the original mtime beside it.
 *
 * The mtime is part of what has to be put back: `replay-mutant.mjs` refuses a
 * report older than the file it describes, and writing the file moves its mtime
 * forward, so a restore that only copied the bytes back would make the next
 * replay of the same report fail its own freshness check.
 *
 * @param {string} path
 * @param {string} updated
 * @returns {{ restore: () => void }}
 */
export function replaceFile(path, updated) {
  const original = fs.readFileSync(path, "utf-8");
  const { mtimeMs } = fs.statSync(path);
  fs.writeFileSync(`${path}.replay.bak`, original);
  fs.writeFileSync(`${path}.replay.json`, `${JSON.stringify({ mtimeMs })}\n`);
  fs.writeFileSync(path, updated);

  let done = false;
  return {
    restore() {
      if (done) return;
      done = true;
      fs.writeFileSync(path, original);
      fs.utimesSync(path, new Date(), new Date(mtimeMs));
      for (const suffix of [".replay.bak", ".replay.json"]) {
        if (fs.existsSync(path + suffix)) fs.unlinkSync(path + suffix);
      }
    },
  };
}
