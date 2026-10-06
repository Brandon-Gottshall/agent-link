// Import this first in any script that touches real Codex threads, real
// app-servers, the GUI, or the real ~/.claude / ~/.codex state. It exits before
// anything else runs unless the caller opted in with AGENT_LINK_LIVE=1, so a
// bare `node --test`, a glob, or a stray `npm run` cannot launch live work.
// Also runnable directly (`node scripts/live-guard.js && ...`) to gate shell
// pipelines in package.json.
import path from "node:path";

if (process.env.AGENT_LINK_LIVE !== "1") {
  const invoked = process.argv[1] ? path.basename(process.argv[1]) : "this script";
  const script = invoked === "live-guard.js" && process.env.npm_lifecycle_event
    ? `npm run ${process.env.npm_lifecycle_event}`
    : invoked;
  process.stderr.write(
    `${script}: refusing to run a live check without AGENT_LINK_LIVE=1.\n`
      + "It launches real Codex threads or app-servers, or touches real ~/.claude or ~/.codex state.\n"
      + "Re-run with AGENT_LINK_LIVE=1 if you meant to. See docs/testing.md.\n"
  );
  process.exit(1);
}
