// Notices when the same question comes back. The companion answers fresh every
// time; the count only informs tone and the family's insights.

const STOP = new Set(
  'a an the is are was were be am do does did i me my you your to of in on at for and or it its that this what whats when where who whos how why will can could would should please today now there here yet so just again oh well um uh'.split(
    ' ',
  ),
);

const QUESTION_START = /^(what|whats|what's|when|where|who|whos|who's|how|why|is|are|do|does|did|will|can|could|have|has|am)\b/i;

export function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith('?') || QUESTION_START.test(t);
}

export function keyTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/'s$/, ''))
      .filter((w) => w && !STOP.has(w)),
  );
}

export function similarity(a: string, b: string): number {
  const A = keyTokens(a);
  const B = keyTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** How many times today something like this question was already asked. */
export function repeatCount(text: string, earlier: string[]): number {
  if (!isQuestion(text)) return 0;
  return earlier.filter((e) => isQuestion(e) && similarity(text, e) >= 0.5).length;
}
