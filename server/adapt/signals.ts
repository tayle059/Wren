// Gentle, non-diagnostic signals computed from everyday conversation, so a
// family can notice slow changes and bring them to a doctor.
import { db } from '../db.ts';
import { localDayRangeUtc, localParts, minutesOf, now, type LocalParts } from '../util/time.ts';
import type { Patient } from '../domain.ts';

export interface DaySignals {
  date: string;
  turns: number;
  words_per_turn: number;
  unique_ratio: number;
  repeats: number;
  engaged_minutes: number;
  sessions_offered: number;
  sessions_accepted: number;
  distress_events: number;
}

/** Moving-average type-token ratio: vocabulary richness that doesn't punish long days. */
export function mattr(words: string[], window = 50): number {
  if (words.length === 0) return 0;
  if (words.length <= window) return new Set(words).size / words.length;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + window <= words.length; i++) {
    sum += new Set(words.slice(i, i + window)).size / window;
    n++;
  }
  return sum / n;
}

export function computeSignals(patient: Patient, date: string): DaySignals {
  const { start, end } = localDayRangeUtc(patient.timezone, date);
  const texts = db()
    .all<{ text: string }>(
      `SELECT m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.patient_id = ? AND m.role = 'patient' AND m.created_at >= ? AND m.created_at < ?`,
      patient.id,
      start,
      end,
    )
    .map((r) => r.text);
  const words = texts.flatMap((t) => t.toLowerCase().replace(/[^a-z'\s]/g, ' ').split(/\s+/).filter(Boolean));
  const convs = db().all<{ started_at: string; ended_at: string | null; patient_turns: number }>(
    `SELECT c.started_at, c.ended_at,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'patient') AS patient_turns
     FROM conversations c WHERE c.patient_id = ? AND c.started_at >= ? AND c.started_at < ?`,
    patient.id,
    start,
    end,
  );
  const engaged = convs
    .filter((c) => c.patient_turns > 0 && c.ended_at)
    .reduce((m, c) => m + (Date.parse(c.ended_at!) - Date.parse(c.started_at)) / 60000, 0);
  const obs = (kind: string) =>
    db().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM observations WHERE patient_id = ? AND kind = ? AND at >= ? AND at < ?',
      patient.id,
      kind,
      start,
      end,
    )!.n;
  const runs = db().all<{ status: string }>(
    `SELECT r.status FROM schedule_runs r JOIN schedule_items s ON s.id = r.schedule_item_id
     WHERE s.patient_id = ? AND r.date = ? AND s.kind IN ('session', 'checkin')`,
    patient.id,
    date,
  );
  const signals: DaySignals = {
    date,
    turns: texts.length,
    words_per_turn: texts.length ? Number((words.length / texts.length).toFixed(2)) : 0,
    unique_ratio: Number(mattr(words).toFixed(3)),
    repeats: obs('repeat'),
    engaged_minutes: Number(engaged.toFixed(1)),
    sessions_offered: runs.length,
    sessions_accepted: runs.filter((r) => r.status === 'completed').length,
    distress_events: obs('distress') + obs('exit_seeking'),
  };
  db().run(
    `INSERT OR REPLACE INTO signals_daily (patient_id, date, turns, words_per_turn, unique_ratio, repeats, engaged_minutes,
       sessions_offered, sessions_accepted, distress_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    patient.id,
    date,
    signals.turns,
    signals.words_per_turn,
    signals.unique_ratio,
    signals.repeats,
    signals.engaged_minutes,
    signals.sessions_offered,
    signals.sessions_accepted,
    signals.distress_events,
  );
  return signals;
}

export function signalSeries(patientId: string, days = 14): DaySignals[] {
  return db()
    .all<DaySignals>('SELECT * FROM signals_daily WHERE patient_id = ? ORDER BY date DESC LIMIT ?', patientId, days)
    .reverse();
}

// ---------- Sundowning ----------

/** Distress and exit-seeking by hour of day over the last two weeks. */
export function distressByHour(patient: Patient, days = 14): number[] {
  const since = new Date(now().getTime() - days * 86400000).toISOString();
  const hist = new Array(24).fill(0);
  for (const o of db().all<{ at: string }>(
    "SELECT at FROM observations WHERE patient_id = ? AND kind IN ('distress', 'exit_seeking') AND at >= ?",
    patient.id,
    since,
  )) {
    hist[localParts(patient.timezone, new Date(o.at)).hour]++;
  }
  return hist;
}

export interface SundownForecast {
  hist: number[];
  peakHour: number | null;
  windowStart: string | null; // HH:MM when distress usually begins
}

export function sundownForecast(patient: Patient): SundownForecast {
  const hist = distressByHour(patient);
  // Only afternoons and evenings count as sundowning.
  let peakHour: number | null = null;
  for (let h = 12; h < 22; h++) if (hist[h] >= 3 && (peakHour === null || hist[h] > hist[peakHour])) peakHour = h;
  if (peakHour === null) return { hist, peakHour: null, windowStart: null };
  // The window starts at the first hour before the peak that still has half its count.
  let start = peakHour;
  while (start > 12 && hist[start - 1] >= hist[peakHour] / 2) start--;
  return { hist, peakHour, windowStart: `${String(start).padStart(2, '0')}:00` };
}

/** Best part of day for engagement, from session outcomes. */
export function bestTimes(patientId: string): { part: string; avg: number; n: number }[] {
  const rows = db().all<{ hour: number; score: number }>(
    'SELECT hour, score FROM activity_outcomes WHERE patient_id = ? ORDER BY at DESC LIMIT 200',
    patientId,
  );
  const parts: Record<string, number[]> = { morning: [], afternoon: [], evening: [] };
  for (const r of rows) parts[r.hour < 12 ? 'morning' : r.hour < 17 ? 'afternoon' : 'evening'].push(r.score);
  return Object.entries(parts)
    .filter(([, v]) => v.length)
    .map(([part, v]) => ({ part, avg: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)), n: v.length }))
    .sort((a, b) => b.avg - a.avg);
}

export const isBefore = (a: string, b: string) => minutesOf(a) < minutesOf(b);
export type { LocalParts };
