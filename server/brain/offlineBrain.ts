// The offline brain. A careful, rule-based companion that runs when there is no
// Meta API key, when the API is slow or down, and in tests. It follows the same
// care rules as the Muse Spark persona, so the experience degrades gracefully
// instead of breaking.
import type { MemoryItem } from '../domain.ts';
import { localParts, partOfDay, spokenDate, spokenTime } from '../util/time.ts';
import { photoAction, searchMemory, songAction, runTool, type ToolEffects } from './tools.ts';
import { redirectForDeceased } from './guard.ts';
import { similarity } from './repetition.ts';
import type { BrainInput, BrainOutput, ConvState } from './types.ts';

const YES = /\b(yes|yeah|yep|yup|sure|okay|ok|alright|all right|please|i'?d like that|i would|let'?s|sounds (good|nice|lovely)|why not|of course|i did|i took|done|already)\b/i;
const NO = /\b(no|nope|not (now|today|yet|really)|maybe later|later|i'?m tired|too tired|leave me alone|don'?t want|go away|i haven'?t|i forgot)\b/i;
const GOODBYE = /\b(bye|goodbye|good night|goodnight|see you|that'?s all|i'?m done|stop talking|let me rest|talk (to you )?later)\b/i;
const ORIENTATION = /\bwhat (day|time|date|month|year)\b|\bwhat'?s (today|the date|the time)\b|\bis it (morning|afternoon|evening|night)\b|\bwhat day is it\b/i;
const VISIT = /\b(who'?s coming|is (anyone|somebody|someone) coming|any(one|body) (visiting|coming)|when is .* coming|is .* coming (today|over))\b/i;
const STORY_CUE = /\b(i remember|when i was|we used to|back then|years ago|my (mother|father|mom|dad|husband|wife) (used to|would)|growing up|in those days|we had a|we lived)\b/i;
const GOOD_FEELING = /\b(good|great|fine|well|lovely|wonderful|okay|ok|alright|not bad|happy)\b/i;
const BAD_FEELING = /\b(bad|badly|terrible|awful|not (good|well|great)|poorly|tired|sad|lonely|didn'?t sleep|couldn'?t sleep|hurts?|sore)\b/i;

const PROVERBS: [string, string][] = [
  ['A penny saved is', 'a penny earned'],
  ['The early bird catches', 'the worm'],
  ['Every cloud has a', 'silver lining'],
  ['An apple a day keeps', 'the doctor away'],
  ['Home is where', 'the heart is'],
  ['Two heads are', 'better than one'],
  ["Don't count your chickens before", 'they hatch'],
  ['Better late than', 'never'],
  ['Where there is a will, there is', 'a way'],
  ['A watched pot never', 'boils'],
];

const MOVEMENT_STEPS = [
  "Let's start by sitting up nice and comfortable, with your hands resting in your lap.",
  "Now a slow breath in through your nose. And gently out. Lovely.",
  "Let's roll your shoulders back, slowly, once or twice. Nice and easy.",
  'Now reach your arms up, only as high as feels good, and bring them gently down.',
  'Turn your head slowly to look over one shoulder, and then the other.',
  'One more slow breath in. And out. You did wonderfully.',
];

const MEMORY_FOLLOWUPS = [
  'What else do you remember about that?',
  'Who else was there with you?',
  'How did that make you feel?',
  'What was your favorite part?',
];

function pick(state: ConvState, options: string[]): string {
  const fresh = options.filter((o) => !state.usedLines.includes(o));
  const choice = (fresh.length ? fresh : options)[Math.floor(Math.random() * (fresh.length || options.length))];
  state.usedLines.push(choice);
  return choice;
}

function firstName(m: MemoryItem) {
  return m.title.split(/\s+/)[0];
}

function prompts(m: MemoryItem): string[] {
  try {
    return JSON.parse(m.prompts_json) as string[];
  } catch {
    return [];
  }
}

function nextPhotoItem(input: BrainInput): MemoryItem | null {
  const candidates = input.memory.filter((m) => m.photo_path && !m.deceased && !input.state.shownPhotos.includes(m.id));
  const pool = candidates.length ? candidates : input.memory.filter((m) => m.photo_path && !m.deceased);
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

const favoriteSong = (input: BrainInput) => input.memory.find((m) => m.kind === 'song' && m.audio_path) ?? null;

export async function offlineBrain(input: BrainInput): Promise<BrainOutput> {
  const fx: ToolEffects = { actions: [], end: false, log: [] };
  const say = (text: string) => ({ text, actions: fx.actions, end: fx.end, toolLog: fx.log, source: 'offline' as const });
  const { state, patient } = input;
  const name = patient.preferred_name;

  if (input.patientText === null && input.event === 'media_ended') return say(await afterMedia(input, fx));
  if (input.patientText === null) return say(await opener(input, fx));
  const text = input.patientText.trim();
  const safety = input.safety;

  // 1. Emergencies always come first. The alert was already raised upstream.
  if (safety?.emergency) {
    await runTool('set_mode', { mode: 'calm' }, input, fx);
    const lines: Record<string, string> = {
      fall: `Oh, ${name}, I'm right here with you. I've let your family know right away. Try to stay still and comfortable. Can you tell me where it hurts?`,
      medical: `${name}, I'm right here. I've let your family know right away. If you can, sit down and rest. Breathe slowly with me.`,
      safety: `${name}, I'm here with you. I've let your family know right now. Stay somewhere that feels safe.`,
      help: `I'm right here, ${name}. I've let your family know. Can you tell me what's happening?`,
      self_harm: `${name}, I'm so glad you told me. You matter so much, and you are loved. I've let your family know, and I'm staying right here with you.`,
    };
    return say(lines[safety.emergency.category] ?? lines.help);
  }

  // 2. Goodbyes.
  if (GOODBYE.test(text)) {
    await runTool('end_conversation', {}, input, fx);
    return say(`Thank you for spending time with me, ${name}. I'm right here whenever you'd like to talk.`);
  }

  // 3. A reminder waiting for an answer.
  if (state.reminderPending) {
    if (YES.test(text) && !/\bnot yet\b/i.test(text)) {
      await runTool('confirm_reminder', { schedule_item_id: state.reminderPending, status: 'confirmed' }, input, fx);
      await runTool('end_conversation', {}, input, fx);
      return say(`Wonderful, thank you, ${name}. That's one thing done for today.`);
    }
    if (NO.test(text)) {
      await runTool('confirm_reminder', { schedule_item_id: state.reminderPending, status: 'not_yet' }, input, fx);
      await runTool('end_conversation', {}, input, fx);
      return say(`That's alright, ${name}. Whenever you're ready. I'll check back with you a little later.`);
    }
  }

  // 4. Asking for someone who has passed away: never announce it.
  if (safety?.deceasedPerson) {
    const photo = photoAction(safety.deceasedPerson);
    if (photo) fx.actions.push(photo);
    return say(redirectForDeceased(safety.deceasedPerson));
  }

  // 5. Wanting to leave: validate the feeling, then redirect.
  if (safety?.exitSeeking) {
    const item = nextPhotoItem(input);
    if (item) {
      const photo = photoAction(item);
      if (photo) fx.actions.push(photo);
      state.shownPhotos.push(item.id);
      return say(
        `You've always taken such good care of everyone, ${name}. Before you go, would you tell me about this? ${prompts(item)[0] ?? `It's ${item.title}.`}`,
      );
    }
    return say(`You've always taken such good care of everyone, ${name}. Let's sit together for a little while first. Tell me about your home growing up?`);
  }

  // 6. Medicine questions: no advice, ever.
  if (safety?.medicationQuestion) {
    return say(
      `That's a really good question, ${name}. Your family and your doctor know best about your medicine, so I've made a note for them. Let's not take anything extra until they check.`,
    );
  }

  // 7. Offers waiting on an answer.
  if (state.offer && (YES.test(text) || NO.test(text))) {
    const offer = state.offer;
    state.offer = null;
    if (NO.test(text) && !YES.test(text)) return say(`That's okay, ${name}. We can just sit together for a bit.`);
    if (offer === 'song') {
      const song = favoriteSong(input);
      if (song) {
        await runTool('play_song', { memory_id: song.id }, input, fx);
        state.step = Math.max(state.step, 1);
        return say(`Here it is. ${song.title}.`);
      }
    }
    if (offer === 'photo') return say(memoryChatOpen(input, fx));
  }

  // 8. Distress: comfort first, then something soothing.
  if (safety?.distress) {
    await runTool('set_mode', { mode: 'calm' }, input, fx);
    const song = favoriteSong(input);
    if (song) {
      state.offer = 'song';
      return say(`I'm right here with you, ${name}. You're safe at home. Would you like to listen to ${song.title} together?`);
    }
    return say(`I'm right here with you, ${name}. You're safe at home. Let's take a slow breath together.`);
  }

  // 9. Orientation.
  if (ORIENTATION.test(text)) {
    const { hour } = localParts(patient.timezone);
    return say(
      pick(state, [
        `It's ${spokenDate(patient.timezone)}, ${name}. It's the ${partOfDay(hour)}, about ${spokenTime(patient.timezone)}.`,
        `Today is ${spokenDate(patient.timezone)}. It's about ${spokenTime(patient.timezone)} in the ${partOfDay(hour)}.`,
      ]),
    );
  }

  // 10. Who is coming?
  if (VISIT.test(text)) {
    const visit = input.schedule.find((s) => /\b(visit|call|coming|lunch|dinner)\b/i.test(s.label));
    return say(
      visit
        ? `${visit.label}, at ${formatHhmm(visit.time_of_day)}. Something to look forward to, ${name}.`
        : `Your family loves you very much, ${name}. I'm not sure who's coming today, but I'm here with you.`,
    );
  }

  // 11. Questions about people and places in the memory book.
  const hit = searchMemory(input.memory, text).find((m) => m.kind === 'person' || m.kind === 'place' || m.kind === 'photo');
  if (hit && !hit.deceased && new RegExp(`\\b${firstName(hit)}\\b`, 'i').test(text)) {
    const photo = photoAction(hit);
    if (photo) {
      fx.actions.push(photo);
      state.shownPhotos.push(hit.id);
    }
    const intro =
      hit.kind === 'person' && hit.relationship
        ? `${hit.title} is your ${hit.relationship.toLowerCase()}.`
        : `That's ${hit.title}.`;
    const q = prompts(hit)[0];
    return say(`${input.repeats > 0 ? pick(state, ['Oh, ', 'Ah, ', '']) : ''}${intro}${photo ? ' Here, let me show you.' : ''}${q ? ` ${q}` : ''}`.trim());
  }

  // 12. Session activities.
  if (state.plan.kind === 'session' && !state.completed) return say(await activityTurn(input, fx, text));
  if (state.plan.kind === 'checkin' && state.step < 2) return say(checkinTurn(input, fx, text));
  if (state.plan.kind === 'voice_note') return say(`It's always so lovely to hear from them, isn't it, ${name}?`);

  // 13. Stories and everything else: listen and reflect.
  state.activityTurns++;
  if (STORY_CUE.test(text) || text.split(/\s+/).length >= 12) {
    return say(
      pick(state, [
        `That sounds really special, ${name}. What happened next?`,
        `Oh, I love hearing that. Who was with you?`,
        `What a wonderful memory. How did that feel?`,
        `I could listen to your stories all day, ${name}. Tell me more?`,
      ]),
    );
  }
  if (state.activityTurns >= 3 && nextPhotoItem(input)) {
    state.offer = 'photo';
    return say(`I'm so glad you're here with me, ${name}. Would you like to look at some photos together?`);
  }
  return say(
    pick(state, [
      `Mm, tell me a little more, ${name}?`,
      `I'm listening. What's on your mind today?`,
      `That's nice. What would you like to talk about?`,
    ]),
  );
}

function formatHhmm(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  const hr = ((h + 11) % 12) + 1;
  return `${hr}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : 'in the evening'}`;
}

async function opener(input: BrainInput, fx: ToolEffects): Promise<string> {
  const { state, patient } = input;
  const name = patient.preferred_name;
  const { hour } = localParts(patient.timezone);
  const greeting = `Good ${partOfDay(hour) === 'night' ? 'evening' : partOfDay(hour)}`;
  const plan = state.plan;
  switch (plan.kind) {
    case 'checkin':
      state.step = 1;
      return `${greeting}, ${name}! It's ${spokenDate(patient.timezone)}. How did you sleep?`;
    case 'reminder': {
      const item = plan.scheduleItem!;
      state.reminderPending = item.id;
      return `${name}, ${reminderLine(item.label)}`;
    }
    case 'voice_note':
      if (plan.voiceNote) fx.actions.push({ type: 'play_voice_note', ...plan.voiceNote });
      return `${name}, ${plan.voiceNote?.from ?? 'your family'} sent you a message. Let's listen.`;
    case 'session':
      if (plan.calming) await runTool('set_mode', { mode: 'calm' }, input, fx);
      return sessionOpen(input, fx, greeting);
    default:
      return `Hello, ${name}! It's so nice to hear from you. How are you feeling?`;
  }
}

async function afterMedia(input: BrainInput, fx: ToolEffects): Promise<string> {
  const { state, patient } = input;
  const name = patient.preferred_name;
  if (state.plan.kind === 'voice_note') {
    return `Wasn't that lovely to hear from ${state.plan.voiceNote?.from ?? 'them'}, ${name}? What would you like to tell them back?`;
  }
  state.step = 2;
  return pick(state, [`That was lovely. Did you used to sing that one, ${name}?`, `Wasn't that nice, ${name}? Does that song bring back any memories?`]);
}

/** "it's time for your morning pills. Have you taken them yet?" */
export function reminderLine(label: string): string {
  const l = lowerFirst(label.trim());
  if (/\b(pills?|meds|medicine|medication|tablets?|vitamins?|insulin|drops|inhaler)\b/i.test(l)) {
    const plural = /\b(pills|meds|tablets|vitamins|drops)\b/i.test(l);
    return `it's time for your ${l.replace(/^(your|my|the)\s+/, '')}. Have you taken ${plural ? 'them' : 'it'} yet?`;
  }
  if (/\b(breakfast|lunch|dinner|supper|meal|snack)\b/i.test(l)) return `it's time for ${l}. Have you had something to eat yet?`;
  if (/\b(water|drink|tea)\b/i.test(l)) return `it's time for ${l}. Have you had a drink yet?`;
  return `it's time for ${l}. Have you done that yet?`;
}

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function sessionOpen(input: BrainInput, fx: ToolEffects, greeting: string): string {
  const { state, patient } = input;
  const name = patient.preferred_name;
  const song = favoriteSong(input);
  switch (state.plan.activity) {
    case 'music':
      if (song) {
        state.offer = 'song';
        return state.plan.calming
          ? `${greeting}, ${name}. Let's slow down together for a little while. Would you like to listen to ${song.title}?`
          : `${greeting}, ${name}! Would you like to listen to ${song.title} with me?`;
      }
      return memoryChatOpen(input, fx);
    case 'word_game':
      return `${greeting}, ${name}! Shall we play a little word game? I'll start an old saying, and you finish it.`;
    case 'movement':
      return `${greeting}, ${name}. Would you like to do some gentle stretching with me? We'll stay sitting down.`;
    case 'today':
      return `${greeting}, ${name}! Would you like me to tell you about today?`;
    default:
      return `${greeting}, ${name}. ${memoryChatOpen(input, fx)}`;
  }
}

function memoryChatOpen(input: BrainInput, fx: ToolEffects): string {
  const { state } = input;
  const item = nextPhotoItem(input);
  state.plan = { ...state.plan, kind: 'session', activity: 'memory_chat' };
  state.step = 1;
  if (!item) return `I'd love to hear one of your stories. Tell me about the house you grew up in?`;
  const photo = photoAction(item);
  if (photo) fx.actions.push(photo);
  state.shownPhotos.push(item.id);
  return `I found a lovely photo. It's ${item.title}. ${prompts(item)[0] ?? 'What do you remember about this?'}`;
}

async function activityTurn(input: BrainInput, fx: ToolEffects, text: string): Promise<string> {
  const { state, patient } = input;
  const name = patient.preferred_name;
  const activity = state.plan.activity;
  state.activityTurns++;

  // Declining at the start of a session is always respected.
  if (state.step === 0 && NO.test(text) && !YES.test(text)) {
    state.declined = true;
    await runTool('end_conversation', {}, input, fx);
    return `That's okay, ${name}. I'm right here whenever you want me.`;
  }

  const close = async (line: string) => {
    state.completed = true;
    await runTool('end_conversation', {}, input, fx);
    return line;
  };

  switch (activity) {
    case 'word_game': {
      if (state.step === 0) {
        state.step = 1;
        return `Here's the first one. ${PROVERBS[0][0]}...`;
      }
      const [start, end] = PROVERBS[state.gameIndex % PROVERBS.length];
      const right = similarity(text, end) >= 0.5 || end.split(' ').some((w) => w.length > 3 && text.toLowerCase().includes(w));
      state.gameIndex++;
      const praise = right
        ? pick(state, [`Yes! ${start} ${end}. Well done, ${name}!`, `That's it! ${start} ${end}. You're good at this.`, `Exactly right!`])
        : pick(state, [`Ooh, I like that! The old saying goes, ${start} ${end}.`, `What a lovely answer. Some people say, ${start} ${end}.`]);
      if (state.gameIndex >= 4) return close(`${praise} That was so much fun, ${name}. Thank you for playing with me.`);
      return `${praise} Here's another. ${PROVERBS[state.gameIndex % PROVERBS.length][0]}...`;
    }
    case 'movement': {
      const i = state.step;
      state.step++;
      if (i >= MOVEMENT_STEPS.length - 1) return close(`${MOVEMENT_STEPS[MOVEMENT_STEPS.length - 1]} Thank you for moving with me, ${name}.`);
      return MOVEMENT_STEPS[i];
    }
    case 'today': {
      if (state.step === 0) {
        state.step = 1;
        const { hour } = localParts(patient.timezone);
        const upcoming = input.schedule
          .filter((s) => s.status === 'upcoming' && s.kind !== 'session')
          .slice(0, 2)
          .map((s) => `${lowerFirst(s.label)} at ${formatHhmm(s.time_of_day)}`);
        return `Today is ${spokenDate(patient.timezone)}. It's the ${partOfDay(hour)}.${
          upcoming.length ? ` Later on there's ${upcoming.join(', and ')}.` : ''
        } How does that sound?`;
      }
      return close(`Lovely. I'm right here if you need anything today, ${name}.`);
    }
    case 'music': {
      if (state.step <= 1) {
        state.step = 2;
        return `Did you used to sing that one, ${name}?`;
      }
      if (state.activityTurns >= 4) return close(`Thank you for listening with me, ${name}. That was lovely.`);
      return pick(state, [`Oh, how lovely. Who did you sing it with?`, `I can tell that song means a lot to you. Where did you first hear it?`]);
    }
    default: {
      // memory_chat
      if (state.step === 0) return memoryChatOpen(input, fx);
      if (state.activityTurns >= 4) return close(`Thank you for sharing that with me, ${name}. I loved hearing about it.`);
      const lastShown = input.memory.find((m) => m.id === state.shownPhotos.at(-1));
      const followups = [...(lastShown ? prompts(lastShown).slice(1) : []), ...MEMORY_FOLLOWUPS];
      return `${pick(state, ['How wonderful.', 'Oh, I love that.', 'That sounds lovely.'])} ${pick(state, followups)}`;
    }
  }
}

function checkinTurn(input: BrainInput, fx: ToolEffects, text: string): string {
  const { state, patient } = input;
  const name = patient.preferred_name;
  state.step = 2;
  fx.end = true;
  if (BAD_FEELING.test(text) && !/\bnot bad\b/i.test(text)) {
    return `I'm sorry to hear that, ${name}. Let's take things nice and slow today. I'm right here if you need me.`;
  }
  if (GOOD_FEELING.test(text)) return `I'm so glad to hear that, ${name}. I hope you have a lovely day. I'm right here if you need me.`;
  return `Thank you for telling me, ${name}. I'm right here if you need anything today.`;
}

export { songAction };
