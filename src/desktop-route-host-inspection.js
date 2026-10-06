import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CodexAppServerClient } from "./app-server-client.js";

export async function inspectInstalledCodexDesktopRouteHost(options = {}) {
  const appPath = options.appPath || process.env.CODEX_AGENT_LINK_CODEX_APP || "/Applications/Codex.app";
  const checkAppServer = options.checkAppServer !== false;
  const routeThreadId = options.routeThreadId || null;
  const result = {
    app: inspectApp(appPath),
    desktopBundle: inspectBundle(appPath),
    appServerSelectionRead: checkAppServer
      ? await probeAppServerSelectionRead({ routeThreadId })
      : {
          checked: false,
          reason: "app-server probe disabled"
        }
  };

  result.stage2Readiness = summarizeReadiness(result);
  return result;
}

export function printInstalledCodexDesktopRouteHostInspection(probe) {
  const version = probe.app.codexVersion?.value ?? probe.app.codexVersion?.error ?? "unknown";
  process.stdout.write(`Codex app: ${probe.app.path}\n`);
  process.stdout.write(`Codex binary: ${probe.app.codexBinExists ? "found" : "missing"} (${version})\n`);
  process.stdout.write(`Desktop bundle: ${probe.desktopBundle.exists ? "found" : "missing"}\n`);

  if (probe.desktopBundle.exists) {
    const strings = probe.desktopBundle.strings;
    process.stdout.write(`Desktop identity string: ${strings.clientInfoCodexDesktop ? "present" : "missing"}\n`);
    process.stdout.write(`Generic server-request bridge: ${strings.genericServerRequestBridge ? "present" : "missing"}\n`);
    process.stdout.write(`Native route handler: ${strings.nativeRouteRequestHandler ? "present" : "missing"}\n`);
    process.stdout.write(`Native selection-read handler: ${strings.nativeSelectionReadRequestHandler ? "present" : "missing"}\n`);
    process.stdout.write(`Deep-link/focus code: ${strings.codexThreadDeepLinks && strings.explicitFocusCall ? "present" : "not detected"}\n`);
  }

  if (probe.appServerSelectionRead.checked) {
    process.stdout.write(`App-server selection-read method: ${probe.appServerSelectionRead.clientMethodAvailable ? "available" : "unavailable"}\n`);
    process.stdout.write(`App-server route authority: ${probe.appServerSelectionRead.authority}\n`);
    if (probe.appServerSelectionRead.routeProbe?.checked) {
      process.stdout.write(`App-server route probe: ${probe.appServerSelectionRead.routeProbe.readyForNativeQuietRoute ? "passed" : "failed"}\n`);
    }
    if (probe.appServerSelectionRead.reason) {
      process.stdout.write(`App-server reason: ${probe.appServerSelectionRead.reason}\n`);
    }
  }

  process.stdout.write(`Stage 2 native quiet route: ${probe.stage2Readiness.readyForStage2NativeQuietRoute ? "ready" : "not ready"}\n`);
  for (const reason of probe.stage2Readiness.reasons) {
    process.stdout.write(`- ${reason}\n`);
  }
}

function inspectApp(app) {
  const codexBin = path.join(app, "Contents", "Resources", "codex");
  return {
    path: app,
    exists: existsSync(app),
    codexBin,
    codexBinExists: existsSync(codexBin),
    codexVersion: existsSync(codexBin) ? runVersion(codexBin) : null
  };
}

function inspectBundle(app) {
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  const exists = existsSync(asarPath);
  if (!exists) {
    return {
      asarPath,
      exists: false,
      sizeBytes: null,
      strings: {},
      nativeQuietRouteHostPresent: false
    };
  }

  const bundle = readFileSync(asarPath);
  const strings = {
    clientInfoCodexDesktop: contains(bundle, "Codex Desktop"),
    serviceNameCodexDesktop: contains(bundle, "codex_desktop"),
    genericServerRequestBridge: contains(bundle, "mcp-request") && contains(bundle, "Server request received"),
    nativeRouteRequestHandler: contains(bundle, "desktop/thread/route/request"),
    nativeSelectionReadRequestHandler: contains(bundle, "desktop/thread/selection/read/request"),
    navigateToRouteBridge: contains(bundle, "navigate-to-route"),
    codexThreadDeepLinks: contains(bundle, "codex://threads"),
    explicitFocusCall: contains(bundle, "focus()"),
    inactiveShowApi: contains(bundle, "showInactive")
  };

  return {
    asarPath,
    exists: true,
    sizeBytes: statSync(asarPath).size,
    strings,
    nativeQuietRouteHostPresent: strings.nativeRouteRequestHandler && strings.nativeSelectionReadRequestHandler
  };
}

async function probeAppServerSelectionRead(options = {}) {
  const appServer = new CodexAppServerClient({
    autoStart: true,
    requestTimeoutMs: 15000,
    startupTimeoutMs: 15000
  });

  try {
    let routeProbe = null;
    if (options.routeThreadId) {
      const route = await retryRequest({
        attempts: 3,
        delayMs: 750,
        request: () => appServer.request("desktop/thread/route", {
          threadId: options.routeThreadId,
          focus: false
        }),
        isProven: (value) => normalizeRouteProbe(options.routeThreadId, value).readyForNativeQuietRoute
      });
      routeProbe = normalizeRouteProbe(options.routeThreadId, route);
    }

    const readback = await retryRequest({
      attempts: 3,
      delayMs: 750,
      request: () => appServer.request("desktop/thread/selection/read", {}),
      isProven: (value) => {
        const focused = typeof value?.selection?.focused === "boolean"
          ? value.selection.focused
          : null;
        return value?.authority === "nativeQuietRoute" && focused === false;
      }
    });
    const authority = readback?.authority ?? "unsupported";
    const focused = typeof readback?.selection?.focused === "boolean"
      ? readback.selection.focused
      : null;
    return {
      checked: true,
      clientMethodAvailable: true,
      desktopHostAvailable: authority === "nativeQuietRoute",
      readyForNativeQuietRoute: authority === "nativeQuietRoute" && focused === false,
      authority,
      selectedThreadId: readback?.selection?.threadId ?? null,
      focused,
      reason: readback?.reason ?? null,
      routeProbe,
      connection: appServer.getConnectionSummary()
    };
  } catch (error) {
    return {
      checked: true,
      clientMethodAvailable: false,
      desktopHostAvailable: false,
      readyForNativeQuietRoute: false,
      authority: "unsupported",
      selectedThreadId: null,
      focused: null,
      reason: error.message,
      routeProbe: null,
      installedBuildMissingRouteMethods: isUnknownNativeRouteMethod(error)
    };
  } finally {
    await appServer.close();
  }
}

async function retryRequest({ attempts, delayMs, request, isProven }) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await request();
      lastResult = result;
      lastError = null;
      if (isProven(result) || attempt === attempts) {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }
    }
    await sleep(delayMs);
  }
  if (lastError) {
    throw lastError;
  }
  return lastResult;
}

function normalizeRouteProbe(threadId, route) {
  const authority = route?.authority ?? "unsupported";
  const focused = typeof route?.selection?.focused === "boolean"
    ? route.selection.focused
    : null;
  return {
    checked: true,
    requestedThreadId: threadId,
    routed: route?.routed === true,
    authority,
    selectedThreadId: route?.selection?.threadId ?? null,
    focused,
    readyForNativeQuietRoute: route?.routed === true
      && authority === "nativeQuietRoute"
      && route?.selection?.threadId === threadId
      && focused === false,
    reason: route?.reason ?? null
  };
}

function summarizeReadiness(probe) {
  const reasons = [];
  if (!probe.app.exists) {
    reasons.push(`Codex.app was not found at ${probe.app.path}`);
  }
  if (!probe.app.codexBinExists) {
    reasons.push(`Codex app-server binary was not found at ${probe.app.codexBin}`);
  }
  if (!probe.desktopBundle.exists) {
    reasons.push(`Codex Desktop app.asar was not found at ${probe.desktopBundle.asarPath}`);
  }
  if (probe.desktopBundle.exists && !probe.desktopBundle.strings.clientInfoCodexDesktop) {
    reasons.push("Desktop bundle does not expose the expected Codex Desktop client identity string.");
  }
  if (probe.desktopBundle.exists && !probe.desktopBundle.nativeQuietRouteHostPresent) {
    reasons.push("Desktop bundle does not contain native route/readback server-request handlers.");
  }
  if (probe.appServerSelectionRead.checked && !probe.appServerSelectionRead.clientMethodAvailable) {
    reasons.push("Connected app-server does not recognize desktop/thread/selection/read.");
  }
  const routeProbeReady = probe.appServerSelectionRead.routeProbe?.readyForNativeQuietRoute === true;
  if (probe.appServerSelectionRead.checked
    && probe.appServerSelectionRead.clientMethodAvailable
    && !probe.appServerSelectionRead.desktopHostAvailable
    && !routeProbeReady) {
    reasons.push("App-server recognizes selection readback, but no Desktop host proved nativeQuietRoute.");
  }

  const ready = probe.app.exists
    && probe.app.codexBinExists
    && probe.desktopBundle.nativeQuietRouteHostPresent
    && (probe.appServerSelectionRead.readyForNativeQuietRoute === true || routeProbeReady);

  return {
    readyForStage2NativeQuietRoute: ready,
    status: ready ? "ready" : "not_ready",
    reasons
  };
}

function runVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 5000
  });
  if (result.error) {
    return {
      ok: false,
      value: null,
      error: result.error.message
    };
  }
  return {
    ok: result.status === 0,
    value: (result.stdout || result.stderr).trim() || null,
    error: result.status === 0 ? null : (result.stderr || result.stdout).trim() || `exit ${result.status}`
  };
}

function contains(buffer, text) {
  return buffer.includes(Buffer.from(text));
}

function isUnknownNativeRouteMethod(error) {
  return /unknown variant `desktop\/thread\/(?:selection\/read|route)`/.test(error?.message ?? "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
