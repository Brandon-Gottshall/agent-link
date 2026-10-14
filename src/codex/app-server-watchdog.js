// src/codex/app-server-watchdog.js
//
// A managed app-server is spawned detached so it leads its own process group.
// That also means a host's group signals never reach it, and when Agent Link's
// server is SIGKILLed (a stalled shutdown past the host's 1 s limit) no code
// of the server runs to stop it: the app-server lived on with ppid 1, along
// with its managed record and socket.
//
// The fix does not depend on the server running anything. The server instead
// spawns this watchdog as the group leader and keeps the write end of its
// stdin pipe. The watchdog runs the app-server in its group and, when the pipe
// reaches EOF (the server exited or was killed, so the kernel closed the
// pipe), SIGTERMs the whole group, SIGKILLs it after a grace, and removes the
// managed record and endpoint files. It uses only Node built-ins and runs
// from an `-e` string, so it works from source and from the dist bundle.

/**
 * argv after `--`: a JSON config, the command, and the command's arguments.
 * config: { graceMs, files: [paths to remove], recordDir } (the record is
 * `<recordDir>/<watchdog pid>.json`, the watchdog's own pid being the managed
 * pid).
 */
export const APP_SERVER_WATCHDOG_SOURCE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const [configJson, command, ...args] = process.argv.slice(1);
const config = JSON.parse(configJson);
let parentGone = false;
// The server signals the whole group on a normal stop, so this process gets
// the same signal as the app-server: ignore it and wait for the app-server.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
const signalGroup = (signal) => {
  try {
    process.kill(-process.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
};
const finish = () => {
  const files = [...config.files];
  if (config.recordDir) files.push(path.join(config.recordDir, process.pid + ".json"));
  for (const file of files) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  signalGroup("SIGKILL");
  process.exit(0);
};
child.on("error", (error) => {
  process.stderr.write("spawn error: " + error.message + "\\n");
  process.exit(error.code === "ENOENT" ? 127 : 126);
});
child.on("exit", (code, signal) => {
  if (!parentGone) process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
  // The server is gone and the app-server has exited: sweep up what it left.
  setTimeout(finish, 100);
});
const onParentGone = () => {
  if (parentGone) return;
  parentGone = true;
  signalGroup("SIGTERM");
  setTimeout(finish, config.graceMs).unref();
};
process.stdin.on("end", onParentGone);
process.stdin.on("close", onParentGone);
process.stdin.on("error", onParentGone);
process.stdin.resume();
`;

/**
 * The command and arguments that run `launch` under the watchdog.
 * @param {{command: string, args: string[]}} launch
 * @param {string[]} appServerArgs arguments after launch.args (listen, auth)
 * @param {{graceMs: number, files: Array<string | null | undefined>, recordDir: string | null}} options
 * @returns {{command: string, args: string[]}}
 */
export function watchdogCommand(launch, appServerArgs, { graceMs, files, recordDir }) {
  const config = {
    graceMs,
    files: files.filter((file) => typeof file === "string" && file),
    recordDir
  };
  return {
    command: process.execPath,
    args: ["-e", APP_SERVER_WATCHDOG_SOURCE, "--", JSON.stringify(config), launch.command, ...launch.args, ...appServerArgs]
  };
}
