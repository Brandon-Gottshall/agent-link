// One description of where Codex lives on this machine. Binary discovery,
// health, and anything else that needs to know "which Codex" read it from here
// instead of carrying their own hardcoded Codex.app paths.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV_ALIASES } from "../shared/env.js";

// Codex Desktop ships inside ChatGPT.app today. /Applications/Codex.app can be
// a stale older copy whose app-server rejects current models and cannot resume
// threads written by newer Codex versions, so it is listed after ChatGPT.app.
const APP_BUNDLES = [
  {
    app: "ChatGPT.app",
    binaries: [
      "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "Contents/Resources/codex"
    ]
  },
  {
    app: "Codex.app",
    binaries: ["Contents/Resources/codex"]
  }
];

export function codexInstallLayout(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const applicationDirs = options.applicationDirs
    ?? (platform === "darwin" ? ["/Applications", path.join(home, "Applications")] : []);
  const executable = platform === "win32" ? "codex.exe" : "codex";
  return {
    platform,
    executable,
    envVars: ["AGENT_LINK_CODEX_BIN", ...ENV_ALIASES.AGENT_LINK_CODEX_BIN],
    appBundles: applicationDirs.flatMap((dir) => APP_BUNDLES.map((bundle) => ({
      app: bundle.app,
      appPath: path.join(dir, bundle.app),
      binaries: bundle.binaries.map((relative) => path.join(dir, bundle.app, relative))
    }))),
    pathDirs: options.pathDirs ?? splitPath(options.pathEnv ?? process.env.PATH ?? ""),
    wellKnownDirs: options.wellKnownDirs ?? (platform === "win32"
      ? []
      : [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"])
  };
}

// Ordered candidate list: env overrides, app bundles (ChatGPT.app first),
// PATH lookup, then well-known install dirs. Each entry says where it came from.
export function codexBinaryCandidateEntries(options = {}) {
  const env = options.env ?? process.env;
  const layout = options.layout ?? codexInstallLayout(options);
  const entries = [];
  for (const name of layout.envVars) {
    if (env[name]) {
      entries.push({ path: env[name], source: `env:${name}`, explicit: true });
    }
  }
  for (const bundle of layout.appBundles) {
    for (const binary of bundle.binaries) {
      entries.push({ path: binary, source: `app:${bundle.app}` });
    }
  }
  for (const dir of layout.pathDirs) {
    entries.push({ path: path.join(dir, layout.executable), source: "PATH" });
  }
  for (const dir of layout.wellKnownDirs) {
    entries.push({ path: path.join(dir, layout.executable), source: "well-known" });
  }
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.path)) {
      return false;
    }
    seen.add(entry.path);
    return true;
  });
}

// Returns { found, path, source, searched, reason }. An explicit env override
// that does not exist is reported, not silently skipped: the caller asked for
// that binary.
export function discoverCodexBinary(options = {}) {
  const entries = codexBinaryCandidateEntries(options);
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const searched = [];
  for (const entry of entries) {
    searched.push(entry.path);
    // A bare command name in an env override is resolved through PATH.
    if (entry.explicit && !entry.path.includes(path.sep)) {
      const layout = options.layout ?? codexInstallLayout(options);
      const resolved = layout.pathDirs
        .map((dir) => path.join(dir, entry.path))
        .find((candidate) => isExecutable(candidate));
      if (resolved) {
        return { found: true, path: resolved, source: entry.source, searched };
      }
      return {
        found: false,
        path: null,
        source: entry.source,
        searched,
        reason: `${entry.source.slice(4)}=${entry.path} was not found on PATH`
      };
    }
    if (isExecutable(entry.path)) {
      return { found: true, path: entry.path, source: entry.source, searched };
    }
    if (entry.explicit) {
      return {
        found: false,
        path: null,
        source: entry.source,
        searched,
        reason: `${entry.source.slice(4)} points at ${entry.path}, which does not exist or is not executable`
      };
    }
  }
  return {
    found: false,
    path: null,
    source: null,
    searched,
    reason: "No Codex binary was found in the app bundles, on PATH, or in the well-known install directories"
  };
}

const versionCache = new Map();

// `codex --version`, cached per (path, mtime) so health stays cheap.
// With cachedOnly, never spawns: returns a cached version or undefined.
export function codexBinaryVersion(binaryPath, { timeoutMs = 3000, cachedOnly = false } = {}) {
  if (!binaryPath) {
    return null;
  }
  let key = binaryPath;
  try {
    key = `${binaryPath}:${statSync(binaryPath).mtimeMs}`;
  } catch {
    // keep the bare path as the key
  }
  if (versionCache.has(key)) {
    return versionCache.get(key);
  }
  if (cachedOnly) {
    return undefined;
  }
  const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: timeoutMs });
  const version = result.status === 0 && !result.error
    ? (result.stdout || "").trim().split("\n")[0] || null
    : null;
  versionCache.set(key, version);
  return version;
}

function defaultIsExecutable(candidate) {
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPath(value) {
  return String(value)
    .split(path.delimiter)
    .filter((dir) => dir && path.isAbsolute(dir));
}
