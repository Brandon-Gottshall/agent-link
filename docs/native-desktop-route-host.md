# Codex Desktop Native Route Host Contract

This note captures the Desktop-side implementation target for quiet thread routing.
Agent Link and Antechamber can request and verify the route, but only Codex Desktop
can select a GUI thread without stealing focus.

## Current local state

- `/Applications/Codex.app/Contents/Resources/codex` reports `codex-cli 0.130.0-alpha.5`.
- A local overlay is installed at `/Applications/Codex.app` by a separate quiet-route patch tool (not included in this repo).
- The installed app-server accepts `desktop/thread/route` and `desktop/thread/selection/read`.
- The installed Electron bundle is minified and does not include source maps, but now contains handlers for `desktop/thread/route/request` and `desktop/thread/selection/read/request`.
- The Desktop bridge publishes `~/Library/Application Support/CodexDesktopQuietRoutePatch/desktop-app-server.json` only when parented by `/Applications/Codex.app/Contents/MacOS/Codex`.
- Agent Link rejects forged or stale Desktop endpoint files unless the endpoint proves a Codex Desktop parent process.
- Current live validation has proven `nativeQuietRoute` readback with matching thread id and `focused:false`.

## App-server client methods

Route request clients call:

```json
{
  "method": "desktop/thread/route",
  "params": {
    "threadId": "019...",
    "focus": false
  }
}
```

Selection read clients call:

```json
{
  "method": "desktop/thread/selection/read",
  "params": {}
}
```

If no Desktop host proves the route, app-server returns a downgrade such as
`authority: "validatedOnly"` for route or `authority: "unsupported"` for selection
read. Agent Link must preserve the created thread and surface that downgrade.

## Desktop host server requests

After Desktop initializes as a recognized host, app-server forwards route work to
Desktop with:

```json
{
  "method": "desktop/thread/route/request",
  "params": {
    "threadId": "019...",
    "focus": false
  }
}
```

Desktop must respond:

```json
{
  "threadId": "019...",
  "focus": false,
  "routed": true,
  "authority": "nativeQuietRoute",
  "selection": {
    "threadId": "019...",
    "focused": false
  },
  "reason": null
}
```

App-server also forwards selection readback:

```json
{
  "method": "desktop/thread/selection/read/request",
  "params": {}
}
```

Desktop must respond:

```json
{
  "selection": {
    "threadId": "019...",
    "focused": false
  },
  "authority": "nativeQuietRoute",
  "reason": null
}
```

## Quiet route invariants

For `focus: false`, Desktop must:

- select or load the requested thread internally;
- avoid activating or raising the app;
- avoid stealing keyboard focus;
- avoid changing the frontmost app;
- read back the selected thread id;
- report `selection.focused: false`.

For failure, Desktop must return `routed: false` with a reason rather than claiming
`nativeQuietRoute`. The app-server validation layer downgrades host responses that:

- echo a different `threadId`;
- echo a different `focus` value;
- omit selection readback;
- report a selected thread that does not match the requested thread;
- report `selection.focused: true` for a quiet route;
- claim any authority other than `nativeQuietRoute`.

## Local validation commands

Use these contract checks for the route-aware app-server and host harness:

```bash
CODEX_AGENT_LINK_APP_SERVER_BIN=/path/to/codex-app-server npm run smoke:app-server-native-route-contract
CODEX_AGENT_LINK_APP_SERVER_BIN=/path/to/codex-app-server npm run smoke:app-server-native-route-host
CODEX_AGENT_LINK_APP_SERVER_BIN=/path/to/codex-app-server CODEX_AGENT_LINK_ANTECHAMBER_CLI=/path/to/agent-browser-broker npm run smoke:launch-thread-antechamber-native-route-host
```

The first command proves the methods exist and downgrade without a host. The second
proves app-server accepts a recognized Desktop host with unfocused readback. The
third proves Agent Link, Antechamber, the route helper, app-server, and a Desktop
host can return `native_quiet_route` end to end without opening the real GUI.

The installed app-server and Desktop host can be checked with:

```bash
npm run inspect:installed-desktop-route-host
node ./scripts/codex-native-route.js route-thread --thread-id <thread-id> --focus false --json
CODEX_AGENT_LINK_AUTOSTART=1 node ./scripts/codex-native-route.js selection-read --json
npm run inspect:installed-desktop-route-host -- --route-thread-id <thread-id> --json
npm run smoke:launch-thread-antechamber-native-route-live -- --json
```

The strongest proof is the final command. It first requests a quiet route for the
given real thread, then reads selection back through the same live Desktop bridge.
Treat Stage 2 as proven only when the result contains:

- `routeProbe.authority: "nativeQuietRoute"`;
- `routeProbe.selectedThreadId` matching the requested thread;
- `routeProbe.focused: false`;
- top-level `authority: "nativeQuietRoute"`;
- top-level `focused: false`;
- `connection.parentCommand` ending in `/Contents/MacOS/Codex`.

Without `--route-thread-id`, the installed-app inspection script is non-mutating.
It reads `/Applications/Codex.app/Contents/Resources/app.asar` for route-host
readiness strings and performs only a selection-read app-server probe. It does
not open Codex Desktop, activate windows, or route a thread.

`smoke:launch-thread-antechamber-native-route-live` is the full live-path proof:
it creates a new durable Codex thread through the installed Agent Link MCP server,
asks the real Antechamber broker for `native_quiet_route`, lets Antechamber invoke
Agent Link's route helper, and then performs a follow-up selection read. It fails
unless the created thread id, routed thread id, and readback thread id all match
and the focused flag is `false`.

## Installed Electron host shape

The installed main-process app-server client currently handles forwarded
app-server requests generically:

```js
if (isServerRequest(message)) {
  broadcastToWindows({
    type: "mcp-request",
    hostId,
    request: message
  });
}
```

The native Desktop host implementation should intercept the two quiet-thread
server requests before that generic broadcast:

```js
if (message.method === "desktop/thread/route/request") {
  const result = await desktopThreadRouter.routeThread(message.params);
  sendMessage({ id: message.id, result });
  return;
}

if (message.method === "desktop/thread/selection/read/request") {
  const result = await desktopThreadRouter.readSelection(message.params);
  sendMessage({ id: message.id, result });
  return;
}
```

For `focus: false`, the local overlay creates or reuses a hidden, non-focusable
secondary Codex window with initial route `/local/<threadId>`. Reuse sends the
renderer navigation message for `/local/<threadId>`. It does not restore, show,
focus, or navigate the user's active Codex window for quiet routes. If the quiet
route window is destroyed, it returns `routed:false` with a reason so Antechamber
can keep the request as a handoff or owner-present deep-link fallback.

The current overlay records selected-thread state inside the Desktop host and
uses that for selection readback. A future upstream implementation should prefer
renderer-confirmed readback when Codex exposes a stable internal selection
signal.
