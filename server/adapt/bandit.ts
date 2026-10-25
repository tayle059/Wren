// Learns which activities each person enjoys, with Thompson sampling over a
// Beta posterior per activity. Engagement scores (0..1) are fractional
// rewards, so a half-hearted session counts as half a success.
import { db } from '../db.ts';
import { newId } from '../auth.ts';
import { nowIso } from '../util/time.ts';

export const ACTIVITIES = ['memory_chat', 'music', 'word_game', 'movement', 'today'] as const;
export type Activity = (typeof ACTIVITIES)[number];

export const CALMING: Activity[] = ['music', 'memory_chat', 'movement'];

export const ACTIVITY_LABELS: Record<Activity, string> = {
  memory_chat: 'Memory chat',
  music: 'Music',
  word_game: 'Word games',
  movement: 'Gentle movement',
  today: "Today's news",
};

const LIKE_HINTS: Record<Activity, RegExp> = {
  memory_chat: /\b(family|photos?|stories|storytelling|remember|old times|farm|garden(ing)?|talking)\b/i,
  music: /\b(music|songs?|sing(ing)?|hymns?|dance|dancing|radio|piano|elvis|choir)\b/i,
  word_game: /\b(puzzles?|crosswords?|word games?|games?|trivia|quiz|scrabble|riddles?)\b/i,
  movement: /\b(walk(s|ing)?|exercise|stretch(ing)?|yoga|tai chi|moving)\b/i,
  today: /\b(news|newspaper|weather|current events)\b/i,
};

const DISLIKE_SENTENCE = /[^.!?\n]*\b(hates?|dislikes?|doesn'?t (like|enjoy)|does not (like|enjoy)|not a fan of|avoid|frustrat\w*)\b[^.!?\n]*/gi;

/** Starting beliefs from what the family wrote in "About". */
export function priorsFromAbout(about: string): Record<Activity, { alpha: number; beta: number }> {
  const dislikes = (about.match(DISLIKE_SENTENCE) ?? []).join(' ');
  const likes = about.replace(DISLIKE_SENTENCE, ' ');
  const out = {} as Record<Activity, { alpha: number; beta: number }>;
  for (const a of ACTIVITIES) {
    out[a] = {
      alpha: 1 + (LIKE_HINTS[a].test(likes) ? 1.5 : 0),
      beta: 1 + (LIKE_HINTS[a].test(dislikes) ? 2 : 0),
    };
  }
  return out;
}

export function ensureStats(patientId: string, about: string) {
  const existing = db().all<{ activity: string }>('SELECT activity FROM activity_stats WHERE patient_id = ?', patientId);
  const have = new Set(existing.map((e) => e.activity));
  const priors = priorsFromAbout(about);
  for (const a of ACTIVITIES) {
    if (!have.has(a)) {
      db().run(
        'INSERT INTO activity_stats (patient_id, activity, alpha, beta, plays) VALUES (?, ?, ?, ?, 0)',
        patientId,
        a,
        priors[a].alpha,
        priors[a].beta,
      );
    }
  }
}

export interface ActivityStat {
  activity: Activity;
  alpha: number;
  beta: number;
  plays: number;
  mean: number;
}

export function stats(patientId: string): ActivityStat[] {
  return db()
    .all<{ activity: Activity; alpha: number; beta: number; plays: number }>(
      'SELECT activity, alpha, beta, plays FROM activity_stats WHERE patient_id = ?',
      patientId,
    )
    .map((s) => ({ ...s, mean: s.alpha / (s.alpha + s.beta) }))
    .sort((a, b) => b.mean - a.mean);
}

export type Rng = () => number;

function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// Marsaglia-Tsang gamma sampler.
function gamma(shape: number, rng: Rng): number {
  if (shape < 1) return gamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rng: Rng = Math.random): number {
  const x = gamma(alpha, rng);
  const y = gamma(beta, rng);
  return x / (x + y);
}

export function chooseActivity(
  patientId: string,
  opts: { calming?: boolean; avoid?: string | null; rng?: Rng } = {},
): Activity {
  const pool = stats(patientId).filter((s) => !opts.calming || CALMING.includes(s.activity));
  const candidates = pool.length > 1 ? pool.filter((s) => s.activity !== opts.avoid) : pool;
  let best: Activity = candidates[0]?.activity ?? 'memory_chat';
  let bestDraw = -1;
  for (const s of candidates) {
    const draw = sampleBeta(s.alpha, s.beta, opts.rng);
    if (draw > bestDraw) {
      bestDraw = draw;
      best = s.activity;
    }
  }
  return best;
}

export function recordOutcome(patientId: string, activity: string, score: number, hour: number, conversationId: string | null) {
  const s = Math.max(0, Math.min(1, score));
  if ((ACTIVITIES as readonly string[]).includes(activity)) {
    db().run(
      'UPDATE activity_stats SET alpha = alpha + ?, beta = beta + ?, plays = plays + 1 WHERE patient_id = ? AND activity = ?',
      s,
      1 - s,
      patientId,
      activity,
    );
  }
  db().run(
    'INSERT INTO activity_outcomes (id, patient_id, conversation_id, activity, hour, score, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(),
    patientId,
    conversationId,
    activity,
    hour,
    s,
    nowIso(),
  );
}
