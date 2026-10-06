#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-link-native-route-"));
const transportRoot = path.join(tempRoot, "transport");
const fakeBrokerPath = path.join(tempRoot, "fake-agent-browser-broker.mjs");
const threadName = `Agent Link native quiet route smoke ${new Date().toISOString()}`;

await fs.writeFile(fakeBrokerPath, fakeBrokerSource(), "utf8");
await fs.chmod(fakeBrokerPath, 0o755);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./src/server.js"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    CODEX_AGENT_LINK_AUTOSTART: "1",
    CODEX_AGENT_LINK_ANTECHAMBER_CLI: fakeBrokerPath,
    ANTECHAMBER_APPROVAL_TRANSPORT_ROOT: transportRoot
  }
});

const client = new Client({ name: "codex-agent-link-antechamber-native-route", version: "0.1.0" });

try {
  await client.connect(transport);
  const launch = await client.callTool({
    name: "launch_codex_thread",
    arguments: {
      cwd: pluginRoot,
      name: threadName,
      ephemeral: false,
      openInGui: false,
      antechamberHandoff: {
        enabled: true,
        mode: "native_quiet_route",
        expiresInSeconds: 300
      }
    }
  });
  assert.equal(launch.isError, false);

  const payload = JSON.parse(launch.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.thread.name, threadName);
  assert.equal(payload.gui.attempted, false);
  assert.equal(payload.antechamberHandoff.attempted, true);
  assert.equal(payload.antechamberHandoff.ok, true);
  assert.equal(payload.antechamberHandoff.opensTargetApp, false);
  assert.equal(payload.antechamberHandoff.authority, "native_quiet_route");
  assert.equal(payload.antechamberHandoff.routeResult.ok, true);
  assert.equal(payload.antechamberHandoff.routeResult.authority, "native_quiet_route");
  assert.equal(payload.antechamberHandoff.routeResult.routeAuthority, "nativeQuietRoute");
  assert.equal(payload.antechamberHandoff.routeResult.selectedThreadId, payload.thread.id);
  assert.equal(payload.antechamberHandoff.routeResult.focused, false);
  assert.equal(payload.antechamberHandoff.routeResult.routed, true);

  console.log(`Antechamber native quiet route smoke test passed; created ${payload.thread.id}; request ${payload.antechamberHandoff.requestId}; transportRoot=${transportRoot}`);
} finally {
  await client.close();
}

function fakeBrokerSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [command, transportRoot, ...args] = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const safe = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, "_");
const put = (key, value) => console.log(\`\${key}=\${value}\`);

if (command === "write-native-app-route-handoff") {
  const threadId = option("--thread-id");
  const routeURL = option("--route-url") || \`codex://threads/\${threadId}\`;
  const focusPolicy = option("--focus-policy") || "never";
  const requestId = \`req_fake_\${safe(threadId)}\`;
  const auditId = \`audit_fake_\${safe(threadId)}\`;
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const routesDir = path.join(transportRoot, "native-app-routes", "requests");
  const requestsDir = path.join(transportRoot, "requests");
  fs.mkdirSync(routesDir, { recursive: true });
  fs.mkdirSync(requestsDir, { recursive: true });
  const handoffPath = path.join(routesDir, \`\${requestId}.json\`);
  const requestPath = path.join(requestsDir, \`\${requestId}.json\`);
  fs.writeFileSync(handoffPath, JSON.stringify({
    schema_version: 1,
    request_id: requestId,
    surface: "codex_desktop",
    action: "route_thread",
    thread_id: threadId,
    route_url: routeURL,
    focus_policy: focusPolicy,
    authority: "handoff_only",
    requester_process_identity: "fake-broker",
    audit_correlation_id: auditId,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    status: "pending"
  }, null, 2));
  fs.writeFileSync(requestPath, JSON.stringify({ request_id: requestId, approval_class: "approve_native_app_route_handoff" }, null, 2));
  put("request_written", "true");
  put("request_id", requestId);
  put("approval_class", "approve_native_app_route_handoff");
  put("audit_correlation_id", auditId);
  put("surface", "codex_desktop");
  put("action", "route_thread");
  put("thread_id", threadId);
  put("route_url", routeURL);
  put("focus_policy", focusPolicy);
  put("authority", "handoff_only");
  put("expires_at", expiresAt);
  put("transport_root", transportRoot);
  put("handoff_path", handoffPath);
  put("request_path", requestPath);
} else if (command === "route-native-app-quietly") {
  const requestId = option("--request-id");
  const handoffPath = path.join(transportRoot, "native-app-routes", "requests", \`\${requestId}.json\`);
  const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  const auditPath = path.join(transportRoot, "native-app-routes", "audit", \`\${requestId}.json\`);
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify({ request_id: requestId, result: "routed_native_quiet" }, null, 2));
  put("native_route_attempted", "true");
  put("ok", "true");
  put("authority", "native_quiet_route");
  put("route_authority", "nativeQuietRoute");
  put("request_id", requestId);
  put("audit_correlation_id", handoff.audit_correlation_id);
  put("thread_id", handoff.thread_id);
  put("selected_thread_id", handoff.thread_id);
  put("focused", "false");
  put("routed", "true");
  put("reason", "none");
  put("transport_root", transportRoot);
  put("handoff_path", handoffPath);
  put("audit_path", auditPath);
} else {
  console.error("unexpected command", command);
  process.exit(2);
}
`;
}
