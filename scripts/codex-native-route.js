#!/usr/bin/env node
import { CodexAppServerClient } from "../src/app-server-client.js";

const args = process.argv.slice(2);
const command = args.shift();
const attempts = parsePositiveInteger(option(args, "--attempts") ?? process.env.CODEX_AGENT_LINK_ROUTE_ATTEMPTS ?? "3", "--attempts");
const retryDelayMs = parsePositiveInteger(option(args, "--retry-delay-ms") ?? process.env.CODEX_AGENT_LINK_ROUTE_RETRY_DELAY_MS ?? "750", "--retry-delay-ms");

if (!command || command === "--help" || command === "-h") {
  usage();
  process.exit(command ? 0 : 2);
}

const appServer = new CodexAppServerClient({
  autoStart: process.env.CODEX_AGENT_LINK_AUTOSTART !== "0",
  requestTimeoutMs: parsePositiveInteger(process.env.CODEX_AGENT_LINK_ROUTE_REQUEST_TIMEOUT_MS ?? "15000", "CODEX_AGENT_LINK_ROUTE_REQUEST_TIMEOUT_MS")
});

try {
  if (command === "route-thread") {
    const threadId = option(args, "--thread-id") || "";
    if (!threadId) {
      throw new Error("route-thread requires --thread-id.");
    }
    const focus = parseBoolean(option(args, "--focus") ?? "false");
    try {
      const route = await retryRequest({
        attempts,
        delayMs: retryDelayMs,
        request: () => appServer.request("desktop/thread/route", { threadId, focus }),
        isProven: (value) => isProvenRoute(value, threadId, focus)
      });
      printJSON({
        threadId,
        focus,
        routed: Boolean(route?.routed),
        authority: route?.authority ?? "validatedOnly",
        selection: route?.selection ?? null,
        reason: route?.reason ?? null
      });
    } catch (error) {
      printJSON({
        threadId,
        focus,
        routed: false,
        authority: "validatedOnly",
        selection: null,
        reason: error.message
      });
    }
  } else if (command === "selection-read") {
    try {
      const selection = await retryRequest({
        attempts,
        delayMs: retryDelayMs,
        request: () => appServer.request("desktop/thread/selection/read", {}),
        isProven: isProvenSelection
      });
      printJSON({
        selection: selection?.selection ?? null,
        authority: selection?.authority ?? "unsupported",
        reason: selection?.reason ?? null
      });
    } catch (error) {
      printJSON({
        selection: null,
        authority: "unsupported",
        reason: error.message
      });
    }
  } else {
    usage();
    process.exitCode = 2;
  }
} finally {
  await appServer.close();
}

function option(values, name) {
  const index = values.indexOf(name);
  if (index < 0 || index + 1 >= values.length) {
    return null;
  }
  return values[index + 1];
}

function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function retryRequest({ attempts, delayMs, request, isProven }) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await request();
      lastResult = result;
      lastError = null;
      if (isProven(result) || attempt === attempts) {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }
    }
    await sleep(delayMs);
  }
  if (lastError) {
    throw lastError;
  }
  return lastResult;
}

function isProvenRoute(route, threadId, focus) {
  const selectedThreadId = route?.selection?.threadId ?? null;
  const focused = typeof route?.selection?.focused === "boolean"
    ? route.selection.focused
    : null;
  return route?.routed === true
    && route?.authority === "nativeQuietRoute"
    && selectedThreadId === threadId
    && focused === focus;
}

function isProvenSelection(selection) {
  const focused = typeof selection?.selection?.focused === "boolean"
    ? selection.selection.focused
    : null;
  return selection?.authority === "nativeQuietRoute" && focused === false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printJSON(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
  process.stderr.write(`Usage:
  codex-agent-link-route route-thread --thread-id <id> [--focus true|false] [--attempts n] [--retry-delay-ms n] [--json]
  codex-agent-link-route selection-read [--attempts n] [--retry-delay-ms n] [--json]
`);
}
