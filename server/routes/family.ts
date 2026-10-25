// API for family members. Every patient-scoped route checks membership first.
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { canAccessPatient, createPairingCode, hashSecret, newId, sha256Hex, userForToken, type User } from '../auth.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { getPatient, memoryItems, todaysSchedule, type Alert, type MemoryItem, type Patient } from '../domain.ts';
import { ACTIVITY_LABELS, ensureStats, stats } from '../adapt/bandit.ts';
import { bestTimes, signalSeries, sundownForecast } from '../adapt/signals.ts';
import { inviteDevice, tickPatient } from '../jobs/scheduler.ts';
import { runNightly } from '../jobs/nightly.ts';
import { describePhoto } from '../jobs/photos.ts';
import { listenerCount, toDevice } from '../events.ts';
import { mediaUrl, saveMedia } from '../media.ts';
import { saveSubscription, vapidPublicKey } from '../push.ts';
import { localParts, localDayRangeUtc, now, nowIso } from '../util/time.ts';
import { fileField, HttpError, requestMeta, sessionToken, sse, textField, type Body } from './common.ts';
import { audit, describeAgent } from '../security/audit.ts';

type Env = { Variables: { user: User; patient: Patient } };

export const familyRoutes = new Hono<Env>();

// Every family route needs a signed-in session (sign-in itself lives in account.ts).
familyRoutes.use('*', async (c, next) => {
  const user = userForToken(sessionToken(c));
  if (!user) return c.json({ error: 'Please sign in.' }, 401);
  c.set('user', user);
  await next();
});

familyRoutes.get('/me', (c) => {
  const { id, email, name } = c.get('user');
  const patients = db().all<{ id: string; preferred_name: string; relationship: string; role: string }>(
    'SELECT p.id, p.preferred_name, m.relationship, m.role FROM patients p JOIN memberships m ON m.patient_id = p.id WHERE m.user_id = ?',
    id,
  );
  return c.json({ user: { id, email, name }, patients });
});

familyRoutes.get('/push/key', (c) => c.json({ key: vapidPublicKey() }));
familyRoutes.post('/push/subscribe', async (c) => {
  const sub = await c.req.json<{ endpoint: string }>();
  if (!sub?.endpoint) return c.json({ error: 'Bad subscription' }, 400);
  saveSubscription(c.get('user').id, sub);
  return c.json({ ok: true });
});

const DEFAULT_SCHEDULE = [
  { kind: 'checkin', label: 'Morning check-in', time: '08:30', calming: 0 },
  { kind: 'reminder', label: 'Morning pills', time: '09:00', calming: 0 },
  { kind: 'session', label: 'Morning activity', time: '10:00', calming: 0 },
  { kind: 'reminder', label: 'Lunch', time: '12:30', calming: 0 },
  { kind: 'session', label: 'Afternoon activity', time: '14:00', calming: 0 },
  { kind: 'session', label: 'Calming time', time: '16:30', calming: 1 },
  { kind: 'reminder', label: 'Evening pills', time: '20:00', calming: 0 },
];

export function createPatient(
  userId: string,
  input: { name: string; preferred_name?: string; pronouns?: string; timezone?: string; birth_year?: number | null; about?: string; relationship?: string },
): string {
  const id = newId();
  db().run(
    `INSERT INTO patients (id, name, preferred_name, pronouns, timezone, birth_year, about_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    (input.preferred_name || input.name.split(/\s+/)[0]).trim(),
    input.pronouns || 'they/them',
    input.timezone || 'America/New_York',
    input.birth_year ?? null,
    input.about ?? '',
    nowIso(),
  );
  db().run("INSERT INTO memberships (user_id, patient_id, relationship, role) VALUES (?, ?, ?, 'owner')", userId, id, input.relationship ?? '');
  for (const s of DEFAULT_SCHEDULE) {
    db().run(
      'INSERT INTO schedule_items (id, patient_id, kind, label, time_of_day, calming) VALUES (?, ?, ?, ?, ?, ?)',
      newId(),
      id,
      s.kind,
      s.label,
      s.time,
      s.calming,
    );
  }
  ensureStats(id, input.about ?? '');
  return id;
}

familyRoutes.post('/patients', async (c) => {
  const body = await c.req.json<Parameters<typeof createPatient>[1]>();
  if (!body.name?.trim()) return c.json({ error: 'Please enter a name.' }, 400);
  const id = createPatient(c.get('user').id, body);
  return c.json({ id });
});

// ---------- Patient-scoped ----------

const p = new Hono<Env>();

p.use('*', async (c, next) => {
  const pid = c.req.param('pid')!;
  if (!canAccessPatient(c.get('user').id, pid)) return c.json({ error: 'Not found' }, 404);
  c.set('patient', getPatient(pid)!);
  await next();
});

p.get('/events', (c) => sse(c, `family:${c.get('patient').id}`, { type: 'hello' }));

function profile(pt: Patient) {
  return {
    id: pt.id,
    name: pt.name,
    preferredName: pt.preferred_name,
    pronouns: pt.pronouns,
    companionName: pt.companion_name,
    timezone: pt.timezone,
    birthYear: pt.birth_year,
    about: pt.about_text,
    whatWorks: pt.what_works_text,
    speechPatienceMs: pt.speech_patience_ms,
    hasExitPin: !!pt.exit_pin_hash,
  };
}

p.get('/', (c) => c.json(profile(c.get('patient'))));

p.patch('/', async (c) => {
  const pt = c.get('patient');
  const b = await c.req.json<Record<string, unknown>>();
  const fields: [string, unknown][] = [
    ['preferred_name', b.preferredName],
    ['pronouns', b.pronouns],
    ['companion_name', b.companionName],
    ['timezone', b.timezone],
    ['about_text', b.about],
    ['what_works_text', b.whatWorks],
    ['speech_patience_ms', b.speechPatienceMs],
  ];
  for (const [col, val] of fields) {
    if (val === undefined || val === null) continue;
    if (col === 'timezone') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: String(val) });
      } catch {
        return c.json({ error: 'Unknown timezone' }, 400);
      }
    }
    if (col === 'speech_patience_ms') {
      const ms = Number(val);
      if (!(ms >= 800 && ms <= 5000)) return c.json({ error: 'Speech patience must be 0.8 to 5 seconds' }, 400);
      db().run(`UPDATE patients SET ${col} = ? WHERE id = ?`, ms, pt.id);
      continue;
    }
    db().run(`UPDATE patients SET ${col} = ? WHERE id = ?`, String(val).slice(0, 8000), pt.id);
  }
  if (typeof b.exitPin === 'string') {
    if (!/^\d{4,8}$/.test(b.exitPin)) return c.json({ error: 'PIN must be 4 to 8 digits' }, 400);
    db().run('UPDATE patients SET exit_pin_hash = ? WHERE id = ?', hashSecret(b.exitPin), pt.id);
  }
  return c.json(profile(getPatient(pt.id)!));
});

p.post('/pairing', (c) => {
  const pairing = createPairingCode(c.get('patient').id, c.get('user').id);
  // The QR code opens the tablet's browser straight into pairing.
  return c.json({ ...pairing, url: `${config.publicUrl}/#/companion?pair=${pairing.code}` });
});

// ---------- Tablets ----------

p.get('/devices', (c) =>
  c.json(
    db()
      .all<{ id: string; name: string; created_at: string; last_seen_at: string | null }>(
        'SELECT id, name, created_at, last_seen_at FROM devices WHERE patient_id = ? ORDER BY created_at',
        c.get('patient').id,
      )
      .map((d) => ({ ...d, online: listenerCount(`device:${c.get('patient').id}`) > 0 && !!d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < 120_000 })),
  ),
);

p.patch('/devices/:did', async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: 'Please give the tablet a name.' }, 400);
  db().run('UPDATE devices SET name = ? WHERE id = ? AND patient_id = ?', name.trim().slice(0, 60), c.req.param('did'), c.get('patient').id);
  return c.json({ ok: true });
});

/** Disconnecting signs the tablet out at once: its token stops working. */
p.delete('/devices/:did', (c) => {
  const pt = c.get('patient');
  const d = db().get<{ name: string }>('SELECT name FROM devices WHERE id = ? AND patient_id = ?', c.req.param('did'), pt.id);
  if (!d) return c.json({ error: 'Not found' }, 404);
  db().run('DELETE FROM devices WHERE id = ?', c.req.param('did'));
  toDevice(pt.id, { type: 'unpaired', deviceId: c.req.param('did') });
  audit(c.get('user').id, 'tablet_removed', `${d.name} for ${pt.preferred_name}`, requestMeta(c));
  return c.json({ ok: true });
});

// ---------- Family members & invitations ----------

p.get('/members', (c) =>
  c.json(
    db().all<{ id: string; name: string; email: string; relationship: string; role: string }>(
      `SELECT u.id, u.name, u.email, m.relationship, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.patient_id = ? ORDER BY m.role = 'owner' DESC, u.name`,
      c.get('patient').id,
    ),
  ),
);

const INVITE_DAYS = 7;

p.post('/invites', async (c) => {
  const pt = c.get('patient');
  const { relationship } = await c.req.json<{ relationship?: string }>().catch(() => ({ relationship: '' }));
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now().getTime() + INVITE_DAYS * 86400_000).toISOString();
  db().run(
    'INSERT INTO invites (token_hash, patient_id, created_by, relationship, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    sha256Hex(token),
    pt.id,
    c.get('user').id,
    (relationship ?? '').slice(0, 60),
    nowIso(),
    expiresAt,
  );
  audit(c.get('user').id, 'invite_created', `to help care for ${pt.preferred_name}`, requestMeta(c));
  return c.json({ token, url: `${config.publicUrl}/#/join?invite=${token}`, expiresAt });
});

p.delete('/members/:uid', (c) => {
  const pt = c.get('patient');
  const me = c.get('user');
  const role = db().get<{ role: string }>('SELECT role FROM memberships WHERE user_id = ? AND patient_id = ?', me.id, pt.id)?.role;
  const target = c.req.param('uid')!;
  if (target !== me.id && role !== 'owner') return c.json({ error: 'Only the person who set up Kindred can remove family members.' }, 403);
  const owners = db().get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE patient_id = ? AND role = 'owner'", pt.id)!.n;
  const targetRole = db().get<{ role: string }>('SELECT role FROM memberships WHERE user_id = ? AND patient_id = ?', target, pt.id)?.role;
  if (!targetRole) return c.json({ error: 'Not found' }, 404);
  if (targetRole === 'owner' && owners <= 1) return c.json({ error: 'Someone needs to stay in charge. Make another family member the owner first.' }, 409);
  db().run('DELETE FROM memberships WHERE user_id = ? AND patient_id = ?', target, pt.id);
  audit(me.id, 'member_removed', target === me.id ? `left ${pt.preferred_name}'s circle` : `removed a family member from ${pt.preferred_name}'s circle`, requestMeta(c));
  return c.json({ ok: true });
});

function deviceStatus(pt: Patient) {
  const d = db().get<{ last_seen_at: string | null }>(
    'SELECT last_seen_at FROM devices WHERE patient_id = ? ORDER BY last_seen_at DESC LIMIT 1',
    pt.id,
  );
  return {
    paired: !!d,
    online: listenerCount(`device:${pt.id}`) > 0,
    lastSeenAt: d?.last_seen_at ?? null,
  };
}

const alertJson = (a: Alert) => ({
  id: a.id,
  level: a.level,
  category: a.category,
  reason: a.reason,
  evidence: a.evidence,
  createdAt: a.created_at,
  acknowledged: !!a.ack_at,
  conversationId: a.conversation_id,
});

p.get('/home', (c) => {
  const pt = c.get('patient');
  const { date } = localParts(pt.timezone);
  const { start } = localDayRangeUtc(pt.timezone, date);
  const openAlerts = db().all<Alert>(
    'SELECT * FROM alerts WHERE patient_id = ? AND ack_at IS NULL ORDER BY level = \'urgent\' DESC, created_at DESC LIMIT 20',
    pt.id,
  );
  const latest = db().get<{ date: string; mood: string; summary: string; highlights_json: string }>(
    'SELECT date, mood, summary, highlights_json FROM daily_summaries WHERE patient_id = ? ORDER BY date DESC LIMIT 1',
    pt.id,
  );
  const todayConvs = db().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM conversations c WHERE c.patient_id = ? AND c.started_at >= ?
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'patient')`,
    pt.id,
    start,
  )!.n;
  const suggestions = db().all<{ id: string; kind: string; text: string }>(
    "SELECT id, kind, text FROM suggestions WHERE patient_id = ? AND status = 'pending' ORDER BY created_at DESC",
    pt.id,
  );
  const newStories = db().all<{ id: string; title: string; quote: string }>(
    'SELECT id, title, quote FROM stories WHERE patient_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 2',
    pt.id,
  );
  return c.json({
    patient: profile(pt),
    device: deviceStatus(pt),
    alerts: openAlerts.map(alertJson),
    today: {
      date,
      conversations: todayConvs,
      schedule: todaysSchedule(pt).map((s) => ({ id: s.id, kind: s.kind, label: s.label, time: s.time_of_day, status: s.status, calming: !!s.calming })),
    },
    summary: latest ? { date: latest.date, mood: latest.mood, text: latest.summary, highlights: JSON.parse(latest.highlights_json) } : null,
    visitPrep: JSON.parse(pt.visit_prep_json || '[]'),
    suggestions,
    stories: newStories,
  });
});

p.get('/alerts', (c) => {
  const rows = db().all<Alert>('SELECT * FROM alerts WHERE patient_id = ? ORDER BY created_at DESC LIMIT 100', c.get('patient').id);
  return c.json(rows.map(alertJson));
});

p.post('/alerts/:aid/ack', (c) => {
  db().run(
    'UPDATE alerts SET ack_at = ?, ack_by = ? WHERE id = ? AND patient_id = ?',
    nowIso(),
    c.get('user').name,
    c.req.param('aid'),
    c.get('patient').id,
  );
  return c.json({ ok: true });
});

p.get('/conversations/:cid', (c) => {
  const conv = db().get<{ id: string; started_at: string; activity: string | null }>(
    'SELECT id, started_at, activity FROM conversations WHERE id = ? AND patient_id = ?',
    c.req.param('cid'),
    c.get('patient').id,
  );
  if (!conv) return c.json({ error: 'Not found' }, 404);
  const messages = db().all<{ role: string; text: string; created_at: string }>(
    'SELECT role, text, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    conv.id,
  );
  return c.json({ ...conv, messages });
});

// ---------- Memory book ----------

const memoryJson = (m: MemoryItem) => ({
  id: m.id,
  kind: m.kind,
  title: m.title,
  body: m.body,
  relationship: m.relationship,
  deceased: !!m.deceased,
  photoUrl: mediaUrl(m.photo_path),
  audioUrl: mediaUrl(m.audio_path),
  aiDescription: m.ai_description,
  prompts: JSON.parse(m.prompts_json || '[]'),
  source: m.source,
});

p.get('/memory', (c) => c.json(memoryItems(c.get('patient').id).map(memoryJson)));

const KINDS = ['person', 'place', 'story', 'song', 'photo'];

p.post('/memory', async (c) => {
  const pt = c.get('patient');
  const body = (await c.req.parseBody()) as Body;
  const kind = textField(body, 'kind');
  const title = textField(body, 'title').trim();
  if (!KINDS.includes(kind) || !title) return c.json({ error: 'Please give it a type and a title.' }, 400);
  const photo = await fileField(body, 'photo');
  const audio = await fileField(body, 'audio');
  if (photo && !photo.type.startsWith('image/')) throw new HttpError(400, 'Photos must be images.');
  if (audio && !audio.type.startsWith('audio/')) throw new HttpError(400, 'Songs must be audio files.');
  const id = newId();
  db().run(
    `INSERT INTO memory_items (id, patient_id, kind, title, body, relationship, deceased, photo_path, audio_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    pt.id,
    kind,
    title.slice(0, 200),
    textField(body, 'body').slice(0, 4000),
    textField(body, 'relationship').slice(0, 100),
    textField(body, 'deceased') === 'true' ? 1 : 0,
    photo ? saveMedia(pt.id, photo.bytes, photo.type, photo.name) : null,
    audio ? saveMedia(pt.id, audio.bytes, audio.type, audio.name) : null,
    nowIso(),
  );
  void describePhoto(pt.id, id);
  return c.json(memoryJson(db().get<MemoryItem>('SELECT * FROM memory_items WHERE id = ?', id)!));
});

p.patch('/memory/:mid', async (c) => {
  const pt = c.get('patient');
  const b = await c.req.json<{ title?: string; body?: string; relationship?: string; deceased?: boolean; prompts?: string[] }>();
  const m = db().get<MemoryItem>('SELECT * FROM memory_items WHERE id = ? AND patient_id = ?', c.req.param('mid'), pt.id);
  if (!m) return c.json({ error: 'Not found' }, 404);
  db().run(
    'UPDATE memory_items SET title = ?, body = ?, relationship = ?, deceased = ?, prompts_json = ? WHERE id = ?',
    (b.title ?? m.title).slice(0, 200),
    (b.body ?? m.body).slice(0, 4000),
    (b.relationship ?? m.relationship).slice(0, 100),
    b.deceased === undefined ? m.deceased : b.deceased ? 1 : 0,
    b.prompts ? JSON.stringify(b.prompts.slice(0, 6)) : m.prompts_json,
    m.id,
  );
  return c.json(memoryJson(db().get<MemoryItem>('SELECT * FROM memory_items WHERE id = ?', m.id)!));
});

p.delete('/memory/:mid', (c) => {
  db().run('DELETE FROM memory_items WHERE id = ? AND patient_id = ?', c.req.param('mid'), c.get('patient').id);
  return c.json({ ok: true });
});

// ---------- Stories ("Rose's Book") ----------

p.get('/stories', (c) =>
  c.json(
    db().all('SELECT id, title, era, text, quote, created_at AS createdAt, hidden FROM stories WHERE patient_id = ? ORDER BY created_at DESC', c.get('patient').id),
  ),
);

p.patch('/stories/:sid', async (c) => {
  const b = await c.req.json<{ hidden?: boolean; title?: string; text?: string }>();
  const pt = c.get('patient');
  const s = db().get<{ title: string; text: string; hidden: number }>('SELECT title, text, hidden FROM stories WHERE id = ? AND patient_id = ?', c.req.param('sid'), pt.id);
  if (!s) return c.json({ error: 'Not found' }, 404);
  db().run(
    'UPDATE stories SET hidden = ?, title = ?, text = ? WHERE id = ?',
    b.hidden === undefined ? s.hidden : b.hidden ? 1 : 0,
    (b.title ?? s.title).slice(0, 120),
    (b.text ?? s.text).slice(0, 2000),
    c.req.param('sid'),
  );
  return c.json({ ok: true });
});

// ---------- Summaries & insights ----------

p.get('/summaries', (c) =>
  c.json(
    db()
      .all<{ date: string; mood: string; summary: string; highlights_json: string }>(
        'SELECT date, mood, summary, highlights_json FROM daily_summaries WHERE patient_id = ? ORDER BY date DESC LIMIT 60',
        c.get('patient').id,
      )
      .map((s) => ({ date: s.date, mood: s.mood, text: s.summary, highlights: JSON.parse(s.highlights_json) })),
  ),
);

p.get('/insights', (c) => {
  const pt = c.get('patient');
  return c.json({
    activities: stats(pt.id).map((s) => ({ ...s, label: ACTIVITY_LABELS[s.activity] })),
    signals: signalSeries(pt.id, 21),
    sundown: sundownForecast(pt),
    bestTimes: bestTimes(pt.id),
  });
});

p.post('/suggestions/:sid', async (c) => {
  const pt = c.get('patient');
  const { action } = await c.req.json<{ action: 'accept' | 'dismiss' }>();
  const s = db().get<{ id: string; kind: string; payload_json: string }>(
    "SELECT id, kind, payload_json FROM suggestions WHERE id = ? AND patient_id = ? AND status = 'pending'",
    c.req.param('sid'),
    pt.id,
  );
  if (!s) return c.json({ error: 'Not found' }, 404);
  if (action === 'accept' && s.kind === 'move_session') {
    const payload = JSON.parse(s.payload_json) as { schedule_item_id: string; to: string };
    db().run('UPDATE schedule_items SET time_of_day = ? WHERE id = ? AND patient_id = ?', payload.to, payload.schedule_item_id, pt.id);
  }
  db().run('UPDATE suggestions SET status = ? WHERE id = ?', action === 'accept' ? 'accepted' : 'dismissed', s.id);
  return c.json({ ok: true });
});

// ---------- Schedule ----------

p.get('/schedule', (c) => c.json(db().all('SELECT * FROM schedule_items WHERE patient_id = ? ORDER BY time_of_day', c.get('patient').id)));

p.post('/schedule', async (c) => {
  const b = await c.req.json<{ kind: string; label: string; time: string; calming?: boolean }>();
  if (!['checkin', 'reminder', 'session'].includes(b.kind) || !b.label?.trim() || !/^\d{2}:\d{2}$/.test(b.time ?? '')) {
    return c.json({ error: 'Please give it a type, a label, and a time.' }, 400);
  }
  const id = newId();
  db().run(
    'INSERT INTO schedule_items (id, patient_id, kind, label, time_of_day, calming) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    c.get('patient').id,
    b.kind,
    b.label.trim().slice(0, 80),
    b.time,
    b.calming ? 1 : 0,
  );
  return c.json({ id });
});

p.patch('/schedule/:sid', async (c) => {
  const b = await c.req.json<{ label?: string; time?: string; enabled?: boolean }>();
  const pt = c.get('patient');
  const item = db().get<{ label: string; time_of_day: string; enabled: number }>(
    'SELECT label, time_of_day, enabled FROM schedule_items WHERE id = ? AND patient_id = ?',
    c.req.param('sid'),
    pt.id,
  );
  if (!item) return c.json({ error: 'Not found' }, 404);
  if (b.time && !/^\d{2}:\d{2}$/.test(b.time)) return c.json({ error: 'Time must be HH:MM' }, 400);
  db().run(
    'UPDATE schedule_items SET label = ?, time_of_day = ?, enabled = ? WHERE id = ?',
    (b.label ?? item.label).slice(0, 80),
    b.time ?? item.time_of_day,
    b.enabled === undefined ? item.enabled : b.enabled ? 1 : 0,
    c.req.param('sid'),
  );
  return c.json({ ok: true });
});

p.post('/schedule/:sid/photo', async (c) => {
  const pt = c.get('patient');
  const body = (await c.req.parseBody()) as Body;
  const photo = await fileField(body, 'photo');
  if (!photo || !photo.type.startsWith('image/')) return c.json({ error: 'Please choose a photo.' }, 400);
  db().run('UPDATE schedule_items SET photo_path = ? WHERE id = ? AND patient_id = ?', saveMedia(pt.id, photo.bytes, photo.type, photo.name), c.req.param('sid'), pt.id);
  return c.json({ ok: true });
});

// ---------- Reaching out ----------

/** "Check in on Mom now": the tablet starts a session or check-in immediately. */
p.post('/reach-out', async (c) => {
  const pt = c.get('patient');
  const { kind, scheduleItemId } = await c.req.json<{ kind: 'checkin' | 'session' | 'calming' | 'item'; scheduleItemId?: string }>();
  if (!deviceStatus(pt).online) return c.json({ error: `${pt.preferred_name}'s tablet isn't connected right now.` }, 409);
  if (kind === 'item' && scheduleItemId) {
    const item = db().get<Parameters<typeof inviteDevice>[1]>('SELECT * FROM schedule_items WHERE id = ? AND patient_id = ?', scheduleItemId, pt.id);
    if (!item) return c.json({ error: 'Not found' }, 404);
    inviteDevice(pt.id, item);
  } else {
    toDevice(pt.id, { type: 'invite', invite: { kind: kind === 'checkin' ? 'checkin' : 'session', scheduleItemId: null, calming: kind === 'calming' } });
  }
  return c.json({ ok: true });
});

p.post('/voice-notes', async (c) => {
  const pt = c.get('patient');
  const body = (await c.req.parseBody()) as Body;
  const audio = await fileField(body, 'audio');
  if (!audio || !audio.type.startsWith('audio/')) return c.json({ error: 'Please record a message first.' }, 400);
  const id = newId();
  db().run(
    'INSERT INTO voice_notes (id, patient_id, from_name, audio_path, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    pt.id,
    (textField(body, 'from') || c.get('user').name).slice(0, 60),
    saveMedia(pt.id, audio.bytes, audio.type, audio.name),
    nowIso(),
  );
  toDevice(pt.id, { type: 'voice_note', id });
  return c.json({ id });
});

// Demo helpers: run the nightly reflection or the scheduler on demand.
p.post('/nightly', async (c) => c.json(await runNightly(c.get('patient').id)));
p.post('/tick', async (c) => {
  await tickPatient(c.get('patient'));
  return c.json({ ok: true });
});

// Registered last: Hono copies a sub-app's routes at the moment it's mounted.
familyRoutes.route('/patients/:pid', p);
