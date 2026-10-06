// src/claude/xml.js
//
// The one escaping implementation for every Agent Link block rendered into a
// model-visible transcript (read_agent_link_inbox and the channel bridge).
// Element text uses escapeXml; every attribute value uses escapeAttr.

export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function escapeAttr(value) {
  return escapeXml(value).replace(/["']/g, (c) => (c === '"' ? "&quot;" : "&apos;"));
}
