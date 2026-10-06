// Sidecar fields are optional (title is absent until one is generated, and
// may be null), so every field is read through lower().
const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

export function resolveSession({ query }, sessions) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { best: null, candidates: [], selection: { ambiguous: false, matchReasons: [] } };
  const scored = [];
  for (const s of sessions) {
    const reasons = [];
    let score = 0;
    if (lower(s.sessionId) === q)                   { score += 100; reasons.push("sessionId-exact"); }
    else if (lower(s.sessionId).includes(q))        { score += 60;  reasons.push("sessionId-partial"); }
    if (lower(s.cliSessionId).includes(q))          { score += 50;  reasons.push("cliSessionId-partial"); }
    if (lower(s.title).includes(q))                 { score += 40;  reasons.push("title-substring"); }
    if (lower(s.processName).includes(q))           { score += 30;  reasons.push("processName-substring"); }
    if (lower(s.cwd).includes(q))                   { score += 20;  reasons.push("cwd-substring"); }
    if ((Array.isArray(s.userSelectedFolders) ? s.userSelectedFolders : []).some(f => lower(f).includes(q))) {
                                                       score += 20;  reasons.push("folder-substring"); }
    if (score > 0) scored.push({ session: s, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { best: null, candidates: [], selection: { ambiguous: false, matchReasons: [] } };
  const top = scored[0];
  const tied = scored.filter(c => c.score === top.score);
  return {
    best: top.session,
    candidates: scored.map(c => ({ ...c.session, score: c.score, matchReasons: c.reasons })),
    selection: { ambiguous: tied.length > 1, matchReasons: top.reasons }
  };
}
