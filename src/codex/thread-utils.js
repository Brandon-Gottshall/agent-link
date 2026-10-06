import { truncate } from "../shared/text.js";

const MAX_REASON_TEXT = 160;

export function normalizeArchiveScope(args = {}) {
  if (args.archiveScope === "active" || args.archiveScope === "archived" || args.archiveScope === "all") {
    return args.archiveScope;
  }
  return args.archived === true ? "archived" : "active";
}

export function inferArchiveState(threadOrPath) {
  const path = typeof threadOrPath === "string"
    ? threadOrPath
    : threadOrPath?.path ?? null;

  if (!path) {
    return {
      scope: "unknown",
      inferredFrom: "missingPath",
      path: null
    };
  }

  if (path.includes("/archived_sessions/")) {
    return {
      scope: "archived",
      inferredFrom: "path",
      path
    };
  }

  if (path.includes("/sessions/")) {
    return {
      scope: "active",
      inferredFrom: "path",
      path
    };
  }

  return {
    scope: "unknown",
    inferredFrom: "path",
    path
  };
}

export function desktopVisibilityContract(appServerSummary = {}) {
  return {
    state: "unknown",
    controlledByAgentLink: false,
    appServerTarget: appServerSummary.managed ? "managed-app-server" : "configured-app-server",
    note: "Message delivery, thread/resume, turn/start, and route acknowledgements are app-server operations; they do not prove GUI sidebar membership unless desktop/sidebar/state/read reports authority exactly rendererSidebarModel."
  };
}

export function loadedStateSemantics() {
  return {
    loaded: "Currently present in the reachable app-server runtime.",
    persisted: "Present in Codex JSONL/session storage and readable or resumable by app-server.",
    archived: "Stored under archived_sessions when path metadata exposes that location.",
    desktopVisible: "Whether Codex Desktop visually shows or selects the thread; Agent Link cannot prove this from app-server delivery alone.",
    sidebarMembership: "in_sidebar_model/background_only is only authoritative when desktop/sidebar/state/read reports authority exactly rendererSidebarModel; background_only means absent from ordinary sidebar sections or explicitly grouped under background-threads."
  };
}

export function sidebarMembershipSemantics() {
  return {
    values: ["in_sidebar_model", "background_only", "unknown"],
    authorityRequired: "rendererSidebarModel",
    warning: "Runtime-loaded state, message delivery, and route acknowledgements do not prove GUI sidebar membership. Treat sidebarMembership as authoritative only when sidebarState.authority is exactly rendererSidebarModel."
  };
}

export function unsupportedSidebarStateResponse(reason, extra = {}) {
  return {
    authority: "unsupported",
    modelVersion: 1,
    generatedAt: null,
    selectedThreadKey: null,
    settings: { organizeMode: null, sortKey: null },
    sections: [],
    items: [],
    indexes: {
      localThreadIds: [],
      navigationThreadKeys: [],
      visibleSidebarSectionKeys: []
    },
    reason,
    ...extra
  };
}

export function normalizeSidebarStateResponse(response = null) {
  if (!response || typeof response !== "object") {
    return {
      ok: false,
      supported: null,
      authority: null,
      modelVersion: null,
      generatedAt: null,
      selectedThreadKey: null,
      localThreadIds: [],
      selectedLocalThreadId: null,
      sectionKeys: [],
      navigationThreadKeys: [],
      visibleSidebarSectionKeys: [],
      unsupported: null,
      raw: response ?? null,
      note: "No sidebar state response was returned; Agent Link will not infer GUI sidebar membership."
    };
  }

  const authority = typeof response.authority === "string" ? response.authority : null;
  const unsupported = normalizeUnsupportedSidebarState(response);
  const localThreadIds = extractSidebarLocalThreadIds(response);
  return {
    ok: true,
    supported: unsupported ? false : authority === "rendererSidebarModel",
    authority,
    modelVersion: response.modelVersion ?? null,
    generatedAt: response.generatedAt ?? null,
    selectedThreadKey: optionalStringValue(response.selectedThreadKey),
    settings: response.settings && typeof response.settings === "object" ? response.settings : {},
    sections: Array.isArray(response.sections) ? response.sections : [],
    items: Array.isArray(response.items) ? response.items : [],
    indexes: response.indexes && typeof response.indexes === "object"
      ? response.indexes
      : {
          localThreadIds,
          navigationThreadKeys: [],
          visibleSidebarSectionKeys: []
        },
    localThreadIds,
    localThreadIdsCount: localThreadIds.length,
    normalSidebarLocalThreadIds: extractNormalSidebarLocalThreadIds(response),
    backgroundThreadIds: extractBackgroundSidebarThreadIds(response),
    selectedLocalThreadId: selectedLocalThreadIdFromSidebarState(response),
    sectionKeys: Array.isArray(response.sections)
      ? response.sections.map((section) => optionalStringValue(section?.key)).filter(Boolean)
      : [],
    navigationThreadKeys: Array.isArray(response.indexes?.navigationThreadKeys)
      ? response.indexes.navigationThreadKeys.map(optionalStringValue).filter(Boolean)
      : [],
    visibleSidebarSectionKeys: Array.isArray(response.indexes?.visibleSidebarSectionKeys)
      ? response.indexes.visibleSidebarSectionKeys.map(optionalStringValue).filter(Boolean)
      : [],
    unsupported,
    raw: response,
    note: authority === "rendererSidebarModel"
      ? "Sidebar membership is backed by the renderer sidebar model sections."
      : "Sidebar membership is unknown unless authority is exactly rendererSidebarModel; no fallback inference is used."
  };
}

export function classifySidebarMembership(threadId, sidebarState) {
  const id = optionalStringValue(threadId);
  if (!id || sidebarState?.authority !== "rendererSidebarModel" || !Array.isArray(sidebarState.localThreadIds)) {
    return "unknown";
  }
  const backgroundThreadIds = new Set(
    Array.isArray(sidebarState.backgroundThreadIds)
      ? sidebarState.backgroundThreadIds
      : extractBackgroundSidebarThreadIds(sidebarState)
  );
  if (backgroundThreadIds.has(id)) {
    return "background_only";
  }
  const normalSidebarLocalThreadIds = Array.isArray(sidebarState.normalSidebarLocalThreadIds)
    ? sidebarState.normalSidebarLocalThreadIds
    : extractNormalSidebarLocalThreadIds(sidebarState);
  if (normalSidebarLocalThreadIds.length > 0) {
    return normalSidebarLocalThreadIds.includes(id) ? "in_sidebar_model" : "background_only";
  }
  return sidebarState.localThreadIds.includes(id) ? "in_sidebar_model" : "background_only";
}

export function buildStateContract({ action, initialThread, beforeSendThread, turn, turnId, appServer }) {
  return {
    delivery: {
      state: "accepted_by_app_server",
      action,
      turnId: turn?.id ?? turnId ?? null
    },
    runtimeState: {
      source: "app-server",
      initialStatus: initialThread?.status ?? null,
      statusBeforeSend: beforeSendThread?.status ?? null,
      targetTurnStatus: turn?.status ?? null
    },
    archiveState: {
      initial: inferArchiveState(initialThread),
      beforeSend: inferArchiveState(beforeSendThread),
      note: "Archive state is inferred from persisted path metadata when available; resume/message does not imply Desktop unarchive."
    },
    desktopVisibility: desktopVisibilityContract(appServer)
  };
}

export function isRiskyParallelStatus(status) {
  const type = String(status?.type ?? "").toLowerCase();
  if (!type || type === "idle" || type === "notloaded" || type === "unknown") {
    return false;
  }
  return [
    "active",
    "waiting",
    "awaiting",
    "running",
    "progress",
    "pending",
    "queued",
    "possiblyactive"
  ].some((needle) => type.includes(needle));
}

export function activeTurnWarning(status, mode) {
  return {
    code: "target-active-or-waiting-turn",
    severity: "warning",
    status,
    mode,
    message: "Target has an active or waiting turn; starting another turn may create parallel state. Use steering or set allowParallelTurn=true intentionally."
  };
}

export function scoreThreadMatch(thread, query) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) {
    return { score: 0, reasons: [] };
  }

  const fields = [
    ["id", thread.id, 120],
    ["name", thread.name, 90],
    ["preview", thread.preview, 55],
    ["lastAgentMessage", thread.lastAgentMessage, 45],
    ["cwd", thread.cwd, 30],
    ["path", thread.path, 20],
    ["archiveState", thread.archiveState?.scope, 10]
  ];

  let score = 0;
  const reasons = [];
  for (const [field, value, weight] of fields) {
    const text = String(value ?? "");
    const normalizedText = normalizeSearch(text);
    if (!normalizedText) {
      continue;
    }

    let reasonScore = 0;
    let kind = null;
    if (labeledLineMatches(text, normalizedQuery)) {
      reasonScore = weight * 4;
      kind = "labeled";
    } else if (normalizedText === normalizedQuery) {
      reasonScore = weight * 4;
      kind = "exact";
    } else if (normalizedText.startsWith(normalizedQuery)) {
      reasonScore = weight * 3;
      kind = "prefix";
    } else if (normalizedText.includes(normalizedQuery)) {
      reasonScore = weight * 2;
      kind = "contains";
    } else if (allTokensPresent(normalizedText, normalizedQuery)) {
      reasonScore = weight;
      kind = "tokens";
    }

    if (reasonScore > 0) {
      const matchIndex = normalizedText.indexOf(normalizedQuery);
      if (matchIndex >= 0) {
        reasonScore += Math.max(0, Math.floor(weight * (1 - Math.min(matchIndex, 500) / 500)));
      }
      score += reasonScore;
      reasons.push({
        field,
        kind,
        score: reasonScore,
        text: truncate(text, MAX_REASON_TEXT)
      });
    }
  }

  return {
    score,
    reasons: reasons.sort((a, b) => b.score - a.score)
  };
}

function labeledLineMatches(value, normalizedQuery) {
  return String(value ?? "")
    .split(/\r?\n/)
    .some((line) => {
      const normalizedLine = normalizeSearch(line);
      const withoutLabel = normalizeSearch(normalizedLine.replace(/^[a-z0-9 _-]+:\s*/, ""));
      return withoutLabel === normalizedQuery || withoutLabel.startsWith(`${normalizedQuery} `);
    });
}

export function rankThreadSummaries(threads, query, limit) {
  return threads
    .map((thread) => ({
      ...thread,
      match: scoreThreadMatch(thread, query)
    }))
    .filter((thread) => thread.match.score > 0)
    .sort((a, b) => {
      if (b.match.score !== a.match.score) {
        return b.match.score - a.match.score;
      }
      return timestampMs(b.updatedAt) - timestampMs(a.updatedAt);
    })
    .slice(0, limit);
}

// updatedAt arrives as Unix seconds (app-server, local transcripts), Unix
// milliseconds, or an ISO string (summarized threads). Date.parse() of a
// number is NaN, which made every recency tie-break a no-op.
export function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) {
      return timestampMs(Number(value));
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function suggestThreadIds(threads, threadId, limit = 3) {
  const needle = normalizeId(threadId);
  if (!needle) {
    return [];
  }

  return threads
    .map((thread) => {
      const candidate = normalizeId(thread.id);
      const prefix = commonPrefixLength(needle, candidate);
      const distance = boundedEditDistance(needle, candidate, 8);
      const score = prefix * 4 + Math.max(0, 12 - distance);
      return {
        id: thread.id,
        name: thread.name ?? null,
        preview: truncate(thread.preview ?? "", MAX_REASON_TEXT),
        cwd: thread.cwd ?? null,
        archiveState: thread.archiveState ?? inferArchiveState(thread),
        score,
        reason: `commonPrefix=${prefix}, editDistance=${distance}`
      };
    })
    .filter((candidate) => candidate.score >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function extractFinalResponse(thread, targetTurnId = null) {
  const turns = thread?.turns ?? [];
  const targetTurn = targetTurnId
    ? [...turns].reverse().find((turn) => turn.id === targetTurnId) ?? null
    : null;

  if (targetTurn) {
    const targetResponse = responseFromTurn(targetTurn, "targetTurn");
    if (targetResponse.text) {
      return targetResponse;
    }
    const fallbackTurn = [...turns]
      .reverse()
      .find((turn) => turn.id !== targetTurnId && hasAgentText(turn));
    if (fallbackTurn) {
      return {
        ...responseFromTurn(fallbackTurn, "latestTurnFallback"),
        requestedTurnId: targetTurnId
      };
    }
    return targetResponse;
  }

  const latestTurn = [...turns]
    .reverse()
    .find((turn) => hasAgentText(turn)) ?? [...turns].reverse()[0] ?? null;
  if (latestTurn) {
    return responseFromTurn(latestTurn, "latestTurn");
  }

  const recentItems = thread?.recentItems ?? [];
  const item = [...recentItems]
    .reverse()
    .find((entry) => ["agentMessage", "assistantMessage"].includes(entry.type) && entry.text);
  return {
    turnId: null,
    turnStatus: thread?.status?.type ?? null,
    completedAt: null,
    text: item?.text ?? null,
    phase: null,
    source: item ? "recentItems" : "none"
  };
}

export function analyzeThreadWaitState(thread, targetTurnId = null) {
  const turns = thread?.turns ?? [];
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const observedTurn = targetTurnId
    ? [...turns].reverse().find((turn) => turn.id === targetTurnId) ?? null
    : latestTurn;
  const observedResponse = observedTurn
    ? responseFromTurn(observedTurn, targetTurnId ? "targetTurn" : "latestTurn")
    : extractFinalResponse(thread, targetTurnId);
  const finalResponse = observedResponse.text
    ? observedResponse
    : extractFinalResponse(thread, targetTurnId);
  const hasCompletedFinalResponse = observedTurn?.status === "completed"
    && typeof observedResponse.text === "string"
    && observedResponse.text.trim().length > 0;
  const topLevelStatus = thread?.status ?? null;
  const topLevelActive = String(topLevelStatus?.type ?? "").toLowerCase() === "active";
  const activeTurns = turns
    .filter((turn) => turn.status === "inProgress")
    .map((turn) => ({
      id: turn.id ?? null,
      startedAt: turn.startedAt ?? null
    }));
  const staleTopLevelStatus = topLevelActive && hasCompletedFinalResponse;
  const warnings = [];

  if (staleTopLevelStatus) {
    warnings.push({
      code: "stale-top-level-active-status",
      severity: "warning",
      message: "The app-server top-level thread status is still active, but the observed turn has a completed final response. Agent Link is treating the wait as complete and surfacing this status inconsistency.",
      topLevelStatus,
      observedTurnId: observedTurn?.id ?? null,
      observedTurnStatus: observedTurn?.status ?? null,
      activeTurnIds: activeTurns.map((turn) => turn.id).filter(Boolean)
    });
  }

  return {
    topLevelStatus,
    topLevelActive,
    activeTurns,
    latestTurnId: latestTurn?.id ?? null,
    latestTurnStatus: latestTurn?.status ?? null,
    observedTurnId: observedTurn?.id ?? null,
    observedTurnStatus: observedTurn?.status ?? null,
    finalResponse,
    hasCompletedFinalResponse,
    staleTopLevelStatus,
    shouldContinueWaiting: topLevelActive && !hasCompletedFinalResponse,
    warnings
  };
}

function hasAgentText(turn) {
  return Boolean(findAgentMessage(turn));
}

function responseFromTurn(turn, source) {
  const message = findAgentMessage(turn);
  return {
    turnId: turn?.id ?? null,
    turnStatus: turn?.status ?? null,
    completedAt: turn?.completedAt ?? null,
    text: message?.text ?? null,
    phase: message?.phase ?? null,
    source
  };
}

function findAgentMessage(turn) {
  return [...(turn?.items ?? [])]
    .reverse()
    .find((item) => ["agentMessage", "assistantMessage"].includes(item.type) && item.text);
}

function normalizeUnsupportedSidebarState(response) {
  const unsupportedValue = response.unsupported ?? response.notSupported;
  const authority = typeof response.authority === "string" ? response.authority : null;
  const explicitlyUnsupported = unsupportedValue === true
    || authority === "unsupported"
    || response.supported === false;

  if (!explicitlyUnsupported) {
    return null;
  }

  const unsupportedObject = unsupportedValue && typeof unsupportedValue === "object" ? unsupportedValue : {};
  return {
    explicit: true,
    reason: optionalStringValue(
      unsupportedObject.reason
      ?? response.reason
      ?? response.message
      ?? response.error?.message
    ),
    code: optionalStringValue(
      unsupportedObject.code
      ?? response.code
      ?? response.error?.code
    )
  };
}

function extractSidebarLocalThreadIds(response) {
  const candidate = response.localThreadIds
    ?? response.indexes?.localThreadIds
    ?? response.threadIds
    ?? response.localIndex?.threadIds
    ?? response.localIndex?.localThreadIds
    ?? response.sidebarLocalIndex?.threadIds
    ?? response.sidebarLocalIndex?.localThreadIds
    ?? response.sidebar?.localThreadIds
    ?? response.sidebar?.threadIds;

  if (Array.isArray(candidate)) {
    return candidate
      .map((entry) => optionalStringValue(typeof entry === "string" ? entry : entry?.id ?? entry?.threadId ?? entry?.localThreadId))
      .filter(Boolean);
  }

  if (candidate && typeof candidate === "object") {
    return Object.keys(candidate).filter(Boolean);
  }

  if (Array.isArray(response.items)) {
    return response.items
      .map((item) => {
        const explicit = optionalStringValue(item?.threadId ?? item?.localThreadId);
        if (explicit) {
          return explicit;
        }
        const key = optionalStringValue(item?.key);
        if (!key?.startsWith("local:")) {
          return null;
        }
        return key.slice("local:".length);
      })
      .filter(Boolean);
  }

  return [];
}

function extractNormalSidebarLocalThreadIds(response) {
  return extractSectionLocalThreadIds(response, (section) => section?.key !== "background-threads");
}

function extractBackgroundSidebarThreadIds(response) {
  return extractSectionLocalThreadIds(response, (section) => section?.key === "background-threads");
}

function extractSectionLocalThreadIds(response, includeSection) {
  if (!Array.isArray(response?.sections)) {
    return [];
  }
  const ids = [];
  for (const section of response.sections) {
    if (!includeSection(section) || !Array.isArray(section?.itemKeys)) {
      continue;
    }
    for (const itemKey of section.itemKeys) {
      const key = optionalStringValue(itemKey);
      if (key?.startsWith("local:")) {
        ids.push(key.slice("local:".length));
      }
    }
  }
  return Array.from(new Set(ids));
}

function selectedLocalThreadIdFromSidebarState(response) {
  const explicit = optionalStringValue(
    response.selectedLocalThreadId
    ?? response.selectedThreadId
    ?? response.selection?.localThreadId
    ?? response.selection?.threadId
  );
  if (explicit) {
    return explicit;
  }
  const selectedThreadKey = optionalStringValue(response.selectedThreadKey);
  if (selectedThreadKey?.startsWith("local:")) {
    return selectedThreadKey.slice("local:".length);
  }
  return null;
}

function optionalStringValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function allTokensPresent(text, query) {
  const tokens = query.split(" ").filter(Boolean);
  return tokens.length > 1 && tokens.every((token) => text.includes(token));
}

function normalizeId(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function commonPrefixLength(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function boundedEditDistance(a, b, maxDistance) {
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
    previous = current;
  }
  return previous[b.length];
}
