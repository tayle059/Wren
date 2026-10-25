// Turns a conversation into a 0..1 engagement score: how much the person took
// part, how much they said, whether there was joy, whether there was distress.

const JOY = /\b(love(ly)?|wonderful|happy|beautiful|delightful|so nice|haha|ha ha|laugh(ed|ing)?|fun|grand|marvelous|that'?s nice)\b/i;
const DISTRESS = /\b(scared|afraid|frightened|worried|anxious|lonely|sad|confused|upset|crying|nervous)\b/i;

export interface EngagementInput {
  patientTexts: string[];
  completed: boolean;
  declined: boolean;
}

export function engagementScore({ patientTexts, completed, declined }: EngagementInput): number {
  if (declined) return 0.15; // a "no" is often about timing, not the activity itself
  if (patientTexts.length === 0) return 0;
  const words = patientTexts.reduce((n, t) => n + t.split(/\s+/).filter(Boolean).length, 0);
  const avgWords = words / patientTexts.length;
  const joy = patientTexts.some((t) => JOY.test(t));
  const distress = patientTexts.some((t) => DISTRESS.test(t));
  const score =
    0.4 * Math.min(patientTexts.length / 5, 1) +
    0.35 * Math.min(avgWords / 10, 1) +
    0.15 * (joy ? 1 : 0) +
    0.1 * (completed ? 1 : 0) -
    (distress ? 0.15 : 0);
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

export function wordCount(t: string) {
  return t.split(/\s+/).filter(Boolean).length;
}
