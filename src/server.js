#!/usr/bin/env node
// Agent Link MCP server entry point (scripts, tests and the plugin manifests
// launch this file; scripts/build.mjs bundles it into dist/server.mjs).
//
// First import: installs the process error handlers before anything else
// loads (src/server/process-guard.js). ES modules evaluate in import order,
// so the handlers are in place before the MCP SDK and the rest of the server
// evaluate. tests/server/server-modules.test.js locks this.
import { setFatalHandler } from "./server/process-guard.js";
import { main } from "./server/index.js";

await main({ setFatalHandler });
