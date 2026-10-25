// System behavior: the scheduler, the nightly reflection, learning, the Muse
// Spark tool loop (against a mocked Meta API), and the HTTP API end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorld, alerts } from './helpers.ts';
import { db } from '../server/db.ts';
import { subscribe, type KEvent } from '../server/events.ts';
import { tickPatient } from '../server/jobs/scheduler.ts';
import { runNightly } from '../server/jobs/nightly.ts';
import { endConversation, openConversation, patientTurn, setForceOffline } from '../server/brain/index.ts';
import { getPatient } from '../server/domain.ts';
import { localDayRangeUtc, localParts, setClock } from '../server/util/time.ts';
import { stats } from '../server/adapt/bandit.ts';
import { config } from '../server/config.ts';
import { buildApp } from '../server/app.ts';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../server/seed.ts';

function localTime(tz: string, hhmm: string) {
  const { date } = localParts(tz);
  const { start } = localDayRangeUtc(tz, date);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(start) + (h * 60 + m) * 60000);
}

test('scheduler: invites at the right time, retries once, then flags a missed check-in', async () => {
  const w = await freshWorld();
  const p = getPatient(w.patientId)!;
  const events: KEvent[] = [];
  const off = subscribe(`device:${p.id}`, (e) => events.push(e));
  let t = localTime(p.timezone, '08:20').getTime();
  setClock(() => new Date(t));
  try {
    await tickPatient(p);
    assert.equal(events.length, 0, 'nothing due yet');
    t = localTime(p.timezone, '08:31').getTime();
    await tickPatient(p);
    assert.equal(events.length, 1);
    assert.equal((events[0].invite as { kind: string }).kind, 'checkin');
    await tickPatient(p);
    assert.equal(events.length, 1, 'no duplicate invite');

    // Tablet opens it, but Rose doesn't answer.
    const item = db().get<{ id: string }>("SELECT id FROM schedule_items WHERE label = 'Morning check-in'")!;
    const open = await openConversation(p.id, { kind: 'checkin', scheduleItem: db().get('SELECT * FROM schedule_items WHERE id = ?', item.id) as never });
    await endConversation(p.id, open.conversationId, 'no_response');

    t += 21 * 60000; // 8:52 → retry (pills at 9:00 aren't due yet)
    await tickPatient(p);
    const retries = events.filter((e) => (e.invite as { scheduleItemId: string }).scheduleItemId === item.id);
    assert.equal(retries.length, 2);

    t += 21 * 60000;
    await tickPatient(p);
    assert.ok(alerts(p.id).some((a) => a.category === 'missed_checkin'));
  } finally {
    off();
    setClock(() => new Date());
  }
});

test('scheduler: waits while the tablet is offline instead of burning attempts', async () => {
  const w = await freshWorld();
  const p = getPatient(w.patientId)!;
  const t = localTime(p.timezone, '08:31');
  setClock(() => t);
  try {
    await tickPatient(p);
    assert.equal(db().get('SELECT COUNT(*) AS n FROM schedule_runs')!.n, 0);
  } finally {
    setClock(() => new Date());
  }
});

test('a simulated week teaches the companion, writes summaries, and suggests an earlier calming session', async () => {
  const w = await freshWorld({ history: true });
  const p = getPatient(w.patientId)!;
  assert.match(p.what_works_text, /right side.*\[family\]/, 'family line preserved');
  assert.match(p.what_works_text, /restless from around 3:00 PM/);
  const s = stats(p.id);
  assert.ok(s.find((x) => x.activity === 'movement')!.mean < 0.35, 'declined movement every time');
  assert.equal(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM daily_summaries')!.n, 6);
  const sug = db().get<{ text: string; payload_json: string }>("SELECT text, payload_json FROM suggestions WHERE kind = 'move_session'");
  assert.ok(sug, 'sundown suggestion exists');
  assert.equal(JSON.parse(sug!.payload_json).to, '14:30');
  const tonight = await runNightly(p.id);
  assert.ok(tonight?.summary.summary);
});

test('Muse Spark brain: tool calls run, results flow back, and the guard still applies', async () => {
  const w = await freshWorld();
  const calls: { body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  const leo = db().get<{ id: string }>("SELECT id FROM memory_items WHERE title = 'Leo'")!;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ body });
    const message =
      calls.length === 1
        ? { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'show_photo', arguments: JSON.stringify({ memory_id: leo.id }) } }] }
        : { content: '**Leo** is your grandson! You already asked, but here he is. Isn’t he handsome?' };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;
  config.meta.apiKey = 'test-key';
  setForceOffline(false);
  try {
    const open = await openConversation(w.patientId, { kind: 'chat' });
    calls.length = 0;
    const r = await patientTurn(w.patientId, open.conversationId, 'Who is that boy?');
    assert.equal(r.source, 'muse');
    assert.ok(r.actions.some((a) => a.type === 'show_photo'));
    assert.doesNotMatch(r.text, /already asked|\*\*/);
    assert.equal(calls[0].body.model, 'muse-spark-1.3');
    assert.ok(Array.isArray(calls[0].body.tools));
    const second = calls[1].body.messages as { role: string; content: string }[];
    assert.equal(second.at(-1)!.role, 'tool');
  } finally {
    globalThis.fetch = realFetch;
    config.meta.apiKey = '';
    setForceOffline(true);
  }
});

test('Muse Spark brain: when the API fails, the offline brain answers instead', async () => {
  const w = await freshWorld();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('overloaded', { status: 503 })) as typeof fetch;
  config.meta.apiKey = 'test-key';
  setForceOffline(false);
  try {
    const open = await openConversation(w.patientId, { kind: 'chat' });
    assert.equal(open.source, 'offline');
    const r = await patientTurn(w.patientId, open.conversationId, 'I fell down');
    assert.equal(r.source, 'offline');
    assert.ok(alerts(w.patientId).some((a) => a.level === 'urgent'));
  } finally {
    globalThis.fetch = realFetch;
    config.meta.apiKey = '';
    setForceOffline(true);
  }
});

test('HTTP: sign in, pair a tablet, talk, and see the alert on the family side', async () => {
  await freshWorld();
  const app = buildApp();
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
  const post = (path: string, body: unknown, token?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  const login = await json(await post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD }));
  assert.equal(login.status, 200);
  const token = login.body.token as string;
  const me = await json(await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } }));
  const pid = me.body.patients[0].id;

  // Another family's account can't see Rose.
  const other = await json(await post('/api/auth/signup', { email: 'x@example.com', name: 'X', password: 'password123' }));
  const denied = await app.request(`/api/patients/${pid}/home`, { headers: { Authorization: `Bearer ${other.body.token}` } });
  assert.equal(denied.status, 404);

  const pairing = await json(await post(`/api/patients/${pid}/pairing`, {}, token));
  const paired = await json(await post('/api/device/pair', { code: pairing.body.code }));
  assert.equal(paired.status, 200);
  const again = await post('/api/device/pair', { code: pairing.body.code });
  assert.equal(again.status, 400, 'codes are single use');
  const device = paired.body.token as string;

  const opened = await json(await post('/api/device/open', { kind: 'chat' }, device));
  const turn = await json(await post('/api/device/turn', { conversationId: opened.body.conversationId, text: "I can't get up" }, device));
  assert.ok(turn.body.reply.text);

  const home = await json(await app.request(`/api/patients/${pid}/home`, { headers: { Authorization: `Bearer ${token}` } }));
  assert.equal(home.body.alerts[0].level, 'urgent');
  assert.equal(home.body.device.paired, true);

  const state = await json(await app.request('/api/device/state', { headers: { Authorization: `Bearer ${device}` } }));
  assert.equal(state.body.patient.name, 'Rose');
  assert.equal(state.body.stt, 'browser');
});
