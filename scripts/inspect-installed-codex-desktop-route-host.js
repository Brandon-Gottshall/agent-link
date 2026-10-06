#!/usr/bin/env node
import {
  inspectInstalledCodexDesktopRouteHost,
  printInstalledCodexDesktopRouteHostInspection
} from "../src/desktop-route-host-inspection.js";

const args = process.argv.slice(2);
const appPath = option(args, "--app") || process.env.CODEX_AGENT_LINK_CODEX_APP || "/Applications/Codex.app";
const json = args.includes("--json");
const checkAppServer = !args.includes("--no-app-server");
const routeThreadId = option(args, "--route-thread-id");

const result = await inspectInstalledCodexDesktopRouteHost({
  appPath,
  checkAppServer,
  routeThreadId
});

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  printInstalledCodexDesktopRouteHostInspection(result);
}

function option(values, name) {
  const index = values.indexOf(name);
  if (index < 0 || index + 1 >= values.length) {
    return null;
  }
  return values[index + 1];
}
