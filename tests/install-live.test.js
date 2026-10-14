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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync as realRename, rmSync, statSync, writeFileSync } from "node:fs";
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

  /** @param {string} version @param {Record<string, string>} [extra] @param {string} [distVersion] */
  const write = (version, extra = {}, distVersion = version) => {
    writeFileSync(path.join(work, "package.json"), `${JSON.stringify({ name: "agent-link", version }, null, 2)}\n`);
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
    ["a home path", { "docs/notes.md": "see /Users/realperson/work/x\n" }, /absolute home path \/Users\/realperson/],
    ["a linux home path", { "docs/notes.md": "see /home/realperson/work/x\n" }, /absolute home path \/home\/realperson/],
    ["a session path", { "docs/notes.md": "from /srv/data/.codex/sessions/2026/10/07/rollout-x.jsonl\n" }, /session path/],
    ["a committed wf-runs dir", { "docs/wf-runs/2026.md": "report\n" }, /forbidden directory wf-runs/],
    ["a transcript file", { "docs/rollout-2026-10-07T13-19-01-01a11760-2a3b-73e3-9838-aac3c6162070.jsonl": "{}\n" }, /session transcript file name/]
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
    });
  }
});

test("exports a clean tree with the dist, a marker, and no leaked paths", () => {
  const repo = makeRepo({ files: { "tests/fixture.json": "{\"cwd\":\"/Users/example/work/p\",\"t\":\"/home/user/.codex/sessions/2026/rollout-x\"}\n" } });
  withRepo(repo, () => {
    // Ignored local output sits in the work tree and must never be exported.
    mkdirSync(path.join(repo.work, "wf-runs", "suite"), { recursive: true });
    writeFileSync(path.join(repo.work, "wf-runs", "suite", "run.json"), "{\"cwd\":\"/Users/someone-real/x\"}\n");
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
    assert.ok(!everything.includes("someone-real"), "ignored wf-runs content must not appear");
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

test("swaps atomically and keeps exactly one .prev", () => {
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
    writeFileSync(path.join(dir, "b.txt"), "dir=-Users-realperson-src-thing\n");
    writeFileSync(path.join(dir, "ok.txt"), "dir=-Users-example-src-thing and /Users/example/x and /home/user/y\n");
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
