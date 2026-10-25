// The heartbeat of the day: invites the companion to speak first at scheduled
// times, retries once when there's no answer, notices missed check-ins and
// offline tablets, and runs the nightly reflection.
import { db } from '../db.ts';
import { listenerCount } from '../events.ts';
import { getPatient, notifyDevice, raiseAlert, scheduleRun, setScheduleRun, todaysSchedule, type Patient, type ScheduleItem } from '../domain.ts';
import { localParts, minutesOf, now, nowIso } from '../util/time.ts';
import { runNightly } from './nightly.ts';

const WINDOW_MIN = 90; // how long after its time an item may still start
const RETRY_AFTER_MIN = 20;
const REMINDER_RETRY_MIN = 30;
const MAX_ATTEMPTS = 2;
const OFFLINE_AFTER_MS = 10 * 60 * 1000;
const NIGHTLY_AT = '21:00';

export interface Invite {
  kind: 'checkin' | 'reminder' | 'session';
  scheduleItemId: string;
  calming: boolean;
}

export function inviteDevice(patientId: string, item: ScheduleItem) {
  const invite: Invite = { kind: item.kind, scheduleItemId: item.id, calming: !!item.calming };
  notifyDevice(patientId, 'invite', { invite });
}

function minutesSince(iso: string | null) {
  return iso ? (now().getTime() - Date.parse(iso)) / 60000 : Infinity;
}

export async function tickPatient(patient: Patient) {
  const { date, hhmm } = localParts(patient.timezone);
  const nowMin = minutesOf(hhmm);
  const online = listenerCount(`device:${patient.id}`) > 0;

  for (const item of todaysSchedule(patient)) {
    const due = minutesOf(item.time_of_day);
    if (nowMin < due) continue;
    const run = scheduleRun(item.id, date);
    const late = nowMin - due > WINDOW_MIN;

    if (!run) {
      if (late) {
        setScheduleRun(item.id, date, item.kind === 'reminder' ? 'missed' : 'skipped');
        continue;
      }
      if (!online) continue; // wait for the tablet; heartbeat alerts cover long outages
      setScheduleRun(item.id, date, 'invited', { attempt: true });
      inviteDevice(patient.id, item);
      continue;
    }

    const retryable =
      ((run.status === 'no_response' || run.status === 'invited') && minutesSince(run.last_attempt_at) >= RETRY_AFTER_MIN) ||
      (item.kind === 'reminder' && run.status === 'not_yet' && minutesSince(run.last_attempt_at) >= REMINDER_RETRY_MIN);
    if (retryable && run.attempts < MAX_ATTEMPTS && !late && online) {
      setScheduleRun(item.id, date, 'invited', { attempt: true });
      inviteDevice(patient.id, item);
      continue;
    }

    const unanswered = run.status === 'no_response' || run.status === 'invited';
    if (unanswered && (run.attempts >= MAX_ATTEMPTS || late) && minutesSince(run.last_attempt_at) >= RETRY_AFTER_MIN) {
      setScheduleRun(item.id, date, item.kind === 'reminder' ? 'missed' : 'skipped');
      if (item.kind === 'checkin') {
        await raiseAlert({
          patientId: patient.id,
          level: 'fyi',
          category: 'missed_checkin',
          reason: `${patient.preferred_name} didn't answer the ${item.label.toLowerCase()}. It might be worth a call.`,
        });
      }
    }
    if (item.kind === 'reminder' && run.status === 'not_yet' && late) {
      setScheduleRun(item.id, date, 'missed');
      await raiseAlert({
        patientId: patient.id,
        level: 'fyi',
        category: 'medication',
        reason: `${patient.preferred_name} hasn't confirmed "${item.label}" today.`,
      });
    }
  }

  // Nightly reflection, once per local day.
  const key = `nightly:${patient.id}:${date}`;
  if (nowMin >= minutesOf(NIGHTLY_AT) && !db().get('SELECT 1 FROM kv WHERE key = ?', key)) {
    db().run('INSERT INTO kv (key, value) VALUES (?, ?)', key, nowIso());
    await runNightly(patient.id, date).catch((e) => console.warn('[nightly]', e.message));
  }
}

export function checkHeartbeats() {
  const cutoff = new Date(now().getTime() - OFFLINE_AFTER_MS).toISOString();
  for (const d of db().all<{ id: string; patient_id: string }>(
    'SELECT id, patient_id FROM devices WHERE offline_alerted = 0 AND last_seen_at < ?',
    cutoff,
  )) {
    db().run('UPDATE devices SET offline_alerted = 1 WHERE id = ?', d.id);
    const patient = getPatient(d.patient_id);
    void raiseAlert({
      patientId: d.patient_id,
      level: 'fyi',
      category: 'device_offline',
      reason: `${patient ? `${patient.preferred_name}'s` : 'The'} companion tablet has been offline for 10 minutes. It may be unplugged or off Wi-Fi.`,
    });
  }
}

export function heartbeat(deviceId: string) {
  db().run('UPDATE devices SET last_seen_at = ?, offline_alerted = 0 WHERE id = ?', nowIso(), deviceId);
}

export async function tickAll() {
  for (const p of db().all<Patient>('SELECT p.* FROM patients p WHERE EXISTS (SELECT 1 FROM devices d WHERE d.patient_id = p.id)')) {
    await tickPatient(p).catch((e) => console.warn('[scheduler]', e.message));
  }
  checkHeartbeats();
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler(intervalMs: number) {
  if (timer) return;
  timer = setInterval(() => void tickAll(), intervalMs);
  timer.unref();
}
