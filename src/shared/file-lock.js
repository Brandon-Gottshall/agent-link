// src/shared/file-lock.js
//
// An inter-process lock on a state file (moved from src/registry/roles.js):
// `<file>.lock` created with O_EXCL, a stale lock of a dead process broken
// safely, a short bounded wait. Used by the role table and the fork job log
// (src/codex/fork-jobs.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentLinkError } from "./errors.js";
import { FILE_MODE } from "./jsonl.js";
import { assertTestSafeWrite } from "./paths.js";

const LOCK_STALE_MS = 30_000;
// Critical sections take milliseconds. A request waits at most this long for
// the lock and then fails fast with a retry hint instead of blocking the
// server's event loop.
export const LOCK_TIMEOUT_MS = 250;
const LOCK_RETRY_MS = 5;
const BREAKER_STALE_MS = 5_000;

/**
 * Sleeps synchronously (lock retries). Atomics.wait on a private buffer.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {number} pid */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Identity of a lock file as seen at one moment: content, inode, mtime.
 * @param {string} lockPath
 * @returns {{raw: string, ino: number, mtimeMs: number} | null}
 */
function lockSnapshot(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    return { raw: fs.readFileSync(lockPath, "utf8"), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** @param {string} raw */
function ownerPid(raw) {
  try {
    return Number(JSON.parse(raw)?.pid);
  } catch {
    return NaN;
  }
}

/**
 * Removes a stale lock without ever removing a live one. Only the holder of
 * the O_EXCL breaker file `<lock>.break` may remove the lock, and only after
 * re-checking that the lock is still exactly the stale file it observed
 * (same content, inode, and mtime). Returns true when it removed the lock.
 * @param {string} lockPath
 * @param {{raw: string, ino: number, mtimeMs: number}} observed
 * @param {string} token
 * @param {() => number} now
 */
function breakStaleLock(lockPath, observed, token, now) {
  const breaker = `${lockPath}.break`;
  try {
    fs.writeFileSync(breaker, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: FILE_MODE });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") return false;
    // A breaker left by a process that died while breaking: clear it so the
    // next attempt can proceed. Breaking takes microseconds, so a breaker
    // this old whose owner is gone is abandoned.
    const stale = lockSnapshot(breaker);
    if (stale && now() - stale.mtimeMs > BREAKER_STALE_MS && !processAlive(ownerPid(stale.raw))) {
      fs.rmSync(breaker, { force: true });
    }
    return false;
  }
  try {
    const current = lockSnapshot(lockPath);
    if (!current || current.raw !== observed.raw || current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

/**
 * Runs `fn` while holding `<lockPath>` (created with O_EXCL). A lock older
 * than `staleMs` whose owner process is gone is stale and is taken over
 * through breakStaleLock. Waits at most `timeoutMs` (250 ms by default, so a
 * request never blocks the server for long), then fails with
 * state_io_error and a retry hint.
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number, now?: () => number, label?: string}} [options]  label names the locked file in errors
 * @returns {T}
 */
export function withFileLockSync(lockPath, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, now = () => Date.now(), label = "role table" } = {}) {
  assertTestSafeWrite(lockPath);
  const deadline = now() + timeoutMs;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() }), { flag: "wx", mode: FILE_MODE });
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
        throw new AgentLinkError("state_io_error", `Could not create the ${label} lock. (${/** @type {NodeJS.ErrnoException} */ (error).code ?? "error"})`, {
          details: { path: path.basename(lockPath), errno: /** @type {NodeJS.ErrnoException} */ (error).code ?? null },
          cause: error
        });
      }
    }
    const observed = lockSnapshot(lockPath);
    if (observed && now() - observed.mtimeMs > staleMs && !processAlive(ownerPid(observed.raw))) {
      if (breakStaleLock(lockPath, observed, token, now)) continue;
    }
    if (now() >= deadline) {
      throw new AgentLinkError("state_io_error", `The ${label} is busy (another Agent Link server holds its lock).`, {
        details: { path: path.basename(lockPath), errno: "ETIMEDOUT" },
        hint: `Retry the call. If this persists, check that no Agent Link process is stuck, then remove ${path.basename(lockPath)} from the state directory.`
      });
    }
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current?.token === token) fs.rmSync(lockPath, { force: true });
    } catch {
      // Already gone.
    }
  }
}

