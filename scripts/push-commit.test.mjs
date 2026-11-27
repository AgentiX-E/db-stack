/**
 * Tests for the in-tree Git Data API push.
 *
 * The tool previously lived in `.git/push_commit.py`, where no gate could see it,
 * no test could import it, and the only way to know what it did was to run a push.
 * Everything in it that makes a decision is a function here, and the network is a
 * injected boundary: the transport cases run against a real local HTTP server, and
 * the orchestration cases hand it a recorded sequence of calls. No case asserts that
 * "an error was thrown" — each names the refusal or the request it earned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  OWNER,
  approveByReceipt,
  defaultSleep,
  diffTrees,
  exitCodeFor,
  gitBytes,
  gitText,
  isEntryPoint,
  main,
  makeTransport,
  parseArguments,
  parseTree,
  push,
  reportFailure,
  shouldRetry,
  signature,
  toStderr,
  toStdout,
} from "./push-commit.mjs";

/** A real HTTP server that answers the small subset of the API the tool uses. */
async function withServer(handler, body) {
  const server = createServer(handler);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await body(base);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

/** A message file in a temporary directory, removed after the case. */
function withMessage(text, body) {
  const dir = mkdtempSync(join(tmpdir(), "push-commit-"));
  const path = join(dir, "message.txt");
  writeFileSync(path, text, "utf8");
  try {
    return body(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("arguments name a repository, a branch and a message file", () => {
  withMessage("docs(it-100): the push, in the tree\n\n", (path) => {
    const input = parseArguments(["db-stack-docs", "main", path]);
    assert.equal(input.repo, "db-stack-docs");
    assert.equal(input.branch, "main");
    // Every trailing newline goes, exactly as the old rstrip('\n') did.
    assert.equal(input.message, "docs(it-100): the push, in the tree");
  });
});

test("a missing argument is a usage error, not an undefined field", () => {
  assert.throws(
    () => parseArguments(["db-stack", "master"]),
    /usage: push-commit\.mjs <repo> <branch> <message-file>/,
  );
});

test("an empty message is refused before any request is made", () => {
  withMessage("\n\n", (path) => {
    assert.throws(
      () => parseArguments(["db-stack", "master", path]),
      /the message file is empty — a commit needs a message/,
    );
  });
});

test("a tree read is parsed by path, mode and blob id", () => {
  const raw =
    "100644 blob 1111111111111111111111111111111111111111\tREADME.md\0" +
    "100755 blob 2222222222222222222222222222222222222222\tbin/tool.mjs\0" +
    "160000 commit 3333333333333333333333333333333333333333\tsubmodule\0" +
    "100644 blob 4444444444444444444444444444444444444444 no-tab-here";
  assert.deepEqual(parseTree(raw), {
    "README.md": { mode: "100644", sha: "1".repeat(40) },
    "bin/tool.mjs": { mode: "100755", sha: "2".repeat(40) },
  });
});

test("a tree with no blobs is an empty tree, not an error", () => {
  assert.deepEqual(parseTree(""), {});
});

test("the three kinds of tree difference are disjoint", () => {
  const local = {
    a: { mode: "100644", sha: "new-a" },
    b: { mode: "100644", sha: "same" },
    c: { mode: "100644", sha: "new-c" },
  };
  const remote = {
    b: { mode: "100644", sha: "same" },
    c: { mode: "100644", sha: "old-c" },
    d: { mode: "100644", sha: "old-d" },
  };
  assert.deepEqual(diffTrees(local, remote), {
    added: ["a"],
    modified: ["c"],
    removed: ["d"],
  });
});

test("an identical tree has no entries to push", () => {
  const tree = { a: { mode: "100644", sha: "x" } };
  assert.deepEqual(diffTrees(tree, tree), {
    added: [],
    modified: [],
    removed: [],
  });
});

test("the signature is stable and keeps the commit's own timezone", () => {
  const date = "2026-11-27T20:24:33+08:00";
  assert.deepEqual(signature(date), {
    name: "Lambertyan",
    email: "lambertyan@users.noreply.github.com",
    date,
  });
});

test("retry is allowed for transport failures and 5xx, never for a client error", () => {
  assert.equal(shouldRetry(500, 0, 6), true);
  assert.equal(shouldRetry(502, 4, 6), true);
  assert.equal(shouldRetry(404, 0, 6), false);
  assert.equal(shouldRetry(422, 0, 6), false);
  assert.equal(shouldRetry(undefined, 0, 6), true);
  assert.equal(shouldRetry(500, 5, 6), false);
});

test("the transport carries the token and returns a parsed response", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(req.headers.accept, "application/vnd.github+json");
      assert.equal(req.headers["x-github-api-version"], "2022-11-28");
      assert.equal(req.headers["content-type"], "application/json");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sha: "abc" }));
    },
    async (base) => {
      const call = makeTransport({
        token: "test-token",
        api: base,
        fetchImpl: globalThis.fetch,
      });
      assert.deepEqual(
        await call("POST", "/repos/a/b/git/blobs", { content: "eA==" }),
        { sha: "abc" },
      );
    },
  );
});

test("a 404 and an empty body answer null, and an absolute URL is used as given", async () => {
  let seen = "";
  await withServer(
    (req, res) => {
      seen = req.url;
      res.writeHead(404);
      res.end();
    },
    async (base) => {
      const call = makeTransport({
        token: "t",
        api: base,
        fetchImpl: globalThis.fetch,
        retry: () => false,
      });
      assert.equal(await call("GET", `${base}/absolute`), null);
      assert.equal(seen, "/absolute");
    },
  );
});

test("a 5xx is retried and a later success is returned", async () => {
  let attempts = 0;
  await withServer(
    (req, res) => {
      attempts += 1;
      res.writeHead(attempts === 1 ? 503 : 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ sha: "after-retry" }));
    },
    async (base) => {
      const call = makeTransport({
        token: "t",
        api: base,
        fetchImpl: globalThis.fetch,
        sleep: async () => {},
      });
      assert.deepEqual(await call("GET", "/x"), { sha: "after-retry" });
      assert.equal(attempts, 2);
    },
  );
});

test("a client error is not retried and names the request", async () => {
  let attempts = 0;
  await withServer(
    (req, res) => {
      attempts += 1;
      res.writeHead(422);
      res.end("bad tree");
    },
    async (base) => {
      const call = makeTransport({
        token: "t",
        api: base,
        fetchImpl: globalThis.fetch,
      });
      await assert.rejects(call("POST", "/x", {}), /POST \/x -> 422\nbad tree/);
      assert.equal(attempts, 1);
    },
  );
});

test("a transport failure is retried until the attempt budget is spent", async () => {
  let attempts = 0;
  await withServer(
    (req, res) => {
      attempts += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
    async (base) => {
      const call = makeTransport({
        token: "t",
        api: base,
        maxAttempts: 3,
        sleep: async () => {},
        fetchImpl: async () => {
          throw new Error("tunnel closed");
        },
      });
      await assert.rejects(call("GET", "/x"), /tunnel closed/);
      assert.equal(attempts, 0);
    },
  );
});

/** The edges of `push`, recorded so the whole request sequence can be asserted. */
function harness({
  local = {},
  remote = {},
  date = "2026-11-27T20:24:33+08:00",
} = {}) {
  const calls = [];
  const gitCalls = [];
  const said = [];
  const remoteRef = "a".repeat(40);
  const baseTree = "b".repeat(40);
  const entries = Object.entries(remote).map(([path, entry]) => ({
    path,
    mode: entry.mode,
    sha: entry.sha,
    type: "blob",
  }));

  const call = async (method, path, payload) => {
    calls.push({ method, path, payload });
    if (method === "GET" && path.includes("/git/ref/heads/"))
      return { object: { sha: remoteRef } };
    if (method === "GET" && path.includes("/git/commits/"))
      return { tree: { sha: baseTree } };
    if (method === "GET" && path.includes(`/git/trees/${baseTree}`))
      return { tree: entries };
    if (method === "POST" && path.endsWith("/git/blobs"))
      return { sha: `blob-${calls.length}` };
    if (method === "POST" && path.endsWith("/git/trees"))
      return { sha: "c".repeat(40) };
    if (method === "POST" && path.endsWith("/git/commits"))
      return { sha: "d".repeat(40) };
    return {};
  };

  const treeRaw = Object.entries(local)
    .map(([path, e]) => `${e.mode} blob ${e.sha}\t${path}`)
    .join("\0");
  const gitText = (...args) => {
    gitCalls.push(args.join(" "));
    if (args[0] === "ls-tree") return treeRaw;
    if (args[0] === "log") return date;
    return "";
  };
  const gitBytes = (sha) => Buffer.from(`bytes of ${sha}`);

  return {
    calls,
    gitCalls,
    said,
    call,
    gitText,
    gitBytes,
    deps: {
      call,
      gitText,
      gitBytes,
      say: (line) => said.push(line),
      approve: () => true,
    },
  };
}

test("a tree without a receipt is refused before a single request", async () => {
  const h = harness();
  const result = await push(
    { repo: "db-stack", branch: "master", message: "m" },
    { ...h.deps, approve: () => false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "receipt");
  assert.deepEqual(h.calls, []);
});

test("an identical tree reports nothing to push and never creates a commit", async () => {
  const same = { "README.md": { mode: "100644", sha: "same" } };
  const h = harness({ local: same, remote: same });
  const result = await push(
    { repo: "db-stack", branch: "master", message: "m" },
    h.deps,
  );
  assert.equal(result.ok, true);
  assert.equal(result.pushed, false);
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
  assert.match(h.said.join("\n"), /tree is identical; nothing to push/);
});

test("a push mirrors the tree and points the branch at the new commit", async () => {
  const local = {
    "README.md": { mode: "100644", sha: "new-readme" },
    "bin/tool.mjs": { mode: "100755", sha: "tool" },
  };
  const remote = {
    "README.md": { mode: "100644", sha: "old-readme" },
    "old.txt": { mode: "100644", sha: "old" },
  };
  const h = harness({ local, remote });
  const input = { repo: "db-stack", branch: "main", message: "feat: once\n" };

  const result = await push(input, h.deps);

  assert.deepEqual(result, {
    ok: true,
    pushed: true,
    slug: `${OWNER}/db-stack`,
    branch: "main",
    commit: "d".repeat(40),
    added: 1,
    modified: 1,
    removed: 1,
  });

  // The order is the contract: blobs first, then the tree, then the commit, then
  // the ref. A ref moved before its commit exists is a broken branch.
  assert.deepEqual(
    h.calls.map(
      (c) => `${c.method} ${c.path.replace(/^\/repos\/[^/]+\/[^/]+/, "")}`,
    ),
    [
      "GET /git/ref/heads/main",
      "GET /git/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "GET /git/trees/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?recursive=1",
      "POST /git/blobs",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/main",
    ],
  );

  const treeBody = h.calls.find((c) => c.path.endsWith("/git/trees")).payload;
  assert.equal(treeBody.base_tree, "b".repeat(40));
  assert.deepEqual(treeBody.tree, [
    { path: "bin/tool.mjs", mode: "100755", type: "blob", sha: "blob-4" },
    { path: "README.md", mode: "100644", type: "blob", sha: "blob-5" },
    { path: "old.txt", mode: "100644", type: "blob", sha: null },
  ]);

  const commitBody = h.calls.find((c) =>
    c.path.endsWith("/git/commits"),
  ).payload;
  assert.equal(commitBody.message, "feat: once\n");
  assert.equal(commitBody.tree, "c".repeat(40));
  assert.deepEqual(commitBody.parents, ["a".repeat(40)]);
  assert.equal(commitBody.author.name, "Lambertyan");
  assert.equal(commitBody.author.date, "2026-11-27T20:24:33+08:00");
  assert.deepEqual(commitBody.committer, commitBody.author);

  const refBody = h.calls.find((c) => c.method === "PATCH").payload;
  assert.deepEqual(refBody, { sha: "d".repeat(40), force: false });
  assert.ok(h.gitCalls.some((c) => c.startsWith("fetch -q origin main")));
  assert.match(h.said.join("\n"), /pushed ddddddd to AgentiX-E\/db-stack main/);
});

test("a failed fetch after the push is a warning, not a failed push", async () => {
  const local = { a: { mode: "100644", sha: "x" } };
  const h = harness({ local });
  const gitText = (...args) => {
    if (args[0] === "fetch") throw new Error("no tracking ref");
    return h.gitText(...args);
  };
  const result = await push(
    { repo: "db-stack", branch: "main", message: "m" },
    { ...h.deps, gitText },
  );
  assert.equal(result.ok, true);
  assert.equal(result.pushed, true);
  assert.match(
    h.said.join("\n"),
    /warning: fetch after push failed: no tracking ref/,
  );
});

test("the entry check knows when it is not the program", () => {
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint(""), false);
  assert.equal(isEntryPoint("/nowhere/else.mjs"), false);
  assert.equal(
    isEntryPoint(resolve(import.meta.dirname, "push-commit.mjs")),
    true,
  );
});

test("git is read from the real repository, as text and as bytes", () => {
  const commit = gitText("rev-parse", "HEAD").trim();
  assert.match(commit, /^[0-9a-f]{40}$/);
  const blob = gitText("rev-parse", "HEAD:package.json").trim();
  assert.ok(gitBytes("cat-file", "blob", blob).length > 0);
});

test("a missing token refuses before a request is made", async () => {
  const call = makeTransport({ token: "", env: {} });
  await assert.rejects(call("GET", "/x"), /GITHUB_PAT is not set/);
});

test("the token may come from the environment and every other default is real", () => {
  // No token argument: the env branch of the chain has to supply it. No api,
  // fetch, sleep, attempt budget or retry predicate either — all defaults run.
  const call = makeTransport({ env: { GITHUB_PAT: "env-token" } });
  assert.equal(typeof call, "function");
});

test("an empty successful body answers null, not a parse error", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end();
    },
    async (base) => {
      const call = makeTransport({ token: "t", api: base });
      assert.equal(await call("GET", "/x"), null);
    },
  );
});

test("the tracked receipt gate is the default approval, and it answers here", () => {
  assert.equal(typeof approveByReceipt(), "boolean");
});

test("the default fetch and wait are the real implementation", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    },
    async (base) => {
      // No fetchImpl and no sleep injected: both defaults execute here.
      const call = makeTransport({ token: "t", api: base });
      assert.deepEqual(await call("GET", "/x"), { ok: true });
    },
  );
  await defaultSleep(1);
});

test("a branch that does not exist is refused without creating anything", async () => {
  const h = harness();
  const call = (method, path, payload) =>
    path.includes("/git/ref/heads/") ? null : h.call(method, path, payload);
  const result = await push(
    { repo: "db-stack", branch: "main", message: "m" },
    { ...h.deps, call },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "no-branch",
    slug: `${OWNER}/db-stack`,
    branch: "main",
  });
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
});

test("the program answers zero for an approved push and one for a refusal", async () => {
  withMessage("feat: once\n", async (path) => {
    const h = harness({ local: { a: { mode: "100644", sha: "x" } } });
    const ok = await main(["db-stack", "main", path], h.deps);
    assert.equal(ok, 0);
    const refused = await main(["db-stack", "main", path], {
      ...h.deps,
      approve: () => false,
    });
    assert.equal(refused, 1);
  });
});

test("a bad argument list is named by the program, with a failing status", () => {
  const child = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "push-commit.mjs"), "only-repo"],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /usage: push-commit\.mjs/);
});

test("a non-blob remote entry is not a file to upload", async () => {
  const h = harness({ local: { a: { mode: "100644", sha: "x" } } });
  const call = async (method, path, payload) => {
    const answer = await h.call(method, path, payload);
    if (method === "GET" && path.includes("/git/trees/")) {
      return {
        tree: [
          { path: "a-directory", mode: "040000", sha: "dir", type: "tree" },
          ...answer.tree,
        ],
      };
    }
    return answer;
  };
  const result = await push(
    { repo: "db-stack", branch: "main", message: "m" },
    { ...h.deps, call },
  );
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0);
  assert.ok(h.gitCalls.every((c) => !c.includes("a-directory")));
});

test("a warning without a message still says what failed", async () => {
  class NoMessage extends Error {
    constructor() {
      super();
      this.message = undefined;
    }
  }
  const h = harness({ local: { a: { mode: "100644", sha: "x" } } });
  const gitText = (...args) => {
    if (args[0] === "fetch") throw new NoMessage();
    return h.gitText(...args);
  };
  const result = await push(
    { repo: "db-stack", branch: "main", message: "m" },
    { ...h.deps, gitText },
  );
  assert.equal(result.pushed, true);
  assert.match(h.said.join("\n"), /warning: fetch after push failed: /);
});

test("the default git readers, transport, stdout and stderr are used when absent", async () => {
  const realTree = parseTree(gitText("ls-tree", "-r", "-z", "HEAD"));
  const entries = Object.entries(realTree)
    .slice(1)
    .map(([path, entry]) => ({
      path,
      mode: entry.mode,
      sha: entry.sha,
      type: "blob",
    }));
  const call = async (method, path) => {
    if (method === "GET" && path.includes("/git/ref/heads/"))
      return { object: { sha: "a".repeat(40) } };
    if (method === "GET" && path.includes("/git/commits/"))
      return { tree: { sha: "b".repeat(40) } };
    if (method === "GET" && path.includes("/git/trees/"))
      return { tree: entries };
    return { sha: "c".repeat(40) };
  };
  const said = [];
  const originalLog = console.log;
  console.log = (line) => said.push(line);
  try {
    const result = await push(
      { repo: "db-stack", branch: "main", message: "m" },
      { approve: () => true, call },
    );
    assert.equal(result.pushed, true);
    assert.match(said.join("\n"), /remote tip/);
    // No call or git readers were injected; the real ones ran over this repo.
    await assert.rejects(
      push(
        { repo: "db-stack", branch: "main", message: "m" },
        { approve: () => true, token: "" },
      ),
      /GITHUB_PAT is not set/,
    );
  } finally {
    console.log = originalLog;
  }
});

test("the sinks and the shell statuses are observable", () => {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => lines.push(["out", line]);
  console.error = (line) => lines.push(["err", line]);
  try {
    toStdout("a");
    toStderr("b");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(lines, [
    ["out", "a"],
    ["err", "b"],
  ]);
  assert.equal(exitCodeFor({ ok: true }), 0);
  assert.equal(exitCodeFor({ ok: false }), 1);
  const spy = (line) => lines.push(["err", line]);
  assert.equal(reportFailure(new Error("boom"), spy), 1);
  assert.equal(reportFailure("plain", spy), 1);
  assert.deepEqual(lines.at(-2), ["err", "boom"]);
  assert.deepEqual(lines.at(-1), ["err", "plain"]);
});
