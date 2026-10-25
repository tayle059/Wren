// Builds Rose's world for demos and tests: her family, memory book, schedule,
// and (optionally) a week of history produced by running the real system
// over simulated days, so Insights and "What works" have something to show.
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { config } from './config.ts';
import { db, openDb, setDb, type Db } from './db.ts';
import { createSession, createUser, newId } from './auth.ts';
import { createPatient } from './routes/family.ts';
import { saveMedia } from './media.ts';
import { amazingGraceWav } from './util/musicbox.ts';
import { addDays, localDayRangeUtc, localParts, setClock } from './util/time.ts';
import { endConversation, mediaEnded, openConversation, patientTurn, setForceOffline, conversationState } from './brain/index.ts';
import { recordOutcome } from './adapt/bandit.ts';
import { runNightly } from './jobs/nightly.ts';
import { getPatient, type ScheduleItem } from './domain.ts';
import type { SessionPlan } from './brain/types.ts';

export const DEMO_EMAIL = 'sarah@kindred.demo';
export const DEMO_PASSWORD = 'kindred-demo';

export const ROSE_ABOUT = `Rose grew up on a dairy farm outside Ames, Iowa, and taught third grade for 31 years. She loves gardening (especially tomatoes and peonies), hymns and old songs, and her grandson Leo. She lights up looking at photos and telling stories about the farm. She is hard of hearing in her left ear, so short, clear sentences help. Please avoid talking about selling the house, it upsets her. Crossword puzzles frustrate her now.`;

interface SeedResult {
  userId: string;
  patientId: string;
  token: string;
  ids: Record<string, string>;
}

export function seedWorld(): SeedResult {
  const user = createUser(DEMO_EMAIL, 'Sarah Miller', DEMO_PASSWORD);
  const patientId = createPatient(user.id, {
    name: 'Rose Miller',
    preferred_name: 'Rose',
    pronouns: 'she/her',
    timezone: 'America/Chicago',
    birth_year: 1944,
    about: ROSE_ABOUT,
    relationship: 'Daughter',
  });
  db().run(
    "UPDATE patients SET what_works_text = ? WHERE id = ?",
    '- Speak on her right side; she hears better there. [family]',
    patientId,
  );

  const ids: Record<string, string> = {};
  const add = (key: string, m: { kind: string; title: string; body: string; relationship?: string; deceased?: boolean; photo?: string; audio?: string | null; prompts: string[] }) => {
    const id = newId();
    ids[key] = id;
    db().run(
      `INSERT INTO memory_items (id, patient_id, kind, title, body, relationship, deceased, photo_path, audio_path, prompts_json, ai_description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      patientId,
      m.kind,
      m.title,
      m.body,
      m.relationship ?? '',
      m.deceased ? 1 : 0,
      m.photo ?? null,
      m.audio ?? null,
      JSON.stringify(m.prompts),
      '',
      new Date().toISOString(),
    );
  };
  add('leo', {
    kind: 'person',
    title: 'Leo',
    relationship: 'Grandson',
    body: "Leo is 12 and plays soccer for the Ames Comets (number 12). He visits on Sundays and loves Rose's tomato sandwiches.",
    photo: '/demo/leo.svg',
    prompts: ['Would you like to hear about his soccer games?', 'What do you and Leo like to do together?', 'What was Leo like as a little one?'],
  });
  add('sarah', {
    kind: 'person',
    title: 'Sarah',
    relationship: 'Daughter',
    body: 'Sarah lives twenty minutes away in Ames and calls every evening around seven. She is a nurse.',
    photo: '/demo/sarah.svg',
    prompts: ['What was Sarah like when she was a little girl?', 'What do you and Sarah talk about on the phone?'],
  });
  add('frank', {
    kind: 'person',
    title: 'Frank',
    relationship: 'Husband',
    deceased: true,
    body: 'Frank and Rose were married 52 years. He passed away in 2019. He loved fixing old tractors and dancing at the county fair.',
    photo: '/demo/frank.svg',
    prompts: ['What was Frank like when you first met?', 'Did Frank like to dance?', 'What did Frank love about the farm?'],
  });
  add('biscuit', {
    kind: 'person',
    title: 'Biscuit',
    relationship: 'Golden retriever',
    body: 'Biscuit is Rose’s golden retriever. He sleeps by her chair and loves belly rubs.',
    photo: '/demo/biscuit.svg',
    prompts: ['What does Biscuit like to do all day?', 'Have you always had dogs?'],
  });
  add('farm', {
    kind: 'place',
    title: 'The farm near Ames',
    body: 'Rose grew up on a dairy farm with a red barn, forty cows, and a huge vegetable garden.',
    photo: '/demo/farm.svg',
    prompts: ['What were mornings like on the farm?', 'Did you have a favorite cow?', 'What did you grow in the garden?'],
  });
  add('fair', {
    kind: 'story',
    title: 'The county fair, 1961',
    body: 'Rose met Frank at the Story County Fair in 1961. They won the dance contest together.',
    photo: '/demo/fair.svg',
    prompts: ['What was the county fair like back then?', 'What music did they play at the dance?'],
  });
  const song = saveMedia(patientId, amazingGraceWav(), 'audio/wav', 'amazing-grace.wav');
  add('song', {
    kind: 'song',
    title: 'Amazing Grace',
    body: 'Her favorite hymn. She sang it in the Methodist church choir for years.',
    audio: song,
    prompts: ['Did you sing that in church?', 'Who did you sing with in the choir?'],
  });

  db().run("UPDATE schedule_items SET photo_path = '/demo/pills.svg' WHERE patient_id = ? AND label LIKE '%pills%'", patientId);

  // Rose's Book starts with a few stories the family already knew.
  const stories = [
    ['Meeting Frank at the county fair', '1960s', 'Rose met Frank at the Story County Fair in 1961. He asked her to dance twice before she said yes, and they won the dance contest that night.', 'He had two left feet, but he wouldn’t give up.'],
    ['The winter the barn roof fell in', '1950s', 'One winter the snow was so heavy that part of the barn roof gave way. Rose and her brother helped their father move all forty cows into the machine shed in the middle of the night.', 'We were out there with lanterns until the sun came up.'],
    ['Her first classroom', '1960s', 'Rose’s first teaching job was a third-grade class of 28 children in Nevada, Iowa. She kept a jar of peppermints on her desk for good days.', 'Every child got a peppermint on a good day, and most days were good days.'],
  ];
  for (const [title, era, text, quote] of stories) {
    db().run(
      'INSERT INTO stories (id, patient_id, title, era, text, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(),
      patientId,
      title,
      era,
      text,
      quote,
      new Date(Date.now() - 9 * 86400000).toISOString(),
    );
  }

  return { userId: user.id, patientId, token: createSession(user.id), ids };
}

// ---------- A simulated week ----------

type Script = Record<string, string[]>;

const ACTIVITY_SCRIPT: Script = {
  memory_chat: [
    'Oh my, look at that.',
    'I remember we used to get up before dawn to milk the cows, and my father would sing the whole time.',
    'We had the best tomatoes in the county. Everyone said so.',
    'Those were good days.',
  ],
  music: ['Yes, please.', 'Oh, I sang that in the choir every Sunday.', 'With my friend Margaret. She had a lovely voice.', 'That was beautiful.'],
  word_game: ['Yes, let’s play.', 'A penny earned!', 'The worm, of course.', 'A silver lining. Ha, I love these.', 'The doctor away!'],
  movement: ['No, not now, I’m tired.'],
  today: ['Yes.', 'That sounds nice.'],
};

const CHECKIN_REPLIES = ['I slept pretty well, thank you.', 'Oh, not too bad.', 'I had a good night.', "I didn't sleep very well.", 'Fine, thank you dear.', 'Pretty good.'];

function at(tz: string, date: string, hhmm: string, plusSeconds = 0): Date {
  const { start } = localDayRangeUtc(tz, date);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(start) + (h * 60 + m) * 60000 + plusSeconds * 1000);
}

async function converse(patientId: string, plan: SessionPlan, lines: string[] | ((activity: string) => string[]), clock: { t: number }) {
  const reply = await openConversation(patientId, plan);
  const activity = conversationState(reply.conversationId)?.plan.activity ?? '';
  const script = typeof lines === 'function' ? lines(activity) : lines;
  let ended = reply.end;
  for (const line of script) {
    if (ended) break;
    clock.t += (25 + Math.floor(Math.random() * 30)) * 1000;
    const r = await patientTurn(patientId, reply.conversationId, line);
    ended = r.end;
    // Music: the song plays, then the companion follows up.
    if (r.actions.some((a) => a.type === 'play_song') && !ended) {
      clock.t += 40_000;
      ended = (await mediaEnded(patientId, reply.conversationId))?.end ?? ended;
    }
  }
  clock.t += 20_000;
  await endConversation(patientId, reply.conversationId, ended ? 'goodbye' : 'silence');
}

export async function simulateWeek(patientId: string, days = 6) {
  const savedKey = config.meta.apiKey;
  config.meta.apiKey = ''; // the simulation always uses the offline brain
  setForceOffline(true);
  const patient = getPatient(patientId)!;
  const tz = patient.timezone;
  const today = localParts(tz).date;
  const items = db().all<ScheduleItem>('SELECT * FROM schedule_items WHERE patient_id = ? ORDER BY time_of_day', patientId);
  const byLabel = (l: string) => items.find((i) => i.label === l)!;
  const clock = { t: 0 };
  setClock(() => new Date(clock.t));
  try {
    for (let d = days; d >= 1; d--) {
      const date = addDays(today, -d);
      const run = async (hhmm: string, plan: SessionPlan, lines: string[] | ((a: string) => string[])) => {
        clock.t = at(tz, date, hhmm).getTime();
        await converse(patientId, plan, lines, clock);
      };
      await run('08:31', { kind: 'checkin', scheduleItem: byLabel('Morning check-in') }, [CHECKIN_REPLIES[d % CHECKIN_REPLIES.length]]);
      await run('09:01', { kind: 'reminder', scheduleItem: byLabel('Morning pills') }, [d === 3 ? 'Not yet.' : 'Yes, I took them.']);
      await run('10:00', { kind: 'session', scheduleItem: byLabel('Morning activity') }, (a) => ACTIVITY_SCRIPT[a] ?? ACTIVITY_SCRIPT.today);
      // Repeated question around midday.
      await run('11:40', { kind: 'chat' }, ['What day is it today?', 'Thank you, dear.', 'Goodbye.']);
      await run('12:31', { kind: 'reminder', scheduleItem: byLabel('Lunch') }, ['Yes, I had soup.']);
      await run('13:15', { kind: 'chat' }, ['What day is it?', 'Oh good.', 'Bye now.']);
      await run('14:00', { kind: 'session', scheduleItem: byLabel('Afternoon activity') }, (a) => ACTIVITY_SCRIPT[a] ?? ACTIVITY_SCRIPT.today);
      // Sundowning: restless from about 3pm most days.
      if (d % 3 !== 0) {
        await run('15:12', { kind: 'chat' }, ["I'm worried. Where is everybody?", 'Yes please.', 'That helps.']);
        await run('15:48', { kind: 'chat' }, [d % 2 ? 'I need to go home now.' : 'Where is Frank? Is he coming home soon?', 'He was a wonderful dancer.', 'Goodbye.']);
        await run('16:05', { kind: 'chat' }, ["I'm confused, I don't know what I'm supposed to be doing.", 'Yes.', 'Thank you.']);
      }
      await run('16:30', { kind: 'session', scheduleItem: byLabel('Calming time'), calming: true }, (a) => ACTIVITY_SCRIPT[a] ?? ACTIVITY_SCRIPT.music);
      await run('20:01', { kind: 'reminder', scheduleItem: byLabel('Evening pills') }, ['Yes.']);
      clock.t = at(tz, date, '21:00').getTime();
      db().run('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)', `nightly:${patientId}:${date}`, new Date(clock.t).toISOString());
      await runNightly(patientId, date);
    }
    // Earlier weeks: word games used to go less well; keeps the learning curve honest.
    for (let i = 0; i < 2; i++) recordOutcome(patientId, 'movement', 0.2, 10, null);
    // History alerts have been seen by the family already.
    db().run("UPDATE alerts SET ack_at = created_at, ack_by = 'Sarah Miller' WHERE patient_id = ?", patientId);
  } finally {
    setClock(() => new Date());
    setForceOffline(false);
    config.meta.apiKey = savedKey;
  }
}

export async function seedDemo(opts: { history?: boolean; target?: Db } = {}) {
  if (opts.target) setDb(opts.target);
  const world = seedWorld();
  if (opts.history !== false) await simulateWeek(world.patientId);
  return world;
}

// CLI: `npm run seed` wipes ./data and builds the demo.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  rmSync(config.dataDir, { recursive: true, force: true });
  setDb(openDb());
  const t0 = Date.now();
  const world = await seedDemo();
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n;
  console.log(`Seeded Rose's world with a simulated week (${n} messages) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Family sign-in: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  void world;
}
