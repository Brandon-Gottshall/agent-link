// src/codex/rollout-holders.js
//
// Deny-only "held elsewhere" check before a push (design R1.12a, B7 spike).
// An app-server opens a thread's rollout JSONL on its first turn and keeps
// it open while the thread stays loaded. If a process other than Agent
// Link's own endpoint has the file open, another app-server (the Codex
// desktop app's) has the thread loaded, and a push would make Agent Link a
// second writer, so the thread is treated as held. The absence of other
// holders proves nothing, so this check can only deny, never allow.
//
// One `lsof -F pg -- <path>` per push (/usr/sbin/lsof on macOS), with a
// timeout. Skips are counted (stats(), shown in agent_link_health) and the
// first one is logged. It is skipped (never blocks) when:
//   - there is no rollout path (thread/read did not return `path`);
//   - the endpoint's own process group is unknown (an endpoint configured
//     with AGENT_LINK_CODEX_URL / _SOCK: its own fd cannot be told apart from
//     another app-server's);
//   - lsof is missing, fails, or times out, or the platform is Windows.
// Never used by the hooks.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { getLogger } from "../shared/log.js";

// macOS ships lsof at /usr/sbin/lsof, which is not always on a GUI app's
// PATH; elsewhere it is looked up on PATH.
const DARWIN_LSOF = "/usr/sbin/lsof";

/**
 * @typedef {(file: string, args: string[], options: {timeout: number}, callback: (error: any, stdout: string) => void) => void} ExecFileLike
 */

/**
 * @param {{
 *   ownProcessGroup: () => number | null,
 *   timeoutMs?: number,
 *   run?: ExecFileLike,
 *   platform?: string,
 *   selfPid?: number,
 *   lsofPath?: string | null,
 *   logger?: {warn: (event: string, data?: any) => void}
 * }} options
 *   ownProcessGroup: the managed app-server's process group id (its pid), or
 *   null when the endpoint is not one Agent Link started
 * @returns {import("../delivery/codex-push.js").RolloutCheck & {stats: () => RolloutCheckStats}}
 */
export function makeRolloutCheck({ ownProcessGroup, timeoutMs = 1_000, run = /** @type {any} */ (execFile), platform = process.platform, selfPid = process.pid, lsofPath = null, logger = getLogger() }) {
  const binary = lsofPath ?? (platform === "darwin" && existsSync(DARWIN_LSOF) ? DARWIN_LSOF : "lsof");
  /** @type {RolloutCheckStats} */
  const stats = { checked: 0, held: 0, skipped: {} };
  let loggedSkip = false;
  /**
   * @param {string} reason
   * @returns {{held: false, checked: false, reason: string}}
   */
  const skip = (reason) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    if (!loggedSkip) {
      loggedSkip = true;
      logger.warn("rollout_check.skipped", { reason, note: "the deny-only held check was skipped; pushes continue on the endpoint's loaded state alone" });
    }
    return { held: false, checked: false, reason };
  };
  /** @type {any} */
  const check = async (/** @type {string | null | undefined} */ rolloutPath) => {
    if (typeof rolloutPath !== "string" || !rolloutPath) return skip("no_rollout_path");
    if (platform === "win32") return skip("unsupported_platform");
    const own = ownProcessGroup();
    if (!own) return skip("endpoint_pid_unknown");
    const output = await new Promise((resolve) => {
      try {
        run(binary, ["-F", "pg", "--", rolloutPath], { timeout: timeoutMs }, (error, stdout) => {
          // lsof exits 1 with no output when nobody has the file open.
          if (!error || (error.code === 1 && !String(stdout ?? "").trim())) resolve(String(stdout ?? ""));
          else resolve(error.killed || error.signal === "SIGTERM" ? "\u0000timeout" : null);
        });
      } catch {
        resolve(null);
      }
    });
    if (output === "\u0000timeout") return skip("lsof_timeout");
    if (output === null) return skip("lsof_unavailable");
    stats.checked += 1;
    const holders = parseLsofFields(/** @type {string} */ (output));
    const others = holders.filter((h) => h.pid !== selfPid && h.pid !== own && h.pgid !== own);
    if (others.length) stats.held += 1;
    return others.length
      ? { held: true, checked: true, reason: "open_in_another_process" }
      : { held: false, checked: true };
  };
  check.stats = () => ({ checked: stats.checked, held: stats.held, skipped: { ...stats.skipped } });
  return check;
}

/**
 * @typedef {{checked: number, held: number, skipped: Record<string, number>}} RolloutCheckStats
 */

/**
 * `lsof -F pg` output: a `p<pid>` line, then `g<pgid>`, per process.
 * @param {string} output
 * @returns {{pid: number, pgid: number | null}[]}
 */
export function parseLsofFields(output) {
  /** @type {{pid: number, pgid: number | null}[]} */
  const out = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (Number.isInteger(pid) && pid > 0) out.push({ pid, pgid: null });
    } else if (line.startsWith("g") && out.length) {
      const pgid = Number(line.slice(1));
      if (Number.isInteger(pgid)) out[out.length - 1].pgid = pgid;
    }
  }
  return out;
}
