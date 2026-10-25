// API for the companion tablet. Authenticated by the device token from pairing.
import { Hono } from 'hono';
import { deviceForToken, redeemPairingCode, verifySecret, type Device } from '../auth.ts';
import { db } from '../db.ts';
import { getPatient, setScheduleRun, todaysSchedule, type ScheduleItem } from '../domain.ts';
import { endConversation, mediaEnded, openConversation, patientTurn, type EndReason } from '../brain/index.ts';
import type { SessionPlan } from '../brain/types.ts';
import { heartbeat } from '../jobs/scheduler.ts';
import { mediaUrl } from '../media.ts';
import { speechToText, sttMode } from '../stt.ts';
import { localParts, nowIso, partOfDay, spokenDate, spokenTime } from '../util/time.ts';
import { bearer, fileField, HttpError, sse, textField, type Body } from './common.ts';
import { hasMeta } from '../config.ts';

type Env = { Variables: { device: Device } };

export const deviceRoutes = new Hono<Env>();

deviceRoutes.post('/pair', async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  const paired = redeemPairingCode(String(code ?? ''));
  if (!paired) return c.json({ error: 'That code didn’t work. Ask your family for a new one.' }, 400);
  return c.json({ token: paired.token, patientId: paired.patientId });
});

deviceRoutes.use('*', async (c, next) => {
  if (c.req.path.endsWith('/pair')) return next();
  const device = deviceForToken(bearer(c));
  if (!device) return c.json({ error: 'Not paired' }, 401);
  c.set('device', device);
  heartbeat(device.id);
  await next();
});

deviceRoutes.get('/state', (c) => {
  const device = c.get('device');
  const p = getPatient(device.patient_id)!;
  const { hour } = localParts(p.timezone);
  const notes = db().all<{ id: string; from_name: string; audio_path: string }>(
    'SELECT id, from_name, audio_path FROM voice_notes WHERE patient_id = ? AND played_at IS NULL ORDER BY created_at',
    p.id,
  );
  return c.json({
    patient: {
      name: p.preferred_name,
      companionName: p.companion_name,
      timezone: p.timezone,
      speechPatienceMs: p.speech_patience_ms,
      hasExitPin: !!p.exit_pin_hash,
    },
    orientation: {
      greeting: `Good ${partOfDay(hour) === 'night' ? 'evening' : partOfDay(hour)}, ${p.preferred_name}.`,
      date: spokenDate(p.timezone),
      time: spokenTime(p.timezone),
      partOfDay: partOfDay(hour),
    },
    schedule: todaysSchedule(p).map((s) => ({ id: s.id, kind: s.kind, label: s.label, time: s.time_of_day, status: s.status })),
    voiceNotes: notes.map((n) => ({ id: n.id, from: n.from_name, url: mediaUrl(n.audio_path) })),
    stt: sttMode(),
    brain: hasMeta() ? 'muse' : 'offline',
  });
});

deviceRoutes.get('/events', (c) => sse(c, `device:${c.get('device').patient_id}`, { type: 'hello' }));

deviceRoutes.post('/heartbeat', (c) => c.json({ ok: true }));

deviceRoutes.post('/open', async (c) => {
  const device = c.get('device');
  const body = await c.req.json<{ kind: SessionPlan['kind']; scheduleItemId?: string; voiceNoteId?: string; calming?: boolean }>();
  const plan: SessionPlan = { kind: body.kind ?? 'chat' };
  if (body.scheduleItemId) {
    const item = db().get<ScheduleItem>('SELECT * FROM schedule_items WHERE id = ? AND patient_id = ?', body.scheduleItemId, device.patient_id);
    if (!item) return c.json({ error: 'Unknown schedule item' }, 404);
    plan.kind = item.kind === 'checkin' ? 'checkin' : item.kind === 'reminder' ? 'reminder' : 'session';
    plan.scheduleItem = item;
    plan.calming = !!item.calming;
  } else if (body.kind === 'session') {
    plan.calming = !!body.calming;
  }
  if (body.voiceNoteId) {
    const note = db().get<{ id: string; from_name: string; audio_path: string }>(
      'SELECT id, from_name, audio_path FROM voice_notes WHERE id = ? AND patient_id = ?',
      body.voiceNoteId,
      device.patient_id,
    );
    if (!note) return c.json({ error: 'Unknown voice note' }, 404);
    plan.kind = 'voice_note';
    plan.voiceNote = { id: note.id, from: note.from_name, url: mediaUrl(note.audio_path)! };
    db().run('UPDATE voice_notes SET played_at = ? WHERE id = ?', nowIso(), note.id);
  }
  return c.json(await openConversation(device.patient_id, plan));
});

deviceRoutes.post('/turn', async (c) => {
  const device = c.get('device');
  let conversationId = '';
  let text = '';
  if ((c.req.header('Content-Type') ?? '').includes('multipart/form-data')) {
    const body = (await c.req.parseBody()) as Body;
    conversationId = textField(body, 'conversationId');
    text = textField(body, 'text');
    const audio = await fileField(body, 'audio');
    if (!text && audio) {
      try {
        text = await speechToText(device.patient_id, audio.bytes);
      } catch (e) {
        console.warn('[stt]', (e as Error).message);
        return c.json({ error: 'stt_failed', message: (e as Error).message }, 502);
      }
    }
  } else {
    const body = await c.req.json<{ conversationId: string; text: string }>();
    conversationId = body.conversationId;
    text = body.text ?? '';
  }
  if (!conversationId) throw new HttpError(400, 'conversationId is required');
  if (!text.trim()) return c.json({ transcript: '', reply: null });
  const reply = await patientTurn(device.patient_id, conversationId, text);
  return c.json({ transcript: text, reply });
});

deviceRoutes.post('/media-ended', async (c) => {
  const { conversationId } = await c.req.json<{ conversationId: string }>();
  return c.json({ reply: await mediaEnded(c.get('device').patient_id, conversationId) });
});

deviceRoutes.post('/end', async (c) => {
  const { conversationId, reason } = await c.req.json<{ conversationId: string; reason: EndReason }>();
  await endConversation(c.get('device').patient_id, conversationId, reason ?? 'closed');
  return c.json({ ok: true });
});

// The big "I took it" / "Not yet" buttons on a reminder card.
deviceRoutes.post('/reminder', async (c) => {
  const device = c.get('device');
  const { scheduleItemId, status, conversationId } = await c.req.json<{ scheduleItemId: string; status: 'confirmed' | 'not_yet'; conversationId?: string }>();
  const p = getPatient(device.patient_id)!;
  const item = db().get('SELECT 1 FROM schedule_items WHERE id = ? AND patient_id = ?', scheduleItemId, p.id);
  if (!item) return c.json({ error: 'Unknown schedule item' }, 404);
  if (conversationId) {
    // Route through the companion so it answers out loud and records the outcome.
    const said = status === 'confirmed' ? 'Yes, I took it.' : 'Not yet.';
    return c.json({ reply: await patientTurn(p.id, conversationId, said) });
  }
  setScheduleRun(scheduleItemId, localParts(p.timezone).date, status);
  return c.json({ reply: null });
});

deviceRoutes.post('/exit', async (c) => {
  const device = c.get('device');
  const { pin } = await c.req.json<{ pin: string }>();
  const p = db().get<{ exit_pin_hash: string | null }>('SELECT exit_pin_hash FROM patients WHERE id = ?', device.patient_id);
  if (p?.exit_pin_hash && !verifySecret(String(pin ?? ''), p.exit_pin_hash)) return c.json({ ok: false }, 403);
  db().run('DELETE FROM devices WHERE id = ?', device.id);
  return c.json({ ok: true });
});
