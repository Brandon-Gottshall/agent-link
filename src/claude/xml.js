// src/claude/xml.js
//
// The escaper for every Agent Link block rendered into a model-visible
// transcript (read_agent_link_inbox and the channel bridge) now lives in
// src/shared/text.js. Element text uses escapeXml; every attribute value uses
// escapeAttr. Re-exported here so existing imports keep working.

export { escapeAttr, escapeXml } from "../shared/text.js";
