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
//   reconciled    the reconcile message was written to the original's mailbox
//   archived      the fork was archived after a completed reconcile
//   aborted       thread/fork failed: there is no fork to reconcile
//
// Every Agent Link server reads the same log, so any of them can finish a
// job whose turn ended while its caller's server was gone (src/codex/fork.js).
// The first event of each type wins when a type appears twice.

import { appendJsonlSync, readJsonlSync } from "../shared/jsonl.js";
import { forkJobsPath } from "../shared/paths.js";

export const FORK_OUTCOMES = Object.freeze(["completed", "failed", "interrupted"]);

const EVENT_TYPES = new Set(["created", "forked", "compacted", "turn-started", ...FORK_OUTCOMES, "reconciled", "archived", "aborted"]);

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
      job = { id: event.jobId, createdAt: null, created: null, forked: null, compacted: null, turnStarted: null, outcome: null, reconciled: null, archived: null, aborted: null };
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
 * @returns {"created" | "forked" | "compacted" | "turnStarted" | "outcome" | "reconciled" | "archived" | "aborted"}
 */
function slotOf(type) {
  if (type === "turn-started") return "turnStarted";
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
    }
  };
}

/** @typedef {ReturnType<typeof createForkJobStore>} ForkJobStore */
