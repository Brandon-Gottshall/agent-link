#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { initializeJournal, openJournal, privateDirectory } from "../src/desktop/journal.js";
import { DesktopBroker } from "../src/desktop/broker.js";
import { createMacHost, invokeNative } from "../src/desktop/host.js";
import { authenticDriver, createVercelDriver, VERCEL } from "../src/desktop/vercel.js";
import { desktopDirectory, ownerCall, serveDesktop } from "../src/desktop/transport.js";
import { controls, failure, refuse, success, VERSION } from "../src/desktop/protocol.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const [method, ...args] = process.argv.slice(2);
const directory = desktopDirectory();
const driverDir = path.join(directory, "vercel-" + VERCEL.version);
const driverHome = path.join(directory, "driver-state");
const helperSource = path.join(root, "native", "reserved-screen-host.m");
const helperDigest = createHash("sha256").update(fs.readFileSync(helperSource)).digest("hex");
const helper = path.join(directory, "host-" + helperDigest.slice(0, 16));
const ownerMethods = new Set([...Object.keys(controls), "set-display", "register-scope", "admit-claim", "enroll"]);

function print(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function run(file, argv) {
  const result = spawnSync(file, argv, { encoding: "utf8", stdio: "pipe", timeout: 30_000, maxBuffer: 256 * 1024 });
  if (result.status !== 0) refuse("desktop_setup_failed", "The trusted host tool could not complete " + argv[0] + ".");
  return result.stdout;
}

function mac() {
  if (process.platform !== "darwin" || process.arch !== "arm64") refuse("desktop_host_unsupported", "This pinned release supports macOS on Apple silicon.");
}

function buildHelper() {
  mac();
  privateDirectory(directory);
  if (fs.existsSync(helper)) return;
  const staging = path.join(directory, ".host-" + randomUUID());
  try {
    run("/usr/bin/xcrun", ["--sdk", "macosx", "clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
      "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "Security",
      helperSource, "-o", staging]);
    fs.chmodSync(staging, 0o700);
    fs.linkSync(staging, helper);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

function stageDriver(archive) {
  mac();
  privateDirectory(directory);
  if (!archive || !path.isAbsolute(archive) || !fs.lstatSync(archive).isFile() || fs.statSync(archive).size > 16 * 1024 * 1024) {
    refuse("driver_archive_invalid", "Provide the absolute path to the pinned, regular Vercel release archive.");
  }
  if (createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !== VERCEL.archive_sha256) refuse("driver_archive_invalid", "The archive digest does not match the pinned release.");
  if (fs.existsSync(driverDir)) {
    if (authenticDriver(driverDir)) return VERCEL;
    refuse("driver_directory_invalid", "The established driver path has unexpected contents. Preserve it for recovery.");
  }
  const staging = fs.mkdtempSync(path.join(directory, ".vercel-"));
  try {
    // The verified release archive contains exactly these two regular files.
    run("/usr/bin/tar", ["-xf", archive, "-C", staging, "agent-desktop", "agent-desktop-macos-helper"]);
    if (!authenticDriver(staging)) refuse("driver_archive_invalid", "The extracted executable digests do not match the pinned release.");
    fs.renameSync(staging, driverDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return VERCEL;
}

function currentBuild() {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, ".agent-link-install.json"), "utf8"));
    const dist = createHash("sha256").update(fs.readFileSync(path.join(root, "dist", "server.mjs"))).digest("hex");
    if (/^[a-f0-9]{40}$/.test(stamp.commit) && dist === stamp.distSha256) return stamp.commit;
  } catch {
    // Candidate runs report source identity separately from installed releases.
  }
  return "source-candidate";
}

async function stdinJson() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString("utf8");
    if (Buffer.byteLength(data) > 64 * 1024) refuse("invalid_desktop_request", "The controller request exceeds its size limit.");
  }
  try {
    return JSON.parse(data || '{"protocol_version":1}');
  } catch {
    refuse("invalid_desktop_request", "Provide a JSON controller request on stdin.");
  }
}

try {
  if (method === "init" && args.length === 0) {
    mac();
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    initializeJournal(directory);
    buildHelper();
    print(success({ state: "closed", next_action: "stage-driver_then_serve" }));
  } else if (method === "build-host" && args.length === 0) {
    buildHelper();
    print(success({ helper_ready: true }));
  } else if (method === "stage-driver" && args.length === 1) {
    print(success(stageDriver(args[0])));
  } else if (method === "inspect-target" && args.length === 0) {
    const query = await stdinJson();
    if (query.protocol_version !== VERSION || !Number.isSafeInteger(query.pid) || !Number.isSafeInteger(query.window) ||
      !["chrome-local", "preview-document", "textedit-document"].includes(query.kind)) refuse("invalid_scope", "Provide the owned process, window and target kind.");
    const target = await invokeNative(helper, "target", { payload: { pid: query.pid, window: query.window, kind: query.kind } });
    if (!target) refuse("target_binding_invalid", "The owned process, document/origin or exact window could not be inspected.");
    print(success(target));
  } else if (method === "serve" && args.length === 0) {
    mac();
    privateDirectory(directory);
    if (!fs.existsSync(helper)) refuse("desktop_host_missing", "Build the reserved-screen native host helper for this exact source.");
    if (!fs.existsSync(driverHome)) fs.mkdirSync(driverHome, { mode: 0o700 });
    privateDirectory(driverHome);
    const host = createMacHost({ directory, helper });
    const driver = createVercelDriver({ directory: driverDir, helper, driverHome, brokerBuild: currentBuild() });
    const service = await serveDesktop({ directory, helper, createBroker: () => new DesktopBroker({ journal: openJournal(directory), host, driver }) });
    await service.broker.recover();
    print(success(service.broker.ownerStatus()));
  } else if (ownerMethods.has(method) && args.length === 0) {
    print(success(await ownerCall(directory, method, await stdinJson())));
  } else {
    refuse("invalid_desktop_command", "Use init, build-host, stage-driver <archive>, inspect-target, serve, owner-status, stop, reclaim, restore, owner-cancel, recover-settling, set-display, register-scope, admit-claim, pending-connections, enroll, revoke-session or revoke-claim.");
  }
} catch (error) {
  print(failure(error));
  process.exitCode = 1;
}
