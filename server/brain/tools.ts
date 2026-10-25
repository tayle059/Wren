// Tools the companion can use, shared by the Muse Spark brain (as function
// calls) and the offline brain (called directly).
import type { ToolDef } from '../meta.ts';
import { raiseAlert, setScheduleRun, type MemoryItem } from '../domain.ts';
import { mediaUrl } from '../media.ts';
import { localParts } from '../util/time.ts';
import type { BrainInput, UiAction } from './types.ts';
import { keyTokens } from './repetition.ts';

export const CONCERN_CATEGORIES = [
  'fall',
  'medical',
  'safety',
  'help',
  'self_harm',
  'pain',
  'medication',
  'medication_question',
  'exit_seeking',
  'asked_for_deceased',
  'distress',
  'loneliness',
  'confusion',
  'other',
] as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'look_up_memory',
      description:
        "Search the family's memory book for people, places, stories and songs. Use before stating any fact about family or the past.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A name, place or topic, e.g. "Leo" or "the farm".' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_photo',
      description: 'Show a photo from the memory book on the screen. Great for memory chats and when asked who someone is.',
      parameters: {
        type: 'object',
        properties: { memory_id: { type: 'string' } },
        required: ['memory_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_song',
      description: 'Play a favorite song the family uploaded. Especially helpful for calming.',
      parameters: {
        type: 'object',
        properties: { memory_id: { type: 'string' } },
        required: ['memory_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_reminder',
      description: 'Record the answer to a reminder, e.g. that a pill was taken.',
      parameters: {
        type: 'object',
        properties: {
          schedule_item_id: { type: 'string' },
          status: { type: 'string', enum: ['confirmed', 'not_yet'] },
        },
        required: ['schedule_item_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'raise_concern',
      description:
        'Tell the family about something they should know. urgent = possible fall, injury, medical emergency, danger, or wanting to die. fyi = things like asking for someone who has passed away, wanting to leave the house, loneliness, medication questions, unusual confusion.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['urgent', 'fyi'] },
          category: { type: 'string', enum: [...CONCERN_CATEGORIES] },
          reason: { type: 'string', description: 'One plain sentence for the family.' },
        },
        required: ['level', 'category', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_mode',
      description: 'Switch to calm mode (slower, softer, amber light) when the person seems anxious, or back to normal.',
      parameters: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['normal', 'calm'] } },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_conversation',
      description: 'Call after saying goodbye, or when the person clearly wants to stop.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export interface ToolEffects {
  actions: UiAction[];
  end: boolean;
  log: string[];
}

export function searchMemory(memory: MemoryItem[], query: string): MemoryItem[] {
  const q = keyTokens(query);
  if (q.size === 0) return [];
  return memory
    .map((m) => {
      const hay = keyTokens(`${m.title} ${m.relationship} ${m.body} ${m.ai_description}`);
      const title = keyTokens(`${m.title} ${m.relationship}`);
      let score = 0;
      for (const t of q) {
        if (title.has(t)) score += 3;
        else if (hay.has(t)) score += 1;
      }
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.m);
}

export function describeForModel(m: MemoryItem) {
  return {
    id: m.id,
    kind: m.kind,
    title: m.title,
    relationship: m.relationship || undefined,
    has_passed_away: m.deceased ? true : undefined,
    notes: m.body || undefined,
    photo_shows: m.ai_description || undefined,
    has_photo: !!m.photo_path || undefined,
    has_audio: !!m.audio_path || undefined,
    learned_from_conversation: m.source === 'patient' || undefined,
  };
}

export function photoAction(m: MemoryItem): UiAction | null {
  const url = mediaUrl(m.photo_path);
  if (!url) return null;
  return { type: 'show_photo', id: m.id, title: m.title, caption: m.relationship ? `${m.title} · ${m.relationship}` : m.title, url };
}

export function songAction(m: MemoryItem): UiAction | null {
  const url = mediaUrl(m.audio_path);
  if (!url) return null;
  return { type: 'play_song', id: m.id, title: m.title, url };
}

/** Executes one tool call. Returns the JSON-able result handed back to the model. */
export async function runTool(name: string, args: Record<string, unknown>, input: BrainInput, fx: ToolEffects): Promise<unknown> {
  const { patient, memory, state } = input;
  fx.log.push(`${name}(${JSON.stringify(args)})`);
  switch (name) {
    case 'look_up_memory': {
      const hits = searchMemory(memory, String(args.query ?? ''));
      return hits.length ? hits.map(describeForModel) : { found: false, note: 'Nothing in the memory book. Do not guess.' };
    }
    case 'show_photo': {
      const m = memory.find((x) => x.id === args.memory_id);
      const action = m && photoAction(m);
      if (!action) return { ok: false, error: 'No photo for that memory id.' };
      fx.actions.push(action);
      state.shownPhotos.push(m!.id);
      return { ok: true, showing: m!.title };
    }
    case 'play_song': {
      const m = memory.find((x) => x.id === args.memory_id);
      const action = m && songAction(m);
      if (!action) return { ok: false, error: 'No audio for that memory id.' };
      fx.actions.push(action);
      return { ok: true, playing: m!.title, note: 'The song plays after you finish speaking. Keep your words short.' };
    }
    case 'confirm_reminder': {
      const id = String(args.schedule_item_id ?? state.reminderPending ?? '');
      const status = args.status === 'confirmed' ? 'confirmed' : 'not_yet';
      if (!input.schedule.some((s) => s.id === id)) return { ok: false, error: 'Unknown schedule item.' };
      setScheduleRun(id, localParts(patient.timezone).date, status, { conversationId: input.conversationId });
      if (state.reminderPending === id) state.reminderPending = null;
      return { ok: true, recorded: status };
    }
    case 'raise_concern': {
      const level = args.level === 'urgent' ? 'urgent' : 'fyi';
      const category = (CONCERN_CATEGORIES as readonly string[]).includes(String(args.category)) ? String(args.category) : 'other';
      await raiseAlert({
        patientId: patient.id,
        conversationId: input.conversationId,
        level,
        category,
        reason: String(args.reason ?? 'The companion noticed something worth checking.'),
        evidence: input.patientText ?? '',
      });
      return { ok: true, family_notified: true };
    }
    case 'set_mode': {
      state.mode = args.mode === 'calm' ? 'calm' : 'normal';
      fx.actions.push({ type: 'set_mode', mode: state.mode });
      return { ok: true };
    }
    case 'end_conversation': {
      fx.end = true;
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}
