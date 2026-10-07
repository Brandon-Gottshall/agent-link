// src/codex/fork-jobs.js
//
// The fork job log (design doc R9.7): `<state>/forks.jsonl`, append-only,
// one event per line. A job is the fold of its events:
//
//   created       the request: original, caller, settings, reconcile labels
//   forked        thread/fork answered: the fork's id and effective settings
//   compacted     thread/compact/start ran on the fork (R9.11)
//   turn-started  turn/start on the fork: the task's turn id
//   completed | failed | interrupted   the task's turn ended
//   reconcile-written  the reconcile message is in the original's mailbox
//                 (appended synchronously right after the mailbox insert,
//                 with its messageId, so the message is found by id)
//   reconciled    the reconcile message was delivered or queued
//   archived      the fork was archived after a completed reconcile
//   aborted       thread/fork failed: there is no fork to reconcile
//
// Every Agent Link server reads the same log, so any of them can finish a
// job whose turn ended while its caller's server was gone (src/codex/fork.js).
// The first event of each type wins when a type appears twice.
//
// The log is bounded (compactForkJobs): past FORK_LOG_MAX_BYTES, jobs that
// were reconciled or aborted more than FORK_LOG_RETENTION_MS ago are dropped.

import fs from "node:fs";
import { FILE_MODE, appendJsonlSync, parseJsonlLines, readJsonlSync, toJsonl } from "../shared/jsonl.js";
import { forkJobsPath } from "../shared/paths.js";

export const FORK_OUTCOMES = Object.freeze(["completed", "failed", "interrupted"]);

const EVENT_TYPES = new Set(["created", "forked", "compacted", "turn-started", ...FORK_OUTCOMES, "reconcile-written", "reconciled", "archived", "aborted"]);

/** Compaction starts once the log is larger than this. */
export const FORK_LOG_MAX_BYTES = 512 * 1024;
/** Finished jobs older than this are dropped by compaction. */
export const FORK_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{type: string, jobId: string, at: number} & Record<string, any>} ForkJobEvent
 *
 * @typedef {{
 *   id: string,
 *   createdAt: number | null,
 *   created: ForkJobEvent | null,
 *   forked: ForkJobEvent | null,
 *   compacted: ForkJobEvent | null,
 *   turnStarted: ForkJobEvent | null,
 *   outcome: ForkJobEvent | null,
 *   written: ForkJobEvent | null,
 *   reconciled: ForkJobEvent | null,
 *   archived: ForkJobEvent | null,
 *   aborted: ForkJobEvent | null
 * }} ForkJob
 */

/**
 * Folds events into jobs, in order of first appearance.
 * @param {ForkJobEvent[]} events
 * @returns {ForkJob[]}
 */
export function foldForkJobs(events) {
  /** @type {Map<string, ForkJob>} */
  const jobs = new Map();
  for (const event of events) {
    if (!event || typeof event.jobId !== "string" || !EVENT_TYPES.has(event.type)) continue;
    let job = jobs.get(event.jobId);
    if (!job) {
      job = { id: event.jobId, createdAt: null, created: null, forked: null, compacted: null, turnStarted: null, outcome: null, written: null, reconciled: null, archived: null, aborted: null };
      jobs.set(event.jobId, job);
    }
    const slot = slotOf(event.type);
    if (job[slot] === null) {
      job[slot] = event;
      if (slot === "created") job.createdAt = Number.isFinite(event.at) ? event.at : null;
    }
  }
  return [...jobs.values()];
}

/**
 * @param {string} type
 * @returns {"created" | "forked" | "compacted" | "turnStarted" | "outcome" | "written" | "reconciled" | "archived" | "aborted"}
 */
function slotOf(type) {
  if (type === "turn-started") return "turnStarted";
  if (type === "reconcile-written") return "written";
  if (FORK_OUTCOMES.includes(type)) return "outcome";
  return /** @type {any} */ (type);
}

/**
 * The job's status for a tool result: its turn outcome, or running.
 * @param {ForkJob} job
 */
export function forkJobStatus(job) {
  if (job.aborted) return "aborted";
  return job.outcome?.type ?? "running";
}

/**
 * @param {{path?: string, now?: () => number}} [options]
 */
export function createForkJobStore({ path = undefined, now = () => Date.now() } = {}) {
  const file = () => path ?? forkJobsPath();
  return {
    path: file,
    /**
     * @param {string} type
     * @param {string} jobId
     * @param {Record<string, any>} [fields]
     */
    append(type, jobId, fields = {}) {
      /** @type {ForkJobEvent} */
      const event = { type, jobId, at: now(), ...fields };
      appendJsonlSync(file(), event);
      return event;
    },
    /** @returns {ForkJob[]} */
    list() {
      return foldForkJobs(readJsonlSync(file()));
    },
    /** @param {string} jobId */
    get(jobId) {
      return this.list().find((job) => job.id === jobId) ?? null;
    },
    /** @param {{maxBytes?: number, retentionMs?: number}} [options] */
    compact(options = {}) {
      return compactForkJobs(file(), { now: now(), ...options });
    }
  };
}

/** @typedef {ReturnType<typeof createForkJobStore>} ForkJobStore */

/**
 * Drops jobs that finished (reconciled or aborted) more than `retentionMs`
 * ago, once the log is larger than `maxBytes`. The kept events are written
 * to a temporary file that replaces the log only if the log did not grow
 * meanwhile (another server appended); otherwise compaction waits for the
 * next pass. The remaining window between that check and the rename is a
 * few synchronous calls.
 * @param {string} file
 * @param {{now?: number, maxBytes?: number, retentionMs?: number}} [options]
 * @returns {{compacted: boolean, dropped: number}}
 */
export function compactForkJobs(file, { now = Date.now(), maxBytes = FORK_LOG_MAX_BYTES, retentionMs = FORK_LOG_RETENTION_MS } = {}) {
  let raw;
  try {
    if (fs.statSync(file).size <= maxBytes) return { compacted: false, dropped: 0 };
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { compacted: false, dropped: 0 };
  }
  const events = parseJsonlLines(raw);
  const finished = new Set(foldForkJobs(events)
    .filter((job) => {
      const end = job.reconciled?.at ?? job.aborted?.at;
      return Number.isFinite(end) && now - end > retentionMs;
    })
    .map((job) => job.id));
  if (!finished.size) return { compacted: false, dropped: 0 };
  const kept = events.filter((event) => !finished.has(event?.jobId));
  const tmp = `${file}.compact-${process.pid}`;
  fs.writeFileSync(tmp, toJsonl(kept), { encoding: "utf8", mode: FILE_MODE });
  if (fs.statSync(file).size !== Buffer.byteLength(raw, "utf8")) {
    fs.rmSync(tmp, { force: true });
    return { compacted: false, dropped: 0 };
  }
  fs.renameSync(tmp, file);
  return { compacted: true, dropped: finished.size };
}
