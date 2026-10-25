import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReply } from '../server/brain/guard.ts';
import { assessSafety } from '../server/brain/safety.ts';
import { repeatCount } from '../server/brain/repetition.ts';
import { priorsFromAbout, sampleBeta } from '../server/adapt/bandit.ts';
import { engagementScore } from '../server/adapt/engagement.ts';
import { mattr } from '../server/adapt/signals.ts';
import { familyLines } from '../server/jobs/nightly.ts';
import { reminderLine } from '../server/brain/offlineBrain.ts';
import { localParts, localDayRangeUtc } from '../server/util/time.ts';
import type { MemoryItem } from '../server/domain.ts';
import { ROSE_ABOUT } from '../server/seed.ts';

const frank = {
  id: 'f',
  kind: 'person',
  title: 'Frank',
  relationship: 'Husband',
  deceased: 1,
  body: 'He passed away in 2019.',
  prompts_json: JSON.stringify(['He passed away peacefully.', 'Did Frank like to dance?']),
} as MemoryItem;

const ctx = (over: Partial<Parameters<typeof guardReply>[1]> = {}) => ({
  patientText: 'Where is Frank?',
  patientName: 'Rose',
  memory: [frank],
  deceasedPerson: frank,
  medicationQuestion: false,
  ...over,
});

test('guard: a death announcement is replaced, and loss-related prompts are never reused', () => {
  const g = guardReply("I'm so sorry, Rose. Frank passed away in 2019.", ctx());
  assert.ok(g.violations.includes('death_announcement'));
  assert.doesNotMatch(g.text, /passed|died/i);
  assert.match(g.text, /Did Frank like to dance\?/);
});

test('guard: if the person raises the loss themselves, gentle acknowledgement is allowed', () => {
  const g = guardReply('You miss Frank since he passed. Tell me about him.', ctx({ patientText: 'Frank died, didn’t he?' }));
  assert.ok(!g.violations.includes('death_announcement'));
});

test('guard: scolding for repeats is removed', () => {
  const g = guardReply("You already asked me that. It's Sunday, Rose.", ctx({ deceasedPerson: null, patientText: 'What day is it?' }));
  assert.ok(g.violations.includes('scolding'));
  assert.equal(g.text, "It's Sunday, Rose.");
});

test('guard: dosing advice is replaced', () => {
  const g = guardReply('You can take 2 tablets if it hurts.', ctx({ deceasedPerson: null, medicationQuestion: true }));
  assert.ok(g.violations.includes('medical_advice'));
  assert.match(g.text, /doctor/);
});

test('guard: never claims to be family', () => {
  const g = guardReply("Don't worry, I'm your daughter.", ctx({ deceasedPerson: null }));
  assert.ok(g.violations.includes('impersonation'));
  assert.doesNotMatch(g.text, /daughter/);
});

test('guard: long replies are trimmed but keep the closing question', () => {
  const g = guardReply('One. Two. Three. Four. Would you like some music?', ctx({ deceasedPerson: null }));
  assert.equal(g.text, 'One. Two. Would you like some music?');
});

test('guard: markdown and emoji are stripped for speech', () => {
  assert.equal(guardReply('**Hello** Rose 🌷', ctx({ deceasedPerson: null })).text, 'Hello Rose');
});

test('safety: emergency phrasing and negation', () => {
  assert.equal(assessSafety('I fell in the kitchen', 'Rose', []).emergency?.category, 'fall');
  assert.equal(assessSafety('I fell asleep in my chair', 'Rose', []).emergency, null);
  assert.equal(assessSafety("I didn't fall", 'Rose', []).emergency, null);
  assert.equal(assessSafety('My chest hurts', 'Rose', []).emergency?.category, 'medical');
  assert.equal(assessSafety('Help!', 'Rose', []).emergency?.category, 'help');
  assert.equal(assessSafety('Can you help me find my glasses?', 'Rose', []).emergency, null);
  assert.equal(assessSafety("There's a man outside the window", 'Rose', []).emergency?.category, 'safety');
  assert.equal(assessSafety('Frank fell off the tractor in 1962', 'Rose', [frank]).emergency, null);
});

test('safety: asking for someone who died, vs. telling a story about them', () => {
  assert.ok(assessSafety('Where is Frank?', 'Rose', [frank]).deceasedPerson);
  assert.ok(assessSafety('I miss Frank', 'Rose', [frank]).deceasedPerson);
  assert.equal(assessSafety('Frank loved to dance', 'Rose', [frank]).deceasedPerson, null);
});

test('repetition: similar questions count, statements do not', () => {
  const earlier = ['What day is it?', 'what day is it today', 'I love the garden', 'Who is coming?'];
  assert.equal(repeatCount('What day is it?', earlier), 2);
  assert.equal(repeatCount('I love the garden', earlier), 0);
});

test('bandit: family notes set priors, dislikes count against', () => {
  const p = priorsFromAbout(ROSE_ABOUT);
  assert.ok(p.music.alpha > 1, 'loves hymns and old songs');
  assert.ok(p.memory_chat.alpha > 1, 'loves photos and stories');
  assert.ok(p.word_game.beta > 1, 'crosswords frustrate her');
});

test('bandit: Beta sampling has the right mean', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const draws = Array.from({ length: 4000 }, () => sampleBeta(6, 2, rng));
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.75) < 0.02, `mean ${mean}`);
});

test('engagement: talkative and joyful beats short; a decline is low but not zero', () => {
  const rich = engagementScore({ patientTexts: ['Oh I love this song, we sang it every Sunday at church', 'Ha, those were wonderful days', 'Margaret sang alto', 'Thank you', 'More please'], completed: true, declined: false });
  const thin = engagementScore({ patientTexts: ['ok'], completed: false, declined: false });
  assert.ok(rich > 0.8 && thin < 0.2, `${rich} ${thin}`);
  assert.equal(engagementScore({ patientTexts: [], completed: false, declined: true }), 0.15);
});

test('signals: MATTR rewards varied vocabulary', () => {
  assert.equal(mattr(['a', 'b', 'c', 'd']), 1);
  assert.ok(mattr(Array(100).fill('day')) < 0.05);
});

test('what works: family lines are found for preservation', () => {
  assert.deepEqual(familyLines('- Speak on her right side. [family]\n- Music helps.'), ['- Speak on her right side. [family]']);
});

test('reminders are phrased for what they are', () => {
  assert.equal(reminderLine('Morning pills'), "it's time for your morning pills. Have you taken them yet?");
  assert.match(reminderLine('Lunch'), /something to eat/);
  assert.match(reminderLine('Blood pressure medicine'), /taken it yet/);
});

test('time: local parts and day ranges respect the patient timezone', () => {
  const at = new Date('2026-10-26T03:30:00Z'); // 10:30pm Oct 25 in Chicago
  const p = localParts('America/Chicago', at);
  assert.equal(p.date, '2026-10-25');
  assert.equal(p.hhmm, '22:30');
  const r = localDayRangeUtc('America/Chicago', '2026-10-25');
  assert.equal(r.start, '2026-10-25T05:00:00.000Z');
});
