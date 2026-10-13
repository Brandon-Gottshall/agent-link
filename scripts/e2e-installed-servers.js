// Which installed Agent Link copies the cross-harness live E2E turns off for
// its own app-servers, from `mcpServerStatus/list` data. A server a plugin
// provides (it carries `pluginId`) is turned off through that plugin. Only a
// server defined directly under `mcp_servers` is turned off by name: for a name
// the config does not define, `-c mcp_servers.<name>.enabled=false` creates an
// entry with no command, and codex-cli 0.162.1 refuses to start ("invalid
// transport"). No live-guard import: tests load this module.

/**
 * @param {Array<{name: string, pluginId?: string | null}> | undefined} data
 * @param {{ownName: string}} options  the E2E's own injected server, never disabled
 * @returns {{mcpNames: string[], pluginIds: string[]}}
 */
export function installedAgentLinkServers(data, { ownName }) {
  const agentLink = (data ?? []).filter((sv) => sv.name !== ownName && /agent.?link/i.test(sv.name));
  return {
    mcpNames: [...new Set(agentLink.filter((sv) => !sv.pluginId).map((sv) => sv.name))],
    pluginIds: [...new Set(agentLink.filter((sv) => sv.pluginId).map((sv) => /** @type {string} */ (sv.pluginId)))]
  };
}
