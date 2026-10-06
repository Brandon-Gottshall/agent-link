// src/server/process-guard.js
//
// Process-level error handlers, installed as the first thing src/server.js
// evaluates (it is the server's first import), before the MCP SDK and the
// rest of the server load. A stray rejection or exception during startup is
// logged and exits 1; once the server is up, setFatalHandler() routes it to
// the normal shutdown, which also stops the managed app-server.

import { getLogger } from "../shared/log.js";

/** @type {((event: string, error: unknown) => void) | null} */
let handler = null;

/**
 * @param {(event: string, error: unknown) => void} fn
 */
export function setFatalHandler(fn) {
  handler = fn;
}

/**
 * @param {string} event
 * @param {unknown} error
 */
function fatal(event, error) {
  if (handler) {
    handler(event, error);
    return;
  }
  getLogger().error(event, {
    error: error instanceof Error ? error : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
}

process.on("unhandledRejection", (reason) => fatal("process.unhandled_rejection", reason));
process.on("uncaughtException", (error) => fatal("process.uncaught_exception", error));
