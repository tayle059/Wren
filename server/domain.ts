// Shared data access for the patient's world. Keeps SQL out of the brain and routes.
import { db } from './db.ts';
import { newId } from './auth.ts';
import { toDevice, toFamily } from './events.ts';
import { pushToFamily } from './push.ts';
import { nowIso, localParts, localDayRangeUtc } from './util/time.ts';

export interface Patient {
  id: string;
  name: string;
  preferred_name: string;
  pronouns: string;
  companion_name: string;
  timezone: string;
  birth_year: number | null;
  about_text: string;
  what_works_text: string;
  visit_prep_json: string;
  speech_patience_ms: number;
  exit_pin_hash: string | null;
}

export interface MemoryItem {
  id: string;
  patient_id: string;
  kind: 'person' | 'place' | 'story' | 'song' | 'photo';
  title: string;
  body: string;
  relationship: string;
  deceased: number;
  photo_path: string | null;
  audio_path: string | null;
  ai_description: string;
  prompts_json: string;
  source: 'family' | 'patient';
  created_at: string;
}

export interface ScheduleItem {
  id: string;
  patient_id: string;
  kind: 'checkin' | 'reminder' | 'session';
  label: string;
  time_of_day: string;
  days: string;
  photo_path: string | null;
  calming: number;
  enabled: number;
}

export interface Alert {
  id: string;
  patient_id: string;
  conversation_id: string | null;
  level: 'urgent' | 'fyi';
  category: string;
  reason: string;
  evidence: string;
  created_at: string;
  ack_by: string | null;
  ack_at: string | null;
}

export const getPatient = (id: string) => db().get<Patient>('SELECT * FROM patients WHERE id = ?', id);

export const memoryItems = (patientId: string) =>
  db().all<MemoryItem>('SELECT * FROM memory_items WHERE patient_id = ? ORDER BY kind, title', patientId);

export const memoryItem = (patientId: string, id: string) =>
  db().get<MemoryItem>('SELECT * FROM memory_items WHERE patient_id = ? AND id = ?', patientId, id);

export const scheduleItems = (patientId: string) =>
  db().all<ScheduleItem>(
    'SELECT * FROM schedule_items WHERE patient_id = ? AND enabled = 1 ORDER BY time_of_day',
    patientId,
  );

export function scheduleRun(itemId: string, date: string) {
  return db().get<{ id: string; status: string; attempts: number; last_attempt_at: string | null; conversation_id: string | null }>(
    'SELECT * FROM schedule_runs WHERE schedule_item_id = ? AND date = ?',
    itemId,
    date,
  );
}

export function setScheduleRun(itemId: string, date: string, status: string, extra: { attempt?: boolean; conversationId?: string } = {}) {
  const existing = scheduleRun(itemId, date);
  if (!existing) {
    db().run(
      'INSERT INTO schedule_runs (id, schedule_item_id, date, status, attempts, last_attempt_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(),
      itemId,
      date,
      status,
      extra.attempt ? 1 : 0,
      extra.attempt ? nowIso() : null,
      extra.conversationId ?? null,
    );
    return;
  }
  db().run(
    `UPDATE schedule_runs SET status = ?, attempts = attempts + ?, last_attempt_at = COALESCE(?, last_attempt_at),
       conversation_id = COALESCE(?, conversation_id) WHERE id = ?`,
    status,
    extra.attempt ? 1 : 0,
    extra.attempt ? nowIso() : null,
    extra.conversationId ?? null,
    existing.id,
  );
}

/** Today's schedule with statuses, in the patient's timezone. */
export function todaysSchedule(patient: Patient) {
  const { date, weekday } = localParts(patient.timezone);
  return scheduleItems(patient.id)
    .filter((s) => s.days === '*' || s.days.split(',').includes(weekday))
    .map((s) => ({ ...s, status: scheduleRun(s.id, date)?.status ?? 'upcoming' }));
}

// ---------- Alerts ----------

const ALERT_DEDUPE_MS = 10 * 60 * 1000;

/**
 * Raises an alert for the family: stored, streamed to open family apps, and pushed
 * to phones. The same category is not repeated within 10 minutes so one fall
 * doesn't produce five notifications.
 */
export async function raiseAlert(input: {
  patientId: string;
  conversationId?: string | null;
  level: 'urgent' | 'fyi';
  category: string;
  reason: string;
  evidence?: string;
}): Promise<Alert | null> {
  const since = new Date(Date.parse(nowIso()) - ALERT_DEDUPE_MS).toISOString();
  const dupe = db().get<Alert>(
    'SELECT * FROM alerts WHERE patient_id = ? AND category = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
    input.patientId,
    input.category,
    since,
  );
  if (dupe) {
    // Escalate an earlier FYI to urgent if needed, but don't notify twice.
    if (dupe.level === 'fyi' && input.level === 'urgent') {
      db().run("UPDATE alerts SET level = 'urgent', reason = ? WHERE id = ?", input.reason, dupe.id);
    } else {
      return null;
    }
  }
  const alert: Alert = {
    id: dupe?.id ?? newId(),
    patient_id: input.patientId,
    conversation_id: input.conversationId ?? null,
    level: input.level,
    category: input.category,
    reason: input.reason,
    evidence: input.evidence ?? '',
    created_at: dupe?.created_at ?? nowIso(),
    ack_by: null,
    ack_at: null,
  };
  if (!dupe) {
    db().run(
      'INSERT INTO alerts (id, patient_id, conversation_id, level, category, reason, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      alert.id,
      alert.patient_id,
      alert.conversation_id,
      alert.level,
      alert.category,
      alert.reason,
      alert.evidence,
      alert.created_at,
    );
  }
  toFamily(input.patientId, { type: 'alert', alert });
  const patient = getPatient(input.patientId);
  void pushToFamily(input.patientId, {
    title: input.level === 'urgent' ? `Urgent: ${patient?.preferred_name ?? 'Your loved one'} may need you` : `${patient?.preferred_name ?? 'Update'}`,
    body: input.reason,
    level: input.level,
    tag: alert.id,
  });
  return alert;
}

export function observe(patientId: string, kind: string, detail = '', conversationId: string | null = null) {
  db().run(
    'INSERT INTO observations (id, patient_id, conversation_id, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(),
    patientId,
    conversationId,
    kind,
    detail,
    nowIso(),
  );
}

// ---------- Conversations ----------

export function startConversation(patientId: string, opts: { scheduleItemId?: string | null; activity?: string | null } = {}) {
  const id = newId();
  db().run(
    'INSERT INTO conversations (id, patient_id, schedule_item_id, activity, started_at) VALUES (?, ?, ?, ?, ?)',
    id,
    patientId,
    opts.scheduleItemId ?? null,
    opts.activity ?? null,
    nowIso(),
  );
  return id;
}

export function addMessage(conversationId: string, role: 'patient' | 'companion', text: string, meta: object = {}) {
  db().run(
    'INSERT INTO messages (id, conversation_id, role, text, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?)',
    newId(),
    conversationId,
    role,
    text,
    nowIso(),
    JSON.stringify(meta),
  );
}

export function conversationMessages(conversationId: string) {
  return db().all<{ role: 'patient' | 'companion'; text: string; created_at: string; meta_json: string }>(
    'SELECT role, text, created_at, meta_json FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    conversationId,
  );
}

/** Everything Rose said today, used to notice repeated questions. */
export function patientUtterancesToday(patient: Patient) {
  const { start, end } = localDayRangeUtc(patient.timezone, localParts(patient.timezone).date);
  return db().all<{ text: string; created_at: string }>(
    `SELECT m.text, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.patient_id = ? AND m.role = 'patient' AND m.created_at >= ? AND m.created_at < ?
     ORDER BY m.created_at`,
    patient.id,
    start,
    end,
  );
}

export function notifyDevice(patientId: string, type: string, data: object = {}) {
  toDevice(patientId, { type, ...data });
}
