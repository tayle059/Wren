// Runs when a conversation ends: learns from it, keeps any stories told, and
// double-checks for anything the family should know.
import { hasMeta } from '../config.ts';
import { db } from '../db.ts';
import { newId } from '../auth.ts';
import { chatJson } from '../meta.ts';
import { conversationMessages, getPatient, raiseAlert, setScheduleRun, type Patient } from '../domain.ts';
import { recordOutcome } from '../adapt/bandit.ts';
import { engagementScore, wordCount } from '../adapt/engagement.ts';
import { localParts, nowIso } from '../util/time.ts';
import { CONCERN_SYSTEM, STORY_SYSTEM } from '../brain/prompts.ts';
import { CONCERN_CATEGORIES } from '../brain/tools.ts';
import type { ConvState } from '../brain/types.ts';
import { toFamily } from '../events.ts';

type Msg = { role: 'patient' | 'companion'; text: string };

export async function afterConversation(patientId: string, conversationId: string, state: ConvState, reason: string) {
  const patient = getPatient(patientId);
  if (!patient) return;
  const messages = conversationMessages(conversationId) as Msg[];
  const patientTexts = messages.filter((m) => m.role === 'patient').map((m) => m.text);
  const { date, hour } = localParts(patient.timezone);
  const plan = state.plan;

  // 1. Schedule bookkeeping.
  if (plan.scheduleItem) {
    const current = db().get<{ status: string }>(
      'SELECT status FROM schedule_runs WHERE schedule_item_id = ? AND date = ?',
      plan.scheduleItem.id,
      date,
    )?.status;
    if (current !== 'confirmed' && current !== 'not_yet') {
      const status = patientTexts.length === 0 ? 'no_response' : state.declined ? 'declined' : 'completed';
      setScheduleRun(plan.scheduleItem.id, date, status);
    }
  }

  // 2. Learn which activities work (only for real sessions that got a response or a "no").
  if (plan.kind === 'session' && plan.activity && (patientTexts.length > 0 || state.declined)) {
    const score = engagementScore({ patientTexts, completed: state.completed, declined: state.declined });
    recordOutcome(patientId, plan.activity, score, hour, conversationId);
  }

  // 3. Keep stories, and 4. double-check for concerns.
  const told = patientTexts.reduce((n, t) => n + wordCount(t), 0);
  if (told >= 12) {
    await keepStories(patient, conversationId, messages).catch((e) => console.warn('[stories]', e.message));
  }
  if (hasMeta() && patientTexts.length > 0) {
    await reviewConcerns(patient, conversationId, messages).catch((e) => console.warn('[concerns]', e.message));
  }

  db().run('UPDATE conversations SET processed = 1 WHERE id = ?', conversationId);
  toFamily(patientId, { type: 'conversation_processed', conversationId, reason });
}

const transcript = (patient: Patient, messages: Msg[]) =>
  messages.map((m) => `${m.role === 'patient' ? patient.preferred_name : patient.companion_name}: ${m.text}`).join('\n');

// ---------- Story keeper ----------

const STORY_CUE = /\b(i remember|when i was|we used to|back then|years ago|used to|growing up|in those days|we had|we lived|my (mother|father|mom|dad|husband|wife|brother|sister))\b/i;

interface StoryOut {
  stories: { title: string; era: string; text: string; quote: string }[];
}

async function keepStories(patient: Patient, conversationId: string, messages: Msg[]) {
  let stories: StoryOut['stories'] = [];
  if (hasMeta()) {
    const out = await chatJson<StoryOut>({
      system: STORY_SYSTEM,
      user: `Person: ${patient.preferred_name} (born ${patient.birth_year ?? 'unknown'}).\n\nTranscript:\n${transcript(patient, messages)}\n\nReturn the stories. "text" is a short third-person retelling (2-4 sentences) for the family's keepsake book. "quote" is the person's most vivid sentence, verbatim. "era" is a decade or life stage if clear, else "".`,
      name: 'stories',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['stories'],
        properties: {
          stories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'era', 'text', 'quote'],
              properties: { title: { type: 'string' }, era: { type: 'string' }, text: { type: 'string' }, quote: { type: 'string' } },
            },
          },
        },
      },
    }).catch(() => ({ stories: [] }));
    stories = out.stories;
  }
  if (!stories.length) stories = heuristicStories(patient, messages);

  for (const s of stories.slice(0, 3)) {
    if (!s.text.trim()) continue;
    const dupe = db().get('SELECT 1 FROM stories WHERE patient_id = ? AND (title = ? OR quote = ?)', patient.id, s.title, s.quote);
    if (dupe) continue;
    const id = newId();
    db().run(
      'INSERT INTO stories (id, patient_id, conversation_id, title, era, text, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      patient.id,
      conversationId,
      s.title.slice(0, 120),
      s.era.slice(0, 40),
      s.text.slice(0, 1200),
      s.quote.slice(0, 400),
      nowIso(),
    );
    toFamily(patient.id, { type: 'story', story: { id, title: s.title } });
  }
}

export function heuristicStories(patient: Patient, messages: Msg[]): StoryOut['stories'] {
  const told = messages.filter((m) => m.role === 'patient' && (STORY_CUE.test(m.text) || wordCount(m.text) >= 15));
  if (!told.length) return [];
  const all = told.map((m) => m.text.trim()).join(' ');
  const sentences = all.match(/[^.!?]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [all];
  const quote = sentences.reduce((a, b) => (wordCount(b) > wordCount(a) ? b : a), sentences[0]);
  const era = all.match(/\b(19[2-9]0s|19[2-9]\d|20[0-2]\d|the (twenties|thirties|forties|fifties|sixties|seventies|eighties))\b/i)?.[0] ?? '';
  let subject = quote;
  const CUE = /^(i remember|when i was|we used to|i used to|back then|oh|well|and|so|yes|you know)[,\s]+/i;
  while (CUE.test(subject)) subject = subject.replace(CUE, '');
  const words = subject.replace(/[.!?]+$/, '').split(/\s+/);
  subject = words.slice(0, 8).join(' ').replace(/[,;:]$/, '') + (words.length > 8 ? '…' : '');
  return [
    {
      title: subject.charAt(0).toUpperCase() + subject.slice(1),
      era,
      text: `${patient.preferred_name} shared: "${all.slice(0, 600)}"`,
      quote,
    },
  ];
}

// ---------- Concern review ----------

interface ConcernOut {
  concerns: { level: 'urgent' | 'fyi'; category: string; reason: string; evidence: string }[];
}

async function reviewConcerns(patient: Patient, conversationId: string, messages: Msg[]) {
  const existing = db().all<{ category: string; reason: string }>(
    'SELECT category, reason FROM alerts WHERE conversation_id = ?',
    conversationId,
  );
  const out = await chatJson<ConcernOut>({
    system: CONCERN_SYSTEM,
    user: `Person: ${patient.preferred_name}.\nAlready raised: ${JSON.stringify(existing)}\n\nTranscript:\n${transcript(patient, messages)}`,
    name: 'concerns',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['concerns'],
      properties: {
        concerns: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['level', 'category', 'reason', 'evidence'],
            properties: {
              level: { type: 'string', enum: ['urgent', 'fyi'] },
              category: { type: 'string', enum: [...CONCERN_CATEGORIES] },
              reason: { type: 'string' },
              evidence: { type: 'string' },
            },
          },
        },
      },
    },
  });
  for (const c of out.concerns.slice(0, 3)) {
    if (existing.some((e) => e.category === c.category)) continue;
    await raiseAlert({ patientId: patient.id, conversationId, level: c.level, category: c.category, reason: c.reason, evidence: c.evidence });
  }
}
