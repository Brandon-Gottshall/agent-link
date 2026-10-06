export function resolveSession({ query }, sessions) {
  const q = query.trim().toLowerCase();
  const scored = [];
  for (const s of sessions) {
    const reasons = [];
    let score = 0;
    if (s.sessionId.toLowerCase() === q)        { score += 100; reasons.push("sessionId-exact"); }
    else if (s.sessionId.toLowerCase().includes(q)) { score += 60;  reasons.push("sessionId-partial"); }
    if (s.cliSessionId?.toLowerCase().includes(q))  { score += 50;  reasons.push("cliSessionId-partial"); }
    if (s.title.toLowerCase().includes(q))           { score += 40;  reasons.push("title-substring"); }
    if (s.processName?.toLowerCase().includes(q))    { score += 30;  reasons.push("processName-substring"); }
    if (s.cwd?.toLowerCase().includes(q))            { score += 20;  reasons.push("cwd-substring"); }
    if ((s.userSelectedFolders ?? []).some(f => f.toLowerCase().includes(q))) {
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
