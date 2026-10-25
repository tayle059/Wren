// Nightly reflection: the daily summary for family, the "What works" note the
// companion reads tomorrow, visit prep, and schedule suggestions.
import { hasMeta } from '../config.ts';
import { db } from '../db.ts';
import { newId } from '../auth.ts';
import { chat, chatJson } from '../meta.ts';
import { getPatient, memoryItems, scheduleItems, type Patient } from '../domain.ts';
import { ACTIVITY_LABELS, stats, type Activity } from '../adapt/bandit.ts';
import { bestTimes, computeSignals, sundownForecast, type DaySignals } from '../adapt/signals.ts';
import { localDayRangeUtc, localParts, minutesOf, hhmmOf, nowIso } from '../util/time.ts';
import { SUMMARY_SYSTEM, VISIT_PREP_SYSTEM, WHAT_WORKS_SYSTEM } from '../brain/prompts.ts';
import { toFamily } from '../events.ts';

export interface DayFacts {
  date: string;
  signals: DaySignals;
  sessions: { label: string; activity: string | null; status: string; score: number | null }[];
  reminders: { label: string; status: string }[];
  alerts: { level: string; category: string; reason: string }[];
  observations: Record<string, number>;
  stories: string[];
  transcriptSample: string;
}

export function gatherDay(patient: Patient, date: string): DayFacts {
  const { start, end } = localDayRangeUtc(patient.timezone, date);
  const signals = computeSignals(patient, date);
  const runs = db().all<{ kind: string; label: string; status: string; conversation_id: string | null }>(
    `SELECT s.kind, s.label, r.status, r.conversation_id FROM schedule_runs r JOIN schedule_items s ON s.id = r.schedule_item_id
     WHERE s.patient_id = ? AND r.date = ? ORDER BY s.time_of_day`,
    patient.id,
    date,
  );
  const outcome = (cid: string | null) =>
    cid ? db().get<{ activity: string; score: number }>('SELECT activity, score FROM activity_outcomes WHERE conversation_id = ?', cid) : undefined;
  const sessions = runs
    .filter((r) => r.kind === 'session' || r.kind === 'checkin')
    .map((r) => {
      const o = outcome(r.conversation_id);
      return { label: r.label, activity: o?.activity ?? null, status: r.status, score: o?.score ?? null };
    });
  const reminders = runs.filter((r) => r.kind === 'reminder').map((r) => ({ label: r.label, status: r.status }));
  const alerts = db().all<{ level: string; category: string; reason: string }>(
    'SELECT level, category, reason FROM alerts WHERE patient_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at',
    patient.id,
    start,
    end,
  );
  const observations: Record<string, number> = {};
  for (const o of db().all<{ kind: string; n: number }>(
    'SELECT kind, COUNT(*) AS n FROM observations WHERE patient_id = ? AND at >= ? AND at < ? GROUP BY kind',
    patient.id,
    start,
    end,
  ))
    observations[o.kind] = o.n;
  const stories = db()
    .all<{ title: string }>('SELECT title FROM stories WHERE patient_id = ? AND created_at >= ? AND created_at < ?', patient.id, start, end)
    .map((s) => s.title);
  const lines = db()
    .all<{ role: string; text: string }>(
      `SELECT m.role, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.patient_id = ? AND m.created_at >= ? AND m.created_at < ? ORDER BY m.created_at LIMIT 120`,
      patient.id,
      start,
      end,
    )
    .map((m) => `${m.role === 'patient' ? patient.preferred_name : patient.companion_name}: ${m.text}`);
  return { date, signals, sessions, reminders, alerts, observations, stories, transcriptSample: lines.join('\n').slice(0, 12000) };
}

// ---------- Daily summary ----------

export type Mood = 'bright' | 'content' | 'mixed' | 'unsettled' | 'quiet';

export interface Summary {
  mood: Mood;
  summary: string;
  highlights: string[];
}

export function offlineSummary(patient: Patient, f: DayFacts): Summary {
  const name = patient.preferred_name;
  const joy = f.observations.joy ?? 0;
  const distress = (f.observations.distress ?? 0) + (f.observations.exit_seeking ?? 0);
  const mood: Mood =
    f.signals.turns === 0 ? 'quiet' : distress >= 3 ? 'unsettled' : joy >= 2 && distress === 0 ? 'bright' : distress > 0 && joy > 0 ? 'mixed' : 'content';
  const parts: string[] = [];
  if (f.signals.turns === 0) {
    parts.push(`${name} didn't talk with ${patient.companion_name} today.`);
  } else {
    const minutes = Math.max(1, Math.round(f.signals.engaged_minutes));
    parts.push(`${name} chatted with ${patient.companion_name} for about ${minutes} minute${minutes === 1 ? '' : 's'} today.`);
  }
  const done = f.sessions.filter((s) => s.status === 'completed');
  if (f.sessions.length) {
    const liked = done
      .filter((s) => (s.score ?? 0) >= 0.6 && s.activity)
      .map((s) => ACTIVITY_LABELS[s.activity as Activity].toLowerCase());
    parts.push(
      `${name} joined ${done.length} of ${f.sessions.length} activities${liked.length ? `, and especially enjoyed ${[...new Set(liked)].join(' and ')}` : ''}.`,
    );
  }
  const confirmed = f.reminders.filter((r) => r.status === 'confirmed').length;
  if (f.reminders.length) parts.push(`${confirmed} of ${f.reminders.length} reminders were confirmed.`);
  if (distress) parts.push(`There ${distress === 1 ? 'was one unsettled moment' : `were ${distress} unsettled moments`}, and ${patient.companion_name} helped calm things down.`);
  const highlights = [
    ...f.stories.map((s) => `Told a story: ${s}`),
    ...f.alerts.map((a) => `${a.level === 'urgent' ? 'Urgent' : 'Note'}: ${a.reason}`),
  ].slice(0, 5);
  return { mood, summary: parts.join(' '), highlights };
}

async function writeSummary(patient: Patient, f: DayFacts): Promise<Summary> {
  if (!hasMeta()) return offlineSummary(patient, f);
  try {
    return await chatJson<Summary>({
      system: SUMMARY_SYSTEM,
      user: `Write today's update about ${patient.preferred_name} (pronouns ${patient.pronouns}) for the family.\nFacts: ${JSON.stringify({ ...f, transcriptSample: undefined })}\n\nConversation excerpts:\n${f.transcriptSample}`,
      name: 'daily_summary',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mood', 'summary', 'highlights'],
        properties: {
          mood: { type: 'string', enum: ['bright', 'content', 'mixed', 'unsettled', 'quiet'] },
          summary: { type: 'string' },
          highlights: { type: 'array', items: { type: 'string' } },
        },
      },
    });
  } catch (e) {
    console.warn('[summary]', (e as Error).message);
    return offlineSummary(patient, f);
  }
}

// ---------- What works ----------

export function familyLines(note: string): string[] {
  return note.split('\n').filter((l) => /\[family\]\s*$/.test(l.trim()));
}

export function offlineWhatWorks(patient: Patient): string {
  const name = patient.preferred_name;
  const lines = [...familyLines(patient.what_works_text)];
  const s = stats(patient.id).filter((x) => x.plays >= 2);
  if (s[0]) lines.push(`- ${ACTIVITY_LABELS[s[0].activity]} engages ${name} most (about ${Math.round(s[0].mean * 100)}% engagement).`);
  if (s[1] && s[1].mean >= 0.5) lines.push(`- ${ACTIVITY_LABELS[s[1].activity]} also goes well.`);
  const low = s.at(-1);
  if (low && s.length > 2 && low.mean < 0.45)
    lines.push(`- ${ACTIVITY_LABELS[low.activity]} hasn't landed lately. Offer it less often, and keep it very easy.`);
  const best = bestTimes(patient.id)[0];
  if (best && best.n >= 3) lines.push(`- Most engaged in the ${best.part}.`);
  const forecast = sundownForecast(patient);
  const song = memoryItems(patient.id).find((m) => m.kind === 'song');
  if (forecast.windowStart) {
    lines.push(`- Often gets restless from around ${to12h(forecast.windowStart)}.${song ? ` "${song.title}" helps.` : ' Slow down and reassure.'}`);
  }
  const asked = db().get<{ detail: string; n: number }>(
    "SELECT detail, COUNT(*) AS n FROM observations WHERE patient_id = ? AND kind = 'deceased_ask' GROUP BY detail ORDER BY n DESC LIMIT 1",
    patient.id,
  );
  if (asked) lines.push(`- Sometimes asks for ${asked.detail}. Share happy memories of ${asked.detail.split(' ')[0]} rather than the loss.`);
  const repeats = db().get<{ n: number }>("SELECT COUNT(*) AS n FROM observations WHERE patient_id = ? AND kind = 'repeat'", patient.id)!.n;
  if (repeats >= 3) lines.push('- Repeats some questions. Answer warmly each time, as if it were the first.');
  return lines.length ? lines.join('\n') : `- Still getting to know ${name}. Notes will appear here after a few days.`;
}

async function writeWhatWorks(patient: Patient, f: DayFacts): Promise<string> {
  if (!hasMeta()) return offlineWhatWorks(patient);
  try {
    const { content } = await chat({
      messages: [
        { role: 'system', content: WHAT_WORKS_SYSTEM },
        {
          role: 'user',
          content: `Person: ${patient.preferred_name}. About (family): ${patient.about_text}\n\nCurrent note:\n${patient.what_works_text || '(empty)'}\n\nActivity engagement (Beta posterior means, higher is better): ${JSON.stringify(stats(patient.id))}\nBest times: ${JSON.stringify(bestTimes(patient.id))}\nSundowning: ${JSON.stringify(sundownForecast(patient))}\nToday: ${JSON.stringify({ ...f, transcriptSample: undefined })}\n\nExcerpts:\n${f.transcriptSample.slice(0, 6000)}\n\nReturn only the updated note.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 500,
      timeoutMs: 45000,
    });
    const note = (content ?? '').trim();
    if (!note) return offlineWhatWorks(patient);
    // Family lines are sacred: put back any the model dropped.
    const missing = familyLines(patient.what_works_text).filter((l) => !note.includes(l.trim()));
    return [...missing, note].join('\n');
  } catch (e) {
    console.warn('[what_works]', (e as Error).message);
    return offlineWhatWorks(patient);
  }
}

// ---------- Visit prep ----------

export interface VisitPrep {
  starters: string[];
  avoid: string;
}

export function offlineVisitPrep(patient: Patient): VisitPrep {
  const stories = db().all<{ title: string }>(
    'SELECT title FROM stories WHERE patient_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 2',
    patient.id,
  );
  const top = stats(patient.id)[0];
  const starters = stories.map((s) => `Ask about "${s.title}". It came up recently.`);
  const people = memoryItems(patient.id).filter((m) => m.kind === 'person' && !m.deceased && m.photo_path);
  if (people[0]) starters.push(`Bring up ${people[0].title}. Photos of ${people[0].title.split(' ')[0]} spark good conversation.`);
  if (top?.activity === 'music') starters.push('Put on a favorite song together. Music has been working well.');
  if (top?.activity === 'word_game') starters.push('Try finishing old sayings together. Word games have been a hit.');
  const avoidSentence = patient.about_text.match(/[^.!?\n]*\b(avoid|upset|don'?t (mention|bring up|ask))\b[^.!?\n]*[.!?]?/i)?.[0]?.trim() ?? '';
  return { starters: starters.slice(0, 3), avoid: avoidSentence };
}

async function writeVisitPrep(patient: Patient, f: DayFacts): Promise<VisitPrep> {
  if (!hasMeta()) return offlineVisitPrep(patient);
  try {
    const stories = db().all<{ title: string; text: string }>(
      'SELECT title, text FROM stories WHERE patient_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 5',
      patient.id,
    );
    return await chatJson<VisitPrep>({
      system: VISIT_PREP_SYSTEM,
      user: `Person: ${patient.preferred_name}. About: ${patient.about_text}\nWhat works: ${patient.what_works_text}\nRecent stories: ${JSON.stringify(stories)}\nToday: ${JSON.stringify({ ...f, transcriptSample: undefined })}\nGive 3 starters (one sentence each) and one thing to avoid ("" if nothing).`,
      name: 'visit_prep',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['starters', 'avoid'],
        properties: { starters: { type: 'array', items: { type: 'string' } }, avoid: { type: 'string' } },
      },
    });
  } catch (e) {
    console.warn('[visit_prep]', (e as Error).message);
    return offlineVisitPrep(patient);
  }
}

// ---------- Schedule suggestions ----------

function to12h(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function suggestSundownShift(patient: Patient): string | null {
  const forecast = sundownForecast(patient);
  if (!forecast.windowStart) return null;
  const calming = scheduleItems(patient.id).find((s) => s.kind === 'session' && s.calming);
  if (!calming) return null;
  const target = hhmmOf(minutesOf(forecast.windowStart) - 30);
  // Only suggest when the calming session currently starts after the restless window opens.
  if (minutesOf(calming.time_of_day) <= minutesOf(forecast.windowStart)) return null;
  const pending = db().get('SELECT 1 FROM suggestions WHERE patient_id = ? AND kind = ? AND status = ?', patient.id, 'move_session', 'pending');
  if (pending) return null;
  const text = `${patient.preferred_name} has been getting restless from around ${to12h(forecast.windowStart)}. Move the calming session from ${to12h(calming.time_of_day)} to ${to12h(target)} so it starts before the hard part of the day?`;
  db().run(
    'INSERT INTO suggestions (id, patient_id, kind, text, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(),
    patient.id,
    'move_session',
    text,
    JSON.stringify({ schedule_item_id: calming.id, from: calming.time_of_day, to: target }),
    'pending',
    nowIso(),
  );
  return text;
}

// ---------- Orchestration ----------

export async function runNightly(patientId: string, date?: string) {
  const patient = getPatient(patientId);
  if (!patient) return null;
  const day = date ?? localParts(patient.timezone).date;
  const facts = gatherDay(patient, day);
  const [summary, whatWorks, visitPrep] = await Promise.all([
    writeSummary(patient, facts),
    writeWhatWorks(patient, facts),
    writeVisitPrep(patient, facts),
  ]);
  db().run(
    'INSERT OR REPLACE INTO daily_summaries (patient_id, date, mood, summary, highlights_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    patient.id,
    day,
    summary.mood,
    summary.summary,
    JSON.stringify(summary.highlights),
    nowIso(),
  );
  db().run('UPDATE patients SET what_works_text = ?, visit_prep_json = ? WHERE id = ?', whatWorks, JSON.stringify(visitPrep), patient.id);
  const suggestion = suggestSundownShift(getPatient(patientId)!);
  toFamily(patient.id, { type: 'nightly', date: day });
  return { summary, whatWorks, visitPrep, suggestion };
}
