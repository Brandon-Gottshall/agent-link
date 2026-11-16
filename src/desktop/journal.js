import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { digest, refuse } from "./protocol.js";

const JOURNAL = "journal.json";
const SECRET = "controller-key";
const IDENTITY = "installation-id";
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

export function privateFile(file, { max = MAX_JOURNAL_BYTES } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > max) {
      refuse("desktop_private_file_invalid", "The reserved-screen private file has unexpected ownership, permissions or size.");
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    refuse("desktop_storage_invalid", "The reserved-screen directory must be a private directory owned by this user.");
  }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writePrivate(directory, name, text) {
  const staged = path.join(directory, ".pending-" + randomUUID());
  const fd = fs.openSync(staged, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(staged, path.join(directory, name));
  syncDirectory(directory);
}

function loadIdentity(directory) {
  privateDirectory(directory);
  const installation = privateFile(path.join(directory, IDENTITY), { max: 64 });
  if (!/^[a-f0-9-]{36}$/.test(installation)) refuse("desktop_installation_invalid", "The reserved-screen installation marker is invalid.");
  return installation;
}

export function controllerKey(directory) {
  loadIdentity(directory);
  const value = privateFile(path.join(directory, SECRET), { max: 64 });
  if (!/^[a-f0-9]{64}$/.test(value)) refuse("desktop_installation_invalid", "The reserved-screen controller credential is invalid.");
  return value;
}

/** @param {string} [installation] */
export function initialState(installation = randomUUID()) {
  return {
    schema: 1,
    installation,
    epoch: 0,
    last_sequence: 0,
    closed: "initial_setup_required",
    binding: null,
    lease: null,
    invocation: null,
    tickets: {},
    actions: {},
    observations: {},
    receipts: {},
    controls: {},
    control_settlements: {},
    last_owner_control_id: null,
    started_claims: {},
    revoked_claims: {},
    qualifications: {}
  };
}

export function initializeJournal(directory) {
  // Refuse an existing directory even if partially initialized. Missing state
  // in an established installation must never bootstrap an empty journal.
  fs.mkdirSync(directory, { mode: 0o700 });
  const installation = randomUUID();
  writePrivate(directory, SECRET, randomBytes(32).toString("hex"));
  writePrivate(directory, IDENTITY, installation);
  writeState(directory, initialState(installation));
  syncDirectory(path.dirname(directory));
}

function writeState(directory, state) {
  const contents = JSON.stringify({ state, sha256: digest(state) });
  if (Buffer.byteLength(contents) > MAX_JOURNAL_BYTES) refuse("desktop_journal_full", "The retained journal reached its size limit. Stop and preserve it for controller recovery.");
  writePrivate(directory, JOURNAL, contents);
}

export function openJournal(directory) {
  try {
    const installation = loadIdentity(directory);
    const { state, sha256 } = JSON.parse(privateFile(path.join(directory, JOURNAL)));
    if (state.installation !== installation || state.schema !== 1 || digest(state) !== sha256 ||
      !Number.isSafeInteger(state.epoch) || state.epoch < 0 || !Number.isSafeInteger(state.last_sequence) ||
      Object.keys(initialState(installation)).some(key => !Object.hasOwn(state, key))) {
      refuse("desktop_journal_invalid", "The installed journal failed integrity checks. Preserve it for controller recovery.");
    }
    return {
      state,
      save: (next) => writeState(directory, next)
    };
  } catch {
    refuse("desktop_journal_invalid", "The established journal is unreadable or invalid. Admission is closed. Preserve it for controller recovery.");
  }
}
