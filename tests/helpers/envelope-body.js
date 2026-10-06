// Test helper: the (escaped) body text of every peer envelope in `text`.
// Tool results carry bodies only inside envelopes, so tests read them here.
export function envelopeBodies(text) {
  return [...String(text ?? "").matchAll(/<body>\n([\s\S]*?)\n<\/body>/g)].map((match) => match[1]);
}

export function envelopeBody(text) {
  const bodies = envelopeBodies(text);
  if (bodies.length !== 1) throw new Error(`expected exactly one envelope body, found ${bodies.length}`);
  return bodies[0];
}
