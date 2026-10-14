// Preloaded into the MCP server (`node --import <this> src/server.js`) by
// tests/codex/managed-app-server-parent-death.test.js. It models a server that
// cannot run its shutdown inside the host's 1 s SIGKILL window: its SIGTERM and
// stdin-end handlers (registered before the server's own) block the event loop
// for AGENT_LINK_TEST_STALL_MS, so close() never runs and the host SIGKILLs it.
const stallMs = Number(process.env.AGENT_LINK_TEST_STALL_MS || 0);
if (stallMs > 0 && (process.argv[1] || "").endsWith("server.js")) {
  const stall = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
  process.on("SIGTERM", stall);
  process.stdin.once("end", stall);
  process.stdin.once("close", stall);
}
