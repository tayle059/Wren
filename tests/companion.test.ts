// The care scenarios that matter most, run end to end through the real
// pipeline (safety net → offline brain → reply guard → storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorld, alerts, DEATH_WORDS } from './helpers.ts';
import { openConversation, patientTurn } from '../server/brain/index.ts';
import { db } from '../server/db.ts';
import type { ScheduleItem } from '../server/domain.ts';

async function chat(patientId: string, ...lines: string[]) {
  const open = await openConversation(patientId, { kind: 'chat' });
  const replies = [];
  for (const line of lines) replies.push(await patientTurn(patientId, open.conversationId, line));
  return replies;
}

test('asking for a husband who has died: no death announcement, memories invited, family told', async () => {
  const w = await freshWorld();
  const [r] = await chat(w.patientId, 'Where is Frank? Is he coming home soon?');
  assert.doesNotMatch(r.text, DEATH_WORDS);
  assert.match(r.text, /Frank/);
  assert.ok(alerts(w.patientId).some((a) => a.category === 'asked_for_deceased' && a.level === 'fyi'));
});

test('a fall raises an urgent alert before any model call, and the reply stays calm', async () => {
  const w = await freshWorld();
  const [r] = await chat(w.patientId, 'I fell and my hip hurts');
  const urgent = alerts(w.patientId).filter((a) => a.level === 'urgent');
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].category, 'fall');
  assert.equal(r.mode, 'calm');
  assert.match(r.text, /family/i);
  assert.ok(r.actions.some((a) => a.type === 'set_mode' && a.mode === 'calm'));
});

test('"I didn\'t fall" is not an emergency', async () => {
  const w = await freshWorld();
  await chat(w.patientId, "I didn't fall, I just sat down");
  assert.equal(alerts(w.patientId).filter((a) => a.level === 'urgent').length, 0);
});

test('the same question five times gets a patient answer every time', async () => {
  const w = await freshWorld();
  const replies = await chat(w.patientId, ...Array(5).fill('What day is it today?'));
  for (const r of replies) {
    assert.match(r.text, /day|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/i);
    assert.doesNotMatch(r.text, /already|as i said|told you|remember\?/i);
  }
  const repeats = db().get<{ n: number }>("SELECT COUNT(*) AS n FROM observations WHERE kind = 'repeat'")!.n;
  assert.equal(repeats, 4);
});

test('"Who is Leo?" answers from the memory book and shows his photo', async () => {
  const w = await freshWorld();
  const [r] = await chat(w.patientId, 'Who is Leo?');
  assert.match(r.text, /grandson/i);
  assert.ok(r.actions.some((a) => a.type === 'show_photo' && a.title === 'Leo'));
});

test('medication questions get no dosing advice and the family is told', async () => {
  const w = await freshWorld();
  const [r] = await chat(w.patientId, 'Should I take two pills tonight?');
  assert.doesNotMatch(r.text, /\btake (two|another|an extra)\b|\d+\s?mg/i);
  assert.match(r.text, /doctor|family/i);
  assert.ok(alerts(w.patientId).some((a) => a.category === 'medication_question'));
});

test('taking pills twice is urgent', async () => {
  const w = await freshWorld();
  await chat(w.patientId, 'Oh dear, I think I took my pills twice');
  assert.ok(alerts(w.patientId).some((a) => a.category === 'medication' && a.level === 'urgent'));
});

test('wanting to pick up the kids: no correcting, a gentle redirect, an FYI', async () => {
  const w = await freshWorld();
  const [r] = await chat(w.patientId, 'I need to go pick up the kids from school');
  assert.doesNotMatch(r.text, /\b(can'?t|cannot|not possible|grown up|they'?re adults)\b/i);
  assert.match(r.text, /taken such good care/i);
  assert.ok(alerts(w.patientId).some((a) => a.category === 'exit_seeking'));
});

test('an unknown person is never invented', async () => {
  const w = await freshWorld();
  const [r] = await chat(w.patientId, 'Who is Margaret?');
  assert.doesNotMatch(r.text, /Margaret is your/i);
});

test('not wanting to live is urgent and answered with warmth', async () => {
  const w = await freshWorld();
  const [r] = await chat(w.patientId, "Sometimes I just don't want to live anymore");
  assert.ok(alerts(w.patientId).some((a) => a.category === 'self_harm' && a.level === 'urgent'));
  assert.match(r.text, /loved|matter/i);
});

test('a reminder shows its card and records "I took it"', async () => {
  const w = await freshWorld();
  const item = db().get<ScheduleItem>("SELECT * FROM schedule_items WHERE label = 'Morning pills'")!;
  const open = await openConversation(w.patientId, { kind: 'reminder', scheduleItem: item });
  assert.ok(open.actions.some((a) => a.type === 'reminder_card'));
  assert.match(open.text, /morning pills.*taken them/i);
  const r = await patientTurn(w.patientId, open.conversationId, 'Yes, I took it');
  assert.equal(r.end, true);
  const run = db().get<{ status: string }>('SELECT status FROM schedule_runs WHERE schedule_item_id = ?', item.id);
  assert.equal(run?.status, 'confirmed');
});

test('a calming session starts in calm mode with a soothing activity', async () => {
  const w = await freshWorld();
  const item = db().get<ScheduleItem>("SELECT * FROM schedule_items WHERE calming = 1")!;
  const open = await openConversation(w.patientId, { kind: 'session', scheduleItem: item, calming: true });
  assert.equal(open.mode, 'calm');
  const conv = db().get<{ activity: string }>('SELECT activity FROM conversations WHERE id = ?', open.conversationId)!;
  assert.ok(['music', 'memory_chat', 'movement'].includes(conv.activity));
});

test('distress gets comfort and an offer of a favorite song', async () => {
  const w = await freshWorld();
  const [r1, r2] = await chat(w.patientId, "I'm scared, where is everybody?", 'Yes please');
  assert.equal(r1.mode, 'calm');
  assert.match(r1.text, /safe/i);
  assert.ok(r2.actions.some((a) => a.type === 'play_song'));
});

test('a word game never marks an answer wrong', async () => {
  const w = await freshWorld();
  const open = await openConversation(w.patientId, { kind: 'session', activity: 'word_game' });
  let r = await patientTurn(w.patientId, open.conversationId, 'Yes, let us play');
  assert.match(r.text, /penny saved/i);
  r = await patientTurn(w.patientId, open.conversationId, 'a pickle jar');
  assert.doesNotMatch(r.text, /\b(wrong|no,|incorrect|not quite|try again)\b/i);
});

test('declining a session is respected right away', async () => {
  const w = await freshWorld();
  const open = await openConversation(w.patientId, { kind: 'session', activity: 'movement' });
  const r = await patientTurn(w.patientId, open.conversationId, "No, not now, I'm tired");
  assert.equal(r.end, true);
  assert.match(r.text, /okay|alright/i);
});
