// tests/install-live.test.js
// scripts/install-live.js installs from a clean `git archive` of a release tag.
// Every case builds a throwaway git repo with a bare "origin" in a temp
// directory, copies the script into it (the script exports from the repo it
// lives in), and installs into a temp target. Nothing here touches a real
// plugin folder, ~/.claude, ~/.codex or ~/.agent-link.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "./helpers/guard.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync as realRename, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./helpers/env.js";
import { MARKER_NAME, scanTree, swapIn } from "../scripts/install-live.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "scripts", "install-live.js");

const gitEnv = () => hermeticEnv({
  overrides: {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull
  }
});

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Path-shaped fixtures are built at runtime so this file holds no literal home
// path or session id: the release export scans every tracked file, this one too.
const REAL_USER = "realperson";
const macHome = (/** @type {string[]} */ ...rest) => ["", "Users", REAL_USER, ...rest].join("/");
const linuxHome = (/** @type {string[]} */ ...rest) => ["", "home", REAL_USER, ...rest].join("/");
const dashHome = () => ["", "Users", REAL_USER, "src", "thing"].join("-");
const uuid = (/** @type {string} */ tail) => ["2f9c41d7", "83ab", "4e61", "9d05", tail].join("-");
// An obviously fake timestamp, so the name can never be mistaken for a real transcript.
const rolloutName = () => `rollout-2999-01-01T00-00-00-${uuid("c3a81f60d2e4")}.jsonl`;
const volumesPath = (/** @type {string[]} */ ...rest) => ["", "Volumes", "SomeDisk", ...rest].join("/");
const varFolders = (/** @type {{ prefix?: string }} */ { prefix = "" } = {}) => `${prefix}${["", "var", "folders", "ab", "cd", "T", "x"].join("/")}`;
/** A UUIDv7 whose embedded millisecond timestamp is `ms`; the rest looks random (no zero run). */
const v7 = (/** @type {number} */ ms) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7c2e-8f41-5b6d7e8f9a0b`;
};

const distFor = (/** @type {string} */ version) =>
  `// fake bundle\nvar AGENT_LINK_VERSION = true ? "${version}" : readPackageVersion();\n`;

/**
 * A work repo with a bare origin. Release v1.2.3 is committed, tagged and
 * pushed to origin/main. Returns helpers for adding further commits and tags.
 */
function makeRepo({ files = {} } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-install-test-")));
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  mkdirSync(origin);
  git(origin, ["init", "--bare", "-b", "main"]);
  mkdirSync(path.join(work, "scripts"), { recursive: true });
  mkdirSync(path.join(work, "dist"), { recursive: true });
  git(work, ["init", "-b", "main"]);
  git(work, ["remote", "add", "origin", origin]);
  copyFileSync(SCRIPT, path.join(work, "scripts", "install-live.js"));
  writeFileSync(path.join(work, ".gitignore"), "wf-runs/\n.worktrees/\n");

  // "type": "module" like the real package.json: the copied script uses import
  // statements, which Node 20.9 rejects in a package without it.
  /** @param {string} version @param {Record<string, string>} [extra] @param {string} [distVersion] */
  const write = (version, extra = {}, distVersion = version) => {
    writeFileSync(path.join(work, "package.json"), `${JSON.stringify({ name: "agent-link", version, type: "module" }, null, 2)}\n`);
    writeFileSync(path.join(work, "dist", "server.mjs"), distFor(distVersion));
    writeFileSync(path.join(work, "README.md"), `readme ${version}\n`);
    for (const [rel, body] of Object.entries(extra)) {
      mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      writeFileSync(path.join(work, rel), body);
    }
  };
  const commit = (message = "c") => {
    git(work, ["add", "-A", "-f"]);
    git(work, ["commit", "-m", message]);
    return git(work, ["rev-parse", "HEAD"]);
  };

  write("1.2.3", files);
  commit("release 1.2.3");
  git(work, ["tag", "v1.2.3"]);
  git(work, ["push", "origin", "main", "--tags"]);

  const target = path.join(base, "plugins", "agent-link");
  mkdirSync(path.dirname(target));
  return {
    base, origin, work, target, write, commit,
    tag: (/** @type {string} */ name) => git(work, ["tag", name]),
    push: () => git(work, ["push", "origin", "main", "--tags"]),
    /** Runs the copy of the script that lives in the repo. */
    install(/** @type {string[]} */ args, { fetch = false } = {}) {
      const result = spawnSync(process.execPath, [path.join(work, "scripts", "install-live.js"), ...args, ...(fetch ? [] : ["--no-fetch"])], {
        cwd: work, env: gitEnv(), encoding: "utf8"
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    prevs: () => readdirSync(path.dirname(target)).filter((name) => name.startsWith("agent-link.prev-")),
    siblings: () => readdirSync(path.dirname(target)).sort(),
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}

/** @template T @param {ReturnType<typeof makeRepo>} repo @param {() => T} body */
function withRepo(repo, body) {
  try {
    return body();
  } finally {
    repo.cleanup();
  }
}

function listFiles(dir, rel = "") {
  const out = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    out.push(childRel);
    if (entry.isDirectory()) out.push(...listFiles(dir, childRel));
  }
  return out.sort();
}

test("refuses a dirty work tree and changes nothing", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    writeFileSync(path.join(repo.work, "README.md"), "locally edited\n");
    const before = repo.siblings();
    const result = repo.install(["--target", repo.target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /uncommitted tracked changes/);
    assert.match(result.stderr, /nothing was changed/);
    assert.deepEqual(repo.siblings(), before);
    assert.equal(existsSync(repo.target), false);
  });
});

test("refuses a tag that is not a vX.Y.Z release tag", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.tag("v1.2.3-rc1");
    repo.tag("v1.2");
    for (const tag of ["v1.2.3-rc1", "v1.2", "main", "1.2.3", "HEAD"]) {
      const result = repo.install(["--target", repo.target, "--tag", tag]);
      assert.notEqual(result.status, 0, tag);
      assert.match(result.stderr, /not a release tag of the form vX\.Y\.Z/, tag);
    }
    assert.equal(existsSync(repo.target), false);
  });
});

test("refuses a release tag that does not exist", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    const result = repo.install(["--target", repo.target, "--tag", "v9.9.9"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refused/);
    assert.equal(existsSync(repo.target), false);
  });
});

test("refuses a tag whose commit is not reachable from origin/main", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    git(repo.work, ["checkout", "-b", "side"]);
    repo.write("1.2.4");
    repo.commit("side release");
    repo.tag("v1.2.4");
    git(repo.work, ["push", "origin", "v1.2.4"]);
    git(repo.work, ["checkout", "main"]);
    for (const fetch of [false, true]) {
      const result = repo.install(["--target", repo.target, "--tag", "v1.2.4"], { fetch });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not reachable from origin\/main/);
    }
    assert.equal(existsSync(repo.target), false);
  });
});

test("refuses when package.json at the tag carries a different version", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.write("1.2.3", { "note.txt": "bumped the tag, not the version\n" });
    repo.commit("still says 1.2.3");
    repo.tag("v1.2.4");
    repo.push();
    const result = repo.install(["--target", repo.target, "--tag", "v1.2.4"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package\.json at v1\.2\.4 says version 1\.2\.3/);
    assert.equal(existsSync(repo.target), false);
  });
});

test("refuses when the built dist embeds a different version", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.write("1.2.4", {}, "1.2.3");
    repo.commit("stale dist");
    repo.tag("v1.2.4");
    repo.push();
    const result = repo.install(["--target", repo.target, "--tag", "v1.2.4"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dist\/server\.mjs embeds version 1\.2\.3/);
    assert.equal(existsSync(repo.target), false);
    assert.deepEqual(repo.siblings(), []);
  });
});

test("refuses an export that holds a local home path, wf-runs or a session transcript", () => {
  const cases = [
    ["a home path", { "docs/notes.md": `see ${macHome("work", "x")}\n` }, /docs\/notes\.md:1: absolute home path/],
    ["a linux home path", { "docs/notes.md": `see ${linuxHome("work", "x")}\n` }, /docs\/notes\.md:1: absolute home path/],
    ["an encoded home path", { "docs/notes.md": `dir ${dashHome()}\n` }, /docs\/notes\.md:1: encoded home path/],
    ["a session path", { "docs/notes.md": "from /srv/data/.codex/sessions/2026/10/07/x.jsonl\n" }, /docs\/notes\.md:1: session path/],
    ["a rollout name behind a tilde", { "docs/notes.md": `see ~/.codex/sessions/2026/10/07/${rolloutName()}\n` }, /docs\/notes\.md:1: session transcript file name/],
    ["a rollout name behind a placeholder home", { "docs/notes.md": `see /Users/example/.codex/sessions/2026/${rolloutName()}\n` }, /session transcript file name/],
    ["a labelled session id", { "docs/notes.md": `{"session_id":"${uuid("0a1b2c3d4e5f")}"}\n` }, /docs\/notes\.md:1: session or thread id/],
    ["a labelled thread id", { "docs/notes.md": `spike thread \`${uuid("0a1b2c3d4e5f")}\`\n` }, /session or thread id/],
    ["a camelCase threadId", { "docs/notes.md": `threadId = "${uuid("0a1b2c3d4e5f")}"\n` }, /session or thread id/],
    ["a Desktop local_ id", { "docs/notes.md": `id local_${uuid("0a1b2c3d4e5f")}\n` }, /session or thread id/],
    ["a /Volumes path", { "docs/notes.md": `build at ${volumesPath("Dev", "x")}\n` }, /machine-specific path/],
    ["a var-folders path under /private", { "docs/notes.md": `tmp ${varFolders({ prefix: "/private" })}\n` }, /machine-specific path/],
    ["a var-folders path without /private", { "docs/notes.md": `tmp ${varFolders()}\n` }, /machine-specific path/],
    ["a /Volumes path without a trailing slash", { "docs/notes.md": `disk ${volumesPath()}\n` }, /machine-specific path/],
    ["a current-era UUIDv7 with no label", { "docs/notes.md": `id ${v7(Date.UTC(2026, 5, 1))}\n` }, /current-era UUIDv7/],
    ["a space-separated 'session id' label", { "docs/notes.md": `session id ${uuid("0a1b2c3d4e5f")}\n` }, /session or thread id/],
    ["a backticked 'thread id' label", { "docs/notes.md": `thread id \`${uuid("0a1b2c3d4e5f")}\`\n` }, /session or thread id/],
    ["a 'Session-ID' label", { "docs/notes.md": `Session-ID: ${uuid("0a1b2c3d4e5f")}\n` }, /session or thread id/],
    ["a 'THREAD ID' label", { "docs/notes.md": `THREAD ID "${uuid("0a1b2c3d4e5f")}"\n` }, /session or thread id/],
    ["a conversation_id label", { "docs/notes.md": `{"conversation_id":"${uuid("0a1b2c3d4e5f")}"}\n` }, /session or thread id/],
    ["a conversationId label", { "docs/notes.md": `conversationId = '${uuid("0a1b2c3d4e5f")}'\n` }, /session or thread id/],
    ["a committed wf-runs dir", { "docs/wf-runs/2026.md": "report\n" }, /forbidden directory wf-runs/],
    ["a transcript file", { [`docs/${rolloutName()}`]: "{}\n" }, /session transcript file name/]
  ];
  for (const [label, files, pattern] of cases) {
    const repo = makeRepo({ files: /** @type {Record<string, string>} */ (files) });
    withRepo(repo, () => {
      const result = repo.install(["--target", repo.target]);
      assert.notEqual(result.status, 0, String(label));
      assert.match(result.stderr, /clean-tree scan/, String(label));
      assert.match(result.stderr, /** @type {RegExp} */ (pattern), String(label));
      assert.equal(existsSync(repo.target), false, String(label));
      assert.deepEqual(repo.siblings(), [], `${label}: no staging left behind`);
      for (const leaked of [REAL_USER, "SomeDisk", uuid("0a1b2c3d4e5f"), v7(Date.UTC(2026, 5, 1))]) {
        assert.ok(!result.stderr.includes(leaked), `${label}: the refusal must not echo ${leaked}`);
      }
    });
  }
});

test("exports a clean tree with the dist, a marker, and no leaked paths", () => {
  const repo = makeRepo({ files: { "tests/fixture.json": "{\"cwd\":\"/Users/example/work/p\",\"t\":\"/home/user/.codex/sessions/2026/rollout-x\"}\n" } });
  withRepo(repo, () => {
    // Ignored local output sits in the work tree and must never be exported.
    mkdirSync(path.join(repo.work, "wf-runs", "suite"), { recursive: true });
    writeFileSync(path.join(repo.work, "wf-runs", "suite", "run.json"), `{"cwd":"${macHome("x")}"}\n`);
    mkdirSync(path.join(repo.work, ".worktrees", "b1"), { recursive: true });
    writeFileSync(path.join(repo.work, ".worktrees", "b1", "f"), "x\n");

    const commit = git(repo.work, ["rev-parse", "v1.2.3^{commit}"]);
    const result = repo.install(["--target", repo.target], { fetch: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed v1\.2\.3/);
    assert.match(result.stdout, /codex plugin add codex-agent-link@<marketplace>/);

    const entries = listFiles(repo.target);
    for (const entry of entries) {
      for (const bad of [".git", ".worktrees", "wf-runs"]) {
        assert.ok(!entry.split("/").includes(bad), `${entry} must not be exported`);
      }
    }
    assert.ok(entries.includes("dist/server.mjs"));
    assert.ok(entries.includes("package.json"));
    assert.ok(entries.includes(MARKER_NAME));
    assert.deepEqual(scanTree(repo.target, { homeDir: os.homedir() }), []);
    const everything = entries
      .filter((entry) => !statSync(path.join(repo.target, entry)).isDirectory())
      .map((entry) => readFileSync(path.join(repo.target, entry), "utf8"))
      .join("\n");
    assert.ok(!everything.includes(REAL_USER), "ignored wf-runs content must not appear");
    assert.ok(!everything.includes(os.homedir()));

    const marker = JSON.parse(readFileSync(path.join(repo.target, MARKER_NAME), "utf8"));
    assert.deepEqual(Object.keys(marker).sort(), ["commit", "distSha256", "installedAt", "tag"]);
    assert.equal(marker.tag, "v1.2.3");
    assert.equal(marker.commit, commit);
    assert.equal(marker.distSha256, crypto.createHash("sha256").update(readFileSync(path.join(repo.target, "dist", "server.mjs"))).digest("hex"));
    assert.ok(!Number.isNaN(Date.parse(marker.installedAt)));
    assert.ok(!JSON.stringify(marker).includes(repo.base), "the marker names no user paths");
    assert.deepEqual(repo.siblings(), ["agent-link"], "no staging folder left behind");
  });
});

test("the default tag is the newest vX.Y.Z tag, ignoring pre-release tags", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.write("1.2.10");
    repo.commit("1.2.10");
    repo.tag("v1.2.10");
    repo.write("2.0.0");
    repo.commit("rc");
    repo.tag("v2.0.0-rc1");
    repo.push();
    const result = repo.install(["--target", repo.target]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(repo.target, MARKER_NAME), "utf8")).tag, "v1.2.10");
  });
});

test("swaps in two renames and keeps exactly one .prev", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.write("1.2.4");
    repo.commit("1.2.4");
    repo.tag("v1.2.4");
    repo.push();

    mkdirSync(repo.target);
    writeFileSync(path.join(repo.target, "old.txt"), "old install\n");

    assert.equal(repo.install(["--target", repo.target, "--tag", "v1.2.3"]).status, 0);
    assert.equal(repo.prevs().length, 1);
    assert.equal(readFileSync(path.join(repo.target, "README.md"), "utf8"), "readme 1.2.3\n");
    assert.equal(readFileSync(path.join(path.dirname(repo.target), repo.prevs()[0], "old.txt"), "utf8"), "old install\n");

    assert.equal(repo.install(["--target", repo.target, "--tag", "v1.2.4"]).status, 0);
    assert.equal(repo.prevs().length, 1, "older .prev removed");
    assert.equal(readFileSync(path.join(repo.target, "README.md"), "utf8"), "readme 1.2.4\n");
    const prevDir = path.join(path.dirname(repo.target), repo.prevs()[0]);
    assert.equal(readFileSync(path.join(prevDir, "README.md"), "utf8"), "readme 1.2.3\n", "the .prev is the install it replaced");
    assert.match(repo.prevs()[0], /^agent-link\.prev-\d{8}T\d{6}Z/);

    assert.equal(repo.install(["--target", repo.target, "--tag", "v1.2.3"]).status, 0);
    assert.equal(repo.prevs().length, 1);
    assert.deepEqual(repo.siblings().filter((name) => !name.startsWith("agent-link.prev-")), ["agent-link"]);
  });
});

test("keeps a git checkout target as .prev and never deletes it", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    mkdirSync(path.join(repo.target, ".git"), { recursive: true });
    writeFileSync(path.join(repo.target, "wip.txt"), "uncommitted work\n");

    const first = repo.install(["--target", repo.target]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /git checkout/);
    const [checkoutPrev] = repo.prevs();
    assert.ok(existsSync(path.join(path.dirname(repo.target), checkoutPrev, ".git")));
    assert.equal(existsSync(path.join(repo.target, ".git")), false);

    const second = repo.install(["--target", repo.target]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /git checkout; remove it yourself/);
    assert.ok(existsSync(path.join(path.dirname(repo.target), checkoutPrev, "wip.txt")), "the checkout survives later installs");
    assert.equal(repo.prevs().length, 2);
  });
});

test("swapIn rolls back when the second rename fails", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-swap-test-")));
  try {
    const target = path.join(base, "plugin");
    const staging = path.join(base, "plugin.staging");
    mkdirSync(target);
    mkdirSync(staging);
    writeFileSync(path.join(target, "live.txt"), "live\n");
    writeFileSync(path.join(staging, "new.txt"), "new\n");

    let calls = 0;
    const flaky = (/** @type {string} */ from, /** @type {string} */ to) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated rename failure");
      return realRename(from, to);
    };
    assert.throws(() => swapIn({ target, staging, rename: flaky }), /simulated rename failure/);
    assert.equal(readFileSync(path.join(target, "live.txt"), "utf8"), "live\n", "the live folder is back in place");
    assert.ok(existsSync(path.join(staging, "new.txt")), "staging is untouched");
    assert.deepEqual(readdirSync(base).sort(), ["plugin", "plugin.staging"], "no .prev left behind");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("swapIn reports where the previous install is if the rollback also fails", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-swap-test-")));
  try {
    const target = path.join(base, "plugin");
    const staging = path.join(base, "plugin.staging");
    mkdirSync(target);
    mkdirSync(staging);
    let calls = 0;
    const broken = (/** @type {string} */ from, /** @type {string} */ to) => {
      calls += 1;
      if (calls > 1) throw new Error(`rename ${calls} failed`);
      return realRename(from, to);
    };
    assert.throws(() => swapIn({ target, staging, rename: broken }), /rollback failed.*previous install is at .*plugin\.prev-/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--dry-run prints the plan and changes nothing", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    mkdirSync(repo.target);
    writeFileSync(path.join(repo.target, "old.txt"), "old install\n");
    const parentBefore = repo.siblings();
    const targetBefore = listFiles(repo.target);

    const result = repo.install(["--target", repo.target, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release:\s+v1\.2\.3/);
    assert.match(result.stdout, /Verified:\s+no \.git/);
    assert.match(result.stdout, /Dry run: nothing was changed/);
    assert.deepEqual(repo.siblings(), parentBefore);
    assert.deepEqual(listFiles(repo.target), targetBefore);
    assert.equal(readFileSync(path.join(repo.target, "old.txt"), "utf8"), "old install\n");

    rmSync(repo.target, { recursive: true });
    assert.equal(repo.install(["--target", repo.target, "--dry-run"]).status, 0);
    assert.deepEqual(repo.siblings(), []);
  });
});

test("--dry-run still refuses what a real run would refuse", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    const result = repo.install(["--target", repo.target, "--tag", "v1.2", "--dry-run"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a release tag/);
  });
});

test("refuses a missing --target, an unknown flag, and a target inside the repo", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    assert.notEqual(repo.install([]).status, 0);
    assert.match(repo.install([]).stderr, /--target <plugin-folder> is required/);
    assert.match(repo.install(["--target", repo.target, "--force"]).stderr, /Unknown argument: --force/);
    const inside = repo.install(["--target", path.join(repo.work, "out")]);
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /overlaps the repo/);
    const above = repo.install(["--target", repo.base]);
    assert.notEqual(above.status, 0);
    assert.match(above.stderr, /overlaps the repo/);
  });
});

test("scanTree flags this machine's home directory and encoded home paths", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-scan-test-")));
  try {
    writeFileSync(path.join(dir, "a.txt"), "cwd=/opt/builder/me\n");
    writeFileSync(path.join(dir, "b.txt"), `dir=${dashHome()}\n`);
    writeFileSync(path.join(dir, "ok.txt"), "dir=-Users-example-src-thing and /Users/example/x and /home/user/y and /home/you/z and -Users-you-a-b\n");
    const problems = scanTree(dir, { homeDir: "/opt/builder/me" });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.startsWith("a.txt:1") && /home directory/.test(p)));
    assert.ok(problems.some((p) => p.startsWith("b.txt:1") && /encoded home path/.test(p)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json exposes npm run install:live", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["install:live"], "node ./scripts/install-live.js");
});

test("with a fetch, origin decides the default tag; without one, local tags do", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.write("1.3.0");
    repo.commit("1.3.0");
    repo.tag("v1.3.0"); // local only: the commit is pushed, the tag is not
    git(repo.work, ["push", "origin", "main"]);

    const fetched = repo.install(["--target", repo.target], { fetch: true });
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(repo.target, MARKER_NAME), "utf8")).tag, "v1.2.3");

    const local = repo.install(["--target", repo.target]);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(repo.target, MARKER_NAME), "utf8")).tag, "v1.3.0");

    const explicit = repo.install(["--target", repo.target, "--tag", "v1.3.0"], { fetch: true });
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /Tag v1\.3\.0 is not on origin/);
  });
});

test("with a fetch, a local tag that points elsewhere than origin's is refused", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.write("1.2.3", { "note.txt": "later commit\n" });
    repo.commit("later");
    git(repo.work, ["push", "origin", "main"]);
    git(repo.work, ["tag", "-f", "v1.2.3", "HEAD"]); // moved locally, not on origin
    const result = repo.install(["--target", repo.target, "--tag", "v1.2.3"], { fetch: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /points at [0-9a-f]{12} locally but [0-9a-f]{12} on origin/);
    assert.equal(existsSync(repo.target), false);
  });
});

test("installs the tag's commit even when HEAD and the tag's package.json have moved on", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    repo.write("9.9.9", { "later.txt": "after the release\n" });
    repo.commit("main moved on");
    git(repo.work, ["push", "origin", "main"]);
    const result = repo.install(["--target", repo.target, "--tag", "v1.2.3"], { fetch: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(repo.target, "later.txt")), false);
    assert.equal(readFileSync(path.join(repo.target, "README.md"), "utf8"), "readme 1.2.3\n");
    assert.equal(JSON.parse(readFileSync(path.join(repo.target, MARKER_NAME), "utf8")).commit, git(repo.work, ["rev-parse", "v1.2.3^{commit}"]));
  });
});

test("removes stale staging folders from killed runs, but only on a real, accepted run", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    const parent = path.dirname(repo.target);
    const plant = () => {
      mkdirSync(path.join(parent, "agent-link.staging-dead1"));
      writeFileSync(path.join(parent, "agent-link.staging-dead1", "x"), "x\n");
      writeFileSync(path.join(parent, "agent-link.staging-dead2.tar"), "x\n");
      mkdirSync(path.join(parent, "other.staging-keep"));
    };
    plant();
    assert.notEqual(repo.install(["--target", repo.target, "--tag", "v1.2"]).status, 0);
    assert.equal(repo.siblings().filter((name) => name.includes(".staging-")).length, 3, "a refusal changes nothing");
    const dry = repo.install(["--target", repo.target, "--dry-run"]);
    assert.match(dry.stdout, /remove 2 stale agent-link\.staging-\* leftover/);
    assert.equal(repo.siblings().filter((name) => name.includes(".staging-")).length, 3, "a dry run changes nothing");
    const real = repo.install(["--target", repo.target]);
    assert.equal(real.status, 0, real.stderr);
    assert.deepEqual(repo.siblings(), ["agent-link", "other.staging-keep"]);
  });
});

test("a symlink target is refused with a message that says so", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    const real = path.join(path.dirname(repo.target), "real-plugin");
    mkdirSync(real);
    symlinkSync(real, repo.target);
    const result = repo.install(["--target", repo.target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is a symlink; pass the real plugin folder/);
    assert.deepEqual(readdirSync(real), []);
    assert.deepEqual(repo.siblings(), ["agent-link", "real-plugin"]);
  });
});

test("the plan and the summary call the swap two renames, not atomic", () => {
  const repo = makeRepo();
  withRepo(repo, () => {
    mkdirSync(repo.target);
    const dry = repo.install(["--target", repo.target, "--dry-run"]);
    assert.match(dry.stdout, /two renames \(not atomic; the target is briefly absent, and the first is rolled back if the second fails\)/);
    assert.doesNotMatch(dry.stdout, /atomically/i);
  });
});

test("scanTree: transcript names are never allowed outside tests/; placeholders and tests/ fixtures are", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-scan-test-")));
  try {
    mkdirSync(path.join(dir, "tests"));
    mkdirSync(path.join(dir, "docs"));
    const placeholder = "019a0000-0000-7000-8000-0000000000b1";
    writeFileSync(path.join(dir, "tests", "fixture.json"), `{"session_id":"${uuid("0a1b2c3d4e5f")}","t":"${rolloutName()}"}\n`);
    writeFileSync(path.join(dir, "docs", "ok.md"), `{"threadId":"${placeholder}"} and local_${placeholder}\n`);
    writeFileSync(path.join(dir, "docs", "bad.md"), `${rolloutName()}\n`);
    writeFileSync(path.join(dir, "docs", "bad2.md"), `/Users/example/.codex/sessions/${rolloutName()}\n`);
    writeFileSync(path.join(dir, "docs", "bad3.md"), "/srv/data/.claude/projects/-work/x.jsonl and ~/.codex/sessions/2026/x\n");
    const problems = scanTree(dir, { homeDir: "/nonexistent-home" });
    assert.deepEqual(problems.filter((p) => p.startsWith("tests/") || p.startsWith("docs/ok.md")), []);
    assert.ok(problems.includes("docs/bad.md:1: session transcript file name"));
    assert.ok(problems.includes("docs/bad2.md:1: session transcript file name"));
    assert.ok(!problems.includes("docs/bad2.md:1: session path"), "a placeholder home still allows the directory part");
    assert.deepEqual(problems.filter((p) => p.startsWith("docs/bad3.md")), ["docs/bad3.md:1: session path"], "only the non-tilde, non-placeholder path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed tree of this repo exports clean (no tracked file would make a release refuse itself)", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-head-scan-")));
  try {
    const archived = spawnSync("sh", ["-c", `git -C "${root}" archive HEAD | tar -x -C "${dir}"`], { encoding: "utf8" });
    if (archived.status !== 0) return t.skip("not a git checkout");
    assert.deepEqual(scanTree(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanTree: a UUIDv7 is flagged anywhere, including tests/, only when its timestamp is in the current era", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-v7-test-")));
  try {
    mkdirSync(path.join(dir, "tests"));
    const now = Date.UTC(2026, 9, 15);
    const cases = /** @type {[string, number, boolean][]} */ ([
      ["start of 2023", Date.UTC(2023, 0, 1), true],
      ["now", now, true],
      ["just under a year ahead", now + 365 * 24 * 3600 * 1000, true],
      ["more than a year ahead", now + 400 * 24 * 3600 * 1000, false],
      ["the far future", Date.UTC(2999, 0, 1), false],
      ["before 2023", Date.UTC(2022, 11, 31), false]
    ]);
    for (const [label, ms, flagged] of cases) {
      for (const where of ["docs/a.md", "tests/a.test.js"]) {
        mkdirSync(path.dirname(path.join(dir, where)), { recursive: true });
        writeFileSync(path.join(dir, where), `const ID = "${v7(ms)}";\n`);
        const problems = scanTree(dir, { homeDir: "/nonexistent-home", now }).filter((p) => p.startsWith(where));
        assert.equal(problems.length, flagged ? 1 : 0, `${label} in ${where}`);
        if (flagged) assert.match(problems[0], /current-era UUIDv7/);
      }
    }
    // Zero-run placeholders and non-v7 versions are exempt.
    writeFileSync(path.join(dir, "docs", "a.md"), "019a0000-0000-7000-8000-0000000000b1 and 2f9c41d7-83ab-4e61-9d05-0a1b2c3d4e5f\n");
    assert.deepEqual(scanTree(dir, { homeDir: "/nonexistent-home", now }).filter((p) => p.startsWith("docs/")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanTree: label variants and machine paths are caught outside tests/; machine paths inside tests/ too", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-label-test-")));
  try {
    mkdirSync(path.join(dir, "tests"));
    mkdirSync(path.join(dir, "docs"));
    const id = uuid("0a1b2c3d4e5f");
    const labels = ["session id ", "thread id `", "Session-ID: ", "THREAD ID \"", "conversation_id\":\"", "conversationId = '", "sessionId=", "Thread_Id ", "threadId: "];
    labels.forEach((label, i) => writeFileSync(path.join(dir, "docs", `l${i}.md`), `${label}${id}\n`));
    for (const [name, text] of /** @type {[string, string][]} */ ([
      ["v1.md", `see ${varFolders()}\n`],
      ["v2.md", `see ${varFolders({ prefix: "/private" })}\n`],
      ["v3.md", `see ${volumesPath()}\n`],
      ["v4.md", `see ${volumesPath("x")}\n`]
    ])) {
      writeFileSync(path.join(dir, "docs", name), text);
      writeFileSync(path.join(dir, "tests", name), text);
    }
    writeFileSync(path.join(dir, "tests", "labelled.test.js"), `const a = "session id ${id}";\n`);
    const problems = scanTree(dir, { homeDir: "/nonexistent-home" });
    labels.forEach((label, i) => assert.ok(problems.includes(`docs/l${i}.md:1: session or thread id`), `label ${JSON.stringify(label)}`));
    for (const name of ["v1.md", "v2.md", "v3.md", "v4.md"]) {
      assert.ok(problems.includes(`docs/${name}:1: machine-specific path`), `docs/${name}`);
      assert.ok(problems.includes(`tests/${name}:1: machine-specific path`), `tests/${name}`);
    }
    assert.ok(!problems.some((p) => p.startsWith("tests/labelled.test.js")), "random v4 ids labelled in test files stay allowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
