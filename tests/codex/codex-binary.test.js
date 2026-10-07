// Managed app-server binary selection: the live Codex ships inside ChatGPT.app as
// Resources/codex-cli/CodexCLI.app; a stale /Applications/Codex.app must never win
// over it (its app-server cannot resume threads written by newer Codex versions).
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { codexBinaryCandidates } from "../../src/codex/app-server-client.js";

const CHATGPT_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const STALE_DESKTOP = "/Applications/Codex.app/Contents/Resources/codex";

delete process.env.CODEX_AGENT_LINK_CODEX_BIN;
delete process.env.CODEX_BIN;

const candidates = codexBinaryCandidates();
assert.ok(candidates.includes(CHATGPT_CLI), "ChatGPT's bundled codex-cli path is a candidate");
assert.ok(
  candidates.indexOf(CHATGPT_CLI) < candidates.indexOf(STALE_DESKTOP),
  "ChatGPT's codex-cli is preferred over /Applications/Codex.app"
);

process.env.CODEX_AGENT_LINK_CODEX_BIN = "/explicit/codex";
assert.equal(codexBinaryCandidates()[0], "/explicit/codex", "explicit override still wins");
delete process.env.CODEX_AGENT_LINK_CODEX_BIN;

console.log("codex binary selection tests passed");
