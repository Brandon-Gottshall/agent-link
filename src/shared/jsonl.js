// src/shared/jsonl.js
//
// JSON Lines helpers for Agent Link's append-only state files (mailbox,
// receipts, logs) and Codex's own indexes. Corrupt lines (an interrupted
// write, a hand edit) are skipped, never fatal, so the file stays readable.
// Records are typed `any`: callers validate the shape they expect.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { assertTestSafeWrite } from "./paths.js";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/**
 * Parses every non-blank line that is valid JSON, in order. Lines that fail
 * to parse are skipped. JSON `null` lines are kept as null.
 * @param {string} raw
 * @returns {any[]}
 */
export function parseJsonlLines(raw) {
  /** @type {any[]} */
  const records = [];
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip a corrupt line.
    }
  }
  return records;
}

/**
 * Streams the records of a JSONL file without loading it whole. A missing
 * file yields nothing; other read errors propagate.
 * @param {string} filePath
 * @returns {AsyncGenerator<any, void, void>}
 */
export async function* readJsonl(filePath) {
  let stream;
  try {
    const handle = await fsp.open(filePath, "r");
    stream = handle.createReadStream({ encoding: "utf8" });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        yield JSON.parse(line);
      } catch {
        // Skip a corrupt line.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Reads a whole JSONL file into memory. A missing file is an empty list.
 * @param {string} filePath
 * @returns {any[]}
 */
export function readJsonlSync(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return parseJsonlLines(raw);
}

/**
 * Serializes records as JSON lines, each ending in "\n".
 * @param {unknown[]} records
 * @returns {string}
 */
export function toJsonl(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/**
 * Appends records to a JSONL file, creating the parent directory (0700) and
 * the file (0600) when missing. Modes apply only on creation, as with
 * fs.appendFile. One write call, so a small batch lands together.
 * @param {string} filePath
 * @param {unknown | unknown[]} records
 * @returns {Promise<void>}
 */
export async function appendJsonl(filePath, records) {
  const text = toJsonl(Array.isArray(records) ? records : [records]);
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  await fsp.appendFile(filePath, text, { encoding: "utf8", mode: FILE_MODE });
}

/**
 * Synchronous appendJsonl, for hooks and process-exit paths.
 * @param {string} filePath
 * @param {unknown | unknown[]} records
 * @returns {void}
 */
export function appendJsonlSync(filePath, records) {
  const text = toJsonl(Array.isArray(records) ? records : [records]);
  assertTestSafeWrite(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  fs.appendFileSync(filePath, text, { encoding: "utf8", mode: FILE_MODE });
}
