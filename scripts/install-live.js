#!/usr/bin/env node
// Installs Agent Link into a plugin folder from a clean export of a release tag.
//
//   npm run install:live -- --target <plugin-folder> [--tag vX.Y.Z] [--dry-run] [--no-fetch]
//
// Claude's directory marketplace runs the plugin straight from a folder, and
// Codex's local marketplace copies that folder into its plugin cache. Both take
// the WHOLE folder and ignore .gitignore, so a git clone there leaks .git,
// .worktrees/ and ignored wf-runs/ output (local paths, session ids). This
// script builds the folder from `git archive <tag>` instead, so it holds only
// tracked files, then swaps it in with two same-volume renames.
//
// It refuses (exit 1, nothing changed) unless the repo it runs from is clean,
// the tag is a vX.Y.Z release tag reachable from origin/main, and package.json
// at the tag carries that version. It never runs the host-side steps; it prints
// them.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MARKER_NAME = ".agent-link-install.json";
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const FORBIDDEN_NAMES = new Set([".git", ".worktrees", "wf-runs"]);
// Placeholder users the repo's own fixtures and tests use. A real machine's
// home path never matches one of these.
const SYNTHETIC_USERS = new Set(["example", "x", "me", "someone", "user"]);
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
const DASH_HOME_PATH = /-Users-([A-Za-z0-9_.]+)-/g;
const SESSION_PATH = /(?:\.codex\/sessions\/|\.claude\/projects\/)[^\s"'`)]*|rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SESSION_PATH_NAME = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f-]{36}\.jsonl$/;

export class Refusal extends Error {}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const parsed = { target: null, tag: null, dryRun: false, fetch: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target" || arg === "--tag") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Refusal(`${arg} requires a value`);
      if (arg === "--target") parsed.target = value;
      else parsed.tag = value;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--no-fetch") {
      parsed.fetch = false;
    } else {
      throw new Refusal(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.target) throw new Refusal("--target <plugin-folder> is required");
  return parsed;
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
function git(args, { cwd = repoRoot } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Refusal(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

/**
 * Checks everything that must hold before anything is exported. Throws Refusal.
 * @param {{ tag: string | null, fetch: boolean }} options
 * @param {string} [cwd]
 * @returns {{ tag: string, commit: string, version: string }}
 */
export function checkRelease({ tag, fetch }, cwd = repoRoot) {
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], { cwd }).trim();
  if (dirty) throw new Refusal(`The repo has uncommitted tracked changes; commit or discard them first:\n${dirty}`);

  if (fetch) git(["fetch", "origin"], { cwd });

  let chosen = tag;
  if (!chosen) {
    chosen = git(["tag", "--list", "v*", "--sort=-v:refname"], { cwd })
      .split("\n").map((line) => line.trim()).find((name) => RELEASE_TAG.test(name)) ?? null;
    if (!chosen) throw new Refusal("No vX.Y.Z release tag found; pass --tag.");
  }
  const match = RELEASE_TAG.exec(chosen);
  if (!match) throw new Refusal(`${chosen} is not a release tag of the form vX.Y.Z.`);

  const commit = git(["rev-parse", "--verify", "--quiet", `refs/tags/${chosen}^{commit}`], { cwd }).trim();
  const reachable = spawnSync("git", ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"], { cwd });
  if (reachable.status !== 0) {
    throw new Refusal(`${chosen} (${commit.slice(0, 12)}) is not reachable from origin/main${fetch ? "" : " (checked without a fetch)"}.`);
  }

  const version = JSON.parse(git(["show", `${chosen}:package.json`], { cwd })).version;
  const expected = chosen.slice(1);
  if (version !== expected) {
    throw new Refusal(`package.json at ${chosen} says version ${version}; the tag says ${expected}.`);
  }
  return { tag: chosen, commit, version };
}

/**
 * Extracts `git archive <tag>` into dir (created, must be empty or absent).
 * @param {string} tag
 * @param {string} dir
 * @param {string} [cwd]
 */
export function exportTag(tag, dir, cwd = repoRoot) {
  fs.mkdirSync(dir, { recursive: true });
  const tar = `${dir}.tar`;
  try {
    git(["archive", "--format=tar", "-o", tar, tag], { cwd });
    execFileSync("tar", ["-xf", tar, "-C", dir]);
  } finally {
    fs.rmSync(tar, { force: true });
  }
}

/** @param {string} dir @param {string[]} [out] @param {string} [rel] */
function walk(dir, out = [], rel = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    out.push({ rel: childRel, abs: path.join(dir, entry.name), isDir: entry.isDirectory(), isFile: entry.isFile() });
    if (entry.isDirectory()) walk(path.join(dir, entry.name), out, childRel);
  }
  return out;
}

/**
 * Looks for anything that must not ship: forbidden directories, absolute local
 * home paths, Codex/Claude session-id paths. Returns human-readable problems.
 * @param {string} dir
 * @param {{ homeDir?: string }} [options]
 * @returns {string[]}
 */
export function scanTree(dir, { homeDir = os.homedir() } = {}) {
  const problems = [];
  for (const entry of walk(dir)) {
    const name = path.basename(entry.rel);
    if (FORBIDDEN_NAMES.has(name)) problems.push(`${entry.rel}: forbidden ${entry.isDir ? "directory" : "entry"} ${name}`);
    if (SESSION_PATH_NAME.test(name)) problems.push(`${entry.rel}: session transcript file name`);
    if (!entry.isFile) continue;
    const buffer = fs.readFileSync(entry.abs);
    if (buffer.subarray(0, 8192).includes(0)) continue; // binary
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    for (let n = 0; n < lines.length; n += 1) {
      const line = lines[n];
      const at = `${entry.rel}:${n + 1}`;
      if (homeDir && homeDir !== "/" && line.includes(homeDir)) problems.push(`${at}: contains this machine's home directory`);
      for (const m of line.matchAll(HOME_PATH)) {
        if (!SYNTHETIC_USERS.has(m[1])) problems.push(`${at}: absolute home path ${m[0]}`);
      }
      for (const m of line.matchAll(DASH_HOME_PATH)) {
        if (!SYNTHETIC_USERS.has(m[1])) problems.push(`${at}: encoded home path ${m[0]}`);
      }
      // Test fixtures carry synthetic session-shaped ids with no home prefix;
      // their real-path leaks are caught by the home-path checks above.
      if (entry.rel.startsWith("tests/")) continue;
      for (const m of line.matchAll(SESSION_PATH)) {
        const before = line.slice(Math.max(0, m.index - 80), m.index);
        const synthetic = /(?:\/(?:Users|home)\/(?:example|x|me|someone|user)|-Users-(?:example|x|me|someone)-[^\s"']*)\/?$/.test(before) || /~\/$/.test(before);
        if (!synthetic) problems.push(`${at}: session path ${m[0].slice(0, 60)}`);
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * dist/server.mjs must exist and embed the release version.
 * @param {string} dir
 * @param {string} version
 * @returns {{ sha256: string }}
 */
export function verifyDist(dir, version) {
  const file = path.join(dir, "dist", "server.mjs");
  if (!fs.existsSync(file)) throw new Refusal("dist/server.mjs is missing from the export; the tag must track the built dist.");
  const bundle = fs.readFileSync(file);
  const embedded = /AGENT_LINK_VERSION\s*=\s*true\s*\?\s*"([^"]+)"/.exec(bundle.toString("utf8"));
  if (!embedded) throw new Refusal("dist/server.mjs does not embed an AGENT_LINK_VERSION.");
  if (embedded[1] !== version) throw new Refusal(`dist/server.mjs embeds version ${embedded[1]}; the release is ${version}.`);
  return { sha256: crypto.createHash("sha256").update(bundle).digest("hex") };
}

/** @param {Date} date */
function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Renames target to a .prev-<UTC> sibling, then staging to target. If the second
 * rename fails the first is undone. Returns the .prev path or null.
 * @param {{ target: string, staging: string, now?: Date, rename?: (from: string, to: string) => void }} options
 */
export function swapIn({ target, staging, now = new Date(), rename = fs.renameSync }) {
  let prev = null;
  if (fs.existsSync(target)) {
    const base = `${target}.prev-${utcStamp(now)}`;
    prev = base;
    for (let n = 2; fs.existsSync(prev); n += 1) prev = `${base}-${n}`;
    rename(target, prev);
  }
  try {
    rename(staging, target);
  } catch (error) {
    if (prev) {
      try {
        rename(prev, target);
      } catch (rollbackError) {
        throw new Error(`install failed (${messageOf(error)}) and rollback failed (${messageOf(rollbackError)}); the previous install is at ${prev}`);
      }
    }
    throw error;
  }
  return prev;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes .prev-* siblings other than `keep`. A git checkout is the first-run
 * conversion's only copy of someone's working tree, so it is never deleted.
 * @param {string} target
 * @param {string | null} keep
 * @returns {{ removed: string[], keptCheckouts: string[] }}
 */
export function prunePrev(target, keep) {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.prev-`;
  const removed = [];
  const keptCheckouts = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    if (full === keep) continue;
    if (fs.existsSync(path.join(full, ".git"))) {
      keptCheckouts.push(full);
      continue;
    }
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(full);
  }
  return { removed, keptCheckouts };
}

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** @param {string} p */
function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.join(realOrSelf(path.dirname(p)), path.basename(p));
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, out?: (line: string) => void }} [options]
 */
export function run(argv, { cwd = repoRoot, out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const args = parseArgs(argv);
  const target = path.resolve(args.target);
  const realTarget = realOrSelf(target);
  if (isInside(realOrSelf(cwd), realTarget) || isInside(realTarget, realOrSelf(cwd))) {
    throw new Refusal(`--target ${target} overlaps the repo this script runs from; use a separate plugin folder.`);
  }
  if (!fs.existsSync(path.dirname(target))) throw new Refusal(`The parent of --target does not exist: ${path.dirname(target)}`);
  const existing = fs.existsSync(target) ? fs.lstatSync(target) : null;
  if (existing && !existing.isDirectory()) throw new Refusal(`--target exists and is not a directory: ${target}`);

  const release = checkRelease(args, cwd);
  const targetIsCheckout = Boolean(existing) && fs.existsSync(path.join(target, ".git"));

  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const staging = args.dryRun
    ? fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-install-dry-"))
    : `${target}.staging-${stamp}`;
  try {
    exportTag(release.tag, staging, cwd);
    const dist = verifyDist(staging, release.version);
    const problems = scanTree(staging);
    if (problems.length) {
      throw new Refusal(`The export of ${release.tag} failed the clean-tree scan:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : ""}`);
    }
    const marker = { tag: release.tag, commit: release.commit, distSha256: dist.sha256, installedAt: new Date().toISOString() };
    const fileCount = walk(staging).filter((entry) => entry.isFile).length;

    out(`Release:   ${release.tag} (${release.commit.slice(0, 12)}), reachable from origin/main, package.json ${release.version}`);
    out(`Export:    ${fileCount} tracked files; dist/server.mjs sha256 ${dist.sha256.slice(0, 16)}...`);
    out("Verified:  no .git, .worktrees or wf-runs; no absolute home paths or session-id paths");
    if (existing) {
      out(`Target:    ${target} exists${targetIsCheckout ? " and is a git checkout (first-run conversion): it is kept as the .prev folder, not deleted" : ""}`);
      out(`Plan:      rename it to ${target}.prev-<UTC timestamp>, then rename the export into place`);
    } else {
      out(`Target:    ${target} does not exist`);
      out("Plan:      rename the export into place");
    }
    out("Plan:      keep exactly one .prev-* folder (older ones removed; a git checkout is never removed)");

    if (args.dryRun) {
      out("Dry run: nothing was changed.");
      return;
    }

    fs.writeFileSync(path.join(staging, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);
    const prev = swapIn({ target, staging });
    const pruned = prunePrev(target, prev);
    out(`Installed ${release.tag} at ${target}`);
    if (prev) out(`Previous install kept at ${prev}${targetIsCheckout ? " (git checkout)" : ""}`);
    for (const dir of pruned.removed) out(`Removed older ${dir}`);
    for (const dir of pruned.keptCheckouts) out(`Kept ${dir}: it is a git checkout; remove it yourself once it is no longer needed`);
    out("");
    out("Next steps (not run by this script):");
    out("  Claude Code: restart Claude sessions. The directory marketplace reads the folder directly.");
    out("  Codex:       codex plugin add codex-agent-link@<marketplace>   (re-copies the folder into the plugin cache), then restart Codex sessions.");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`install-live: ${messageOf(error)}\n`);
    if (error instanceof Refusal) process.stderr.write("install-live: refused; nothing was changed.\n");
    process.exit(error instanceof Refusal ? 1 : 2);
  }
}
