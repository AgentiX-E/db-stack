#!/usr/bin/env node
/**
 * push-commit — mirror a local commit through the GitHub Git Data API.
 *
 * The sandbox's proxy allows only `api.github.com`, so a plain `git push` cannot
 * leave it. The tool this replaced lived at `.git/push_commit.py`: untracked,
 * unmeasured, and called only by the person who happened to be pushing. iteration
 * 98 made a push cite a preflight receipt; iteration 100 puts the tool that asks
 * for that receipt in the tree, where the same gates that cover every other script
 * cover it, and injects the API so its request sequence can be tested.
 *
 * The algorithm is deliberately unchanged: read the remote tip's tree, compare it
 * with HEAD's, upload only the blobs that differ, build a tree on the remote base,
 * create one commit with the local author and date, then move the branch ref. The
 * remote history is never rewritten. A fetch afterwards lets the next push start
 * from the mirrored commit rather than from a tree that differs only by sha.
 *
 * Usage: node scripts/push-commit.mjs <repo> <branch> <message-file> [--repo-dir <path>]
 * Env:   GITHUB_PAT, DB_PUSH_REPO_DIR
 *
 * The repository whose tree is mirrored is the one holding this tool by default,
 * but `--repo-dir` / `DB_PUSH_REPO_DIR` point a push at a second checkout. Without
 * that, mirroring a different repository would diff this tool's own tree against
 * the remote and upload the wrong files.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { run as checkReceipt } from "./check-push-receipt.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const API = "https://api.github.com";
export const OWNER = "AgentiX-E";

/**
 * The three arguments, and the message they will put on the commit.
 *
 * The old tool stripped trailing newlines with `rstrip('\n')`; a message file
 * written by a heredoc must not add blank lines to the commit, and the message
 * that reaches the API is the one `git log` will show.
 */
export function parseArguments(argv, read = readFileSync, env = process.env) {
  const args = [...argv];
  const flag = args.indexOf("--repo-dir");
  let repoDir = env.DB_PUSH_REPO_DIR;
  if (flag !== -1) {
    repoDir = args[flag + 1];
    if (!repoDir || repoDir.startsWith("--")) {
      throw new Error("--repo-dir needs a directory");
    }
    args.splice(flag, 2);
  }
  const [repo, branch, file] = args;
  if (!repo || !branch || !file) {
    throw new Error(
      "usage: push-commit.mjs <repo> <branch> <message-file> [--repo-dir <path>]",
    );
  }
  const message = String(read(file, "utf8")).replace(/\n+$/, "");
  if (message.length === 0) {
    throw new Error("the message file is empty — a commit needs a message");
  }
  return { repo, branch, file, message, repoDir };
}

/**
 * A `git ls-tree -r -z` stream as `path -> {mode, sha}`.
 *
 * Submodules have a `commit` kind and no blob to upload, and a truncated entry
 * without its tab is not a path at all. Both are skipped rather than guessed at:
 * an entry that cannot be named cannot be uploaded.
 */
export function parseTree(raw) {
  /** @type {Record<string, {mode: string, sha: string}>} */
  const out = {};
  for (const entry of String(raw).split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, kind, sha] = entry.slice(0, tab).split(" ");
    if (kind !== "blob" || !mode || !sha) continue;
    out[entry.slice(tab + 1)] = { mode, sha };
  }
  return out;
}

/** Which paths differ. A mode change with the same blob is not a new blob. */
export function diffTrees(local, remote) {
  const added = Object.keys(local).filter((path) => !(path in remote));
  const modified = Object.keys(local).filter(
    (path) => path in remote && remote[path].sha !== local[path].sha,
  );
  const removed = Object.keys(remote).filter((path) => !(path in local));
  return { added, modified, removed };
}

/** One identity, used for both author and committer, with the local commit's date. */
export function signature(date) {
  return {
    name: "Lambertyan",
    email: "lambertyan@users.noreply.github.com",
    date,
  };
}

/**
 * Whether another attempt is worth making.
 *
 * A 4xx is a request the server understood and refused; repeating it is noise.
 * A 5xx or a transport failure may be the proxy, so the call is retried until the
 * budget is spent. The last attempt is never retried — a gate that loops forever
 * is worse than one that reports the failure.
 */
export function shouldRetry(status, attempt, maxAttempts) {
  if (attempt >= maxAttempts - 1) return false;
  return status === undefined || [500, 502, 503, 504].includes(status);
}

/** The sinks, named so a test can replace them and the entry guard can be read. */
export function toStdout(line) {
  console.log(line);
}

export function toStderr(line) {
  console.error(line);
}

/** The real wait, named so it is a case rather than a line inside a default. */
export function defaultSleep(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

/**
 * The API boundary. A real `fetch`, with the token in a header rather than a URL.
 *
 * Every edge is injectable: the suite runs this against a local HTTP server, so
 * the headers, the retry sequence and the response parsing are exercised over a
 * real socket rather than by replacing `fetch` with a canned answer.
 */
export function makeTransport(deps = {}) {
  const token =
    deps.token ?? deps.env?.GITHUB_PAT ?? process.env.GITHUB_PAT ?? "";
  const api = deps.api ?? API;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? 6;
  const allowed = deps.retry ?? shouldRetry;

  return async function call(method, path, payload) {
    if (!token) throw new Error("GITHUB_PAT is not set");
    const url = path.startsWith("http") ? path : `${api}${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    let body;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
    }

    let attempt = 0;
    for (;;) {
      let retryable = true;
      try {
        const response = await fetchImpl(url, { method, headers, body });
        const text = await response.text();
        // A missing object is an answer, not a failure: the same call is used to
        // probe for refs on a branch that has not been created yet.
        if (response.status === 404) return null;
        if (response.ok) return text ? JSON.parse(text) : null;
        retryable = allowed(response.status, attempt, maxAttempts);
        if (!retryable) {
          throw new Error(`${method} ${path} -> ${response.status}\n${text}`);
        }
      } catch (error) {
        if (!retryable || attempt >= maxAttempts - 1) throw error;
      }
      attempt += 1;
      await sleep(2_000 * attempt);
    }
  };
}

/** One git invocation against the repository whose tree is being mirrored. */
function readGit(root, args, encoding) {
  return encoding
    ? execFileSync("git", args, { cwd: root, encoding })
    : execFileSync("git", args, { cwd: root });
}

/** git, as text and as bytes, from the repository root. The two edges a test owns. */
export function gitText(...args) {
  return readGit(ROOT, args, "utf8");
}

export function gitBytes(...args) {
  return readGit(ROOT, args);
}

/**
 * Readers bound to one repository. Every tree read goes through them: `ls-tree`
 * lists it, `cat-file` loads its blobs, `log` dates its commit and `fetch` updates
 * it after the push. A second repository never falls back to this tool's tree.
 */
function gitReaders(root) {
  return {
    text: (...args) => readGit(root, args, "utf8"),
    bytes: (...args) => readGit(root, args),
  };
}

/**
 * The whole push, with every edge injected.
 *
 * Approval comes first and is the tracked gate, not a copy of its rules. When it
 * refuses, no request is made: a tree that has not passed the static gates must
 * not get as far as creating a blob.
 */
/** The tracked gate, as the default approval a push has to earn. */
export function approveByReceipt() {
  return checkReceipt() === 0;
}

export async function push(input, deps = {}) {
  const approve = deps.approve ?? approveByReceipt;
  const call = deps.call ?? makeTransport({ token: deps.token });
  // An injected directory wins; the CLI's parsed one comes next; without either,
  // this tool stays in the repository that holds it.
  const root = deps.repoDir || input.repoDir || ROOT;
  const readers = gitReaders(root);
  const readText = deps.gitText ?? readers.text;
  const readBytes = deps.gitBytes ?? readers.bytes;
  const say = deps.say ?? toStdout;

  if (!approve()) return { ok: false, reason: "receipt" };

  const slug = `${OWNER}/${input.repo}`;
  const refPath = `/repos/${slug}/git/refs/heads/${input.branch}`;

  const ref = await call("GET", `/repos/${slug}/git/ref/heads/${input.branch}`);
  if (!ref)
    return { ok: false, reason: "no-branch", slug, branch: input.branch };
  const headSha = ref.object.sha;
  const headCommit = await call("GET", `/repos/${slug}/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;
  const listing = await call(
    "GET",
    `/repos/${slug}/git/trees/${baseTree}?recursive=1`,
  );
  /** @type {Record<string, {mode: string, sha: string}>} */
  const remote = {};
  for (const entry of listing.tree) {
    if (entry.type === "blob")
      remote[entry.path] = { mode: entry.mode, sha: entry.sha };
  }
  const local = parseTree(readText("ls-tree", "-r", "-z", "HEAD"));
  const { added, modified, removed } = diffTrees(local, remote);

  say(
    `remote tip ${headSha.slice(0, 7)}  added ${added.length}  ` +
      `modified ${modified.length}  removed ${removed.length}`,
  );
  if (added.length + modified.length + removed.length === 0) {
    say("tree is identical; nothing to push");
    return {
      ok: true,
      pushed: false,
      slug,
      branch: input.branch,
      commit: headSha,
    };
  }

  const entries = [];
  for (const path of [...added, ...modified]) {
    const { mode, sha } = local[path];
    const content = readBytes("cat-file", "blob", sha).toString("base64");
    const blob = await call("POST", `/repos/${slug}/git/blobs`, {
      content,
      encoding: "base64",
    });
    entries.push({ path, mode, type: "blob", sha: blob.sha });
  }
  for (const path of removed) {
    entries.push({ path, mode: remote[path].mode, type: "blob", sha: null });
  }

  const tree = await call("POST", `/repos/${slug}/git/trees`, {
    base_tree: baseTree,
    tree: entries,
  });
  const date = readText(
    "log",
    "-1",
    "--format=%cd",
    "--date=format:%Y-%m-%dT%H:%M:%S+08:00",
  ).trim();
  const author = signature(date);
  const commit = await call("POST", `/repos/${slug}/git/commits`, {
    message: input.message,
    tree: tree.sha,
    parents: [headSha],
    author,
    committer: author,
  });
  await call("PATCH", refPath, { sha: commit.sha, force: false });
  say(`pushed ${commit.sha.slice(0, 7)} to ${slug} ${input.branch}`);

  // Keep local git able to see the mirrored commit, so the next diff starts from
  // the remote tip rather than from a tree that has diverged by sha only.
  try {
    readText("fetch", "-q", "origin", input.branch);
  } catch (error) {
    say(`warning: fetch after push failed: ${error.message ?? error}`);
  }

  return {
    ok: true,
    pushed: true,
    slug,
    branch: input.branch,
    commit: commit.sha,
    added: added.length,
    modified: modified.length,
    removed: removed.length,
  };
}

/**
 * Whether this module was started as the program. Named so the last line is a case.
 */
export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

/** What a finished push looks like to the shell that started it. */
export function exitCodeFor(result) {
  return result.ok ? 0 : 1;
}

/** What a failed push says, and the status it leaves behind. */
export function reportFailure(error, err = toStderr) {
  err(error.message ?? error);
  return 1;
}

/**
 * The program, as a function: parse, approve, push, and answer with a status.
 *
 * Both outcomes are cases. A command whose only reachable outcome is refusal has
 * never been seen to approve anything, and the two lines at the bottom of a file
 * are the ones a suite that only imports it can never reach.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  try {
    const input = parseArguments(argv, deps.read, deps.env);
    const result = await push(input, deps);
    return exitCodeFor(result);
  } catch (error) {
    return reportFailure(error, deps.err ?? toStderr);
  }
}

if (isEntryPoint(process.argv[1])) {
  process.exitCode = await main();
}
