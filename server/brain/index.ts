// The companion service: one place that runs a conversation turn end to end.
//   utterance → safety net → alerts → brain (Muse Spark, or offline fallback)
//   → reply guard → stored → returned for speech + UI actions.
import { hasMeta } from '../config.ts';
import {
  addMessage,
  conversationMessages,
  getPatient,
  memoryItems,
  observe,
  patientUtterancesToday,
  raiseAlert,
  setScheduleRun,
  startConversation,
  todaysSchedule,
  type Patient,
} from '../domain.ts';
import { db } from '../db.ts';
import { chooseActivity } from '../adapt/bandit.ts';
import { localParts, nowIso } from '../util/time.ts';
import { assessSafety, type SafetyAssessment } from './safety.ts';
import { guardReply } from './guard.ts';
import { repeatCount } from './repetition.ts';
import { museBrain } from './museBrain.ts';
import { offlineBrain } from './offlineBrain.ts';
import type { BrainInput, BrainOutput, ConvState, Mode, SessionPlan, UiAction } from './types.ts';
import { afterConversation } from '../jobs/afterConversation.ts';

export interface TurnReply {
  conversationId: string;
  text: string;
  actions: UiAction[];
  mode: Mode;
  end: boolean;
  source: 'muse' | 'offline';
}

const states = new Map<string, ConvState>();

/** Lets tests force the offline brain even when a key is configured. */
let forceOffline = false;
export function setForceOffline(v: boolean) {
  forceOffline = v;
}

function freshState(plan: SessionPlan): ConvState {
  return {
    plan,
    mode: plan.calming ? 'calm' : 'normal',
    step: 0,
    reminderPending: plan.kind === 'reminder' ? (plan.scheduleItem?.id ?? null) : null,
    shownPhotos: [],
    usedLines: [],
    gameIndex: 0,
    declined: false,
    completed: false,
    offer: null,
    activityTurns: 0,
  };
}

export function conversationState(conversationId: string) {
  return states.get(conversationId);
}

async function think(input: BrainInput): Promise<BrainOutput> {
  if (hasMeta() && !forceOffline) {
    try {
      return await museBrain(input);
    } catch (err) {
      console.warn(`[brain] Muse Spark unavailable, using offline brain: ${(err as Error).message}`);
    }
  }
  return offlineBrain(input);
}

function buildInput(patient: Patient, conversationId: string, state: ConvState, patientText: string | null, extra: Partial<BrainInput> = {}): BrainInput {
  const history = conversationMessages(conversationId).map((m) => ({ role: m.role, text: m.text }));
  // The current utterance is already stored; history is everything before it.
  if (patientText !== null && history.at(-1)?.role === 'patient') history.pop();
  return {
    patient,
    memory: memoryItems(patient.id),
    schedule: todaysSchedule(patient),
    conversationId,
    history,
    patientText,
    safety: null,
    repeats: 0,
    state,
    ...extra,
  };
}

async function finish(input: BrainInput, out: BrainOutput, safety: SafetyAssessment | null): Promise<TurnReply> {
  const guarded = guardReply(out.text, {
    patientText: input.patientText,
    patientName: input.patient.preferred_name,
    memory: input.memory,
    deceasedPerson: safety?.deceasedPerson ?? null,
    medicationQuestion: safety?.medicationQuestion ?? false,
  });
  for (const a of out.actions) if (a.type === 'set_mode') input.state.mode = a.mode;
  addMessage(input.conversationId, 'companion', guarded.text, {
    actions: out.actions.map((a) => a.type),
    source: out.source,
    tools: out.toolLog,
    guard: guarded.violations,
  });
  const reply: TurnReply = {
    conversationId: input.conversationId,
    text: guarded.text,
    actions: out.actions,
    mode: input.state.mode,
    end: out.end,
    source: out.source,
  };
  if (out.end) void endConversation(input.patient.id, input.conversationId, 'goodbye');
  return reply;
}

/** The companion speaks first: a reminder, check-in, session, voice note, or a tap on "Talk". */
export async function openConversation(patientId: string, plan: SessionPlan): Promise<TurnReply> {
  const patient = getPatient(patientId);
  if (!patient) throw new Error('Unknown patient');
  if (plan.kind === 'session' && !plan.activity) {
    const last = db().get<{ activity: string }>(
      "SELECT activity FROM conversations WHERE patient_id = ? AND activity IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      patientId,
    );
    plan = { ...plan, activity: chooseActivity(patientId, { calming: plan.calming, avoid: last?.activity }) };
  }
  const conversationId = startConversation(patientId, { scheduleItemId: plan.scheduleItem?.id ?? null, activity: plan.activity ?? null });
  if (plan.calming) db().run("UPDATE conversations SET mode = 'calm' WHERE id = ?", conversationId);
  const state = freshState(plan);
  states.set(conversationId, state);
  if (plan.scheduleItem) {
    setScheduleRun(plan.scheduleItem.id, localParts(patient.timezone).date, 'invited', { conversationId });
  }
  const input = buildInput(patient, conversationId, state, null);
  const out = await think(input);
  if (plan.kind === 'reminder' && plan.scheduleItem) {
    const { mediaUrl } = await import('../media.ts');
    out.actions.unshift({
      type: 'reminder_card',
      scheduleItemId: plan.scheduleItem.id,
      label: plan.scheduleItem.label,
      url: mediaUrl(plan.scheduleItem.photo_path),
    });
  }
  if (plan.calming && !out.actions.some((a) => a.type === 'set_mode')) out.actions.unshift({ type: 'set_mode', mode: 'calm' });
  return finish(input, out, null);
}

export async function patientTurn(patientId: string, conversationId: string, rawText: string): Promise<TurnReply> {
  const patient = getPatient(patientId);
  if (!patient) throw new Error('Unknown patient');
  const conv = db().get<{ patient_id: string; ended_at: string | null }>('SELECT patient_id, ended_at FROM conversations WHERE id = ?', conversationId);
  if (!conv || conv.patient_id !== patientId) throw new Error('Unknown conversation');
  const text = rawText.trim();

  let state = states.get(conversationId);
  if (!state) {
    // Server restarted mid-conversation: carry on as a plain chat.
    state = freshState({ kind: 'chat' });
    states.set(conversationId, state);
  }

  const earlier = patientUtterancesToday(patient).map((u) => u.text);
  addMessage(conversationId, 'patient', text);

  const memory = memoryItems(patientId);
  const safety = assessSafety(text, patient.preferred_name, memory, patient.companion_name);

  // Alerts are raised here, before any model call, so they never depend on one.
  for (const c of safety.concerns) {
    await raiseAlert({ patientId, conversationId, level: c.level, category: c.category, reason: c.reason, evidence: text });
  }
  if (safety.emergency) state.mode = 'calm';
  if (safety.distress) observe(patientId, 'distress', text, conversationId);
  if (safety.exitSeeking) observe(patientId, 'exit_seeking', text, conversationId);
  if (safety.deceasedPerson) observe(patientId, 'deceased_ask', safety.deceasedPerson.title, conversationId);
  if (safety.joy) observe(patientId, 'joy', text, conversationId);
  const repeats = repeatCount(text, earlier);
  if (repeats > 0) observe(patientId, 'repeat', text, conversationId);

  const input = buildInput(patient, conversationId, state, text, { memory, safety, repeats });
  const out = await think(input);
  return finish(input, out, safety);
}

/** A song or voice note finished playing; the companion follows up. */
export async function mediaEnded(patientId: string, conversationId: string): Promise<TurnReply | null> {
  const patient = getPatient(patientId);
  const state = states.get(conversationId);
  if (!patient || !state) return null;
  const input = buildInput(patient, conversationId, state, null, { event: 'media_ended' });
  const out = await think(input);
  return finish(input, out, null);
}

export type EndReason = 'goodbye' | 'silence' | 'no_response' | 'closed';

const ending = new Set<string>();

export async function endConversation(patientId: string, conversationId: string, reason: EndReason) {
  if (ending.has(conversationId)) return;
  ending.add(conversationId);
  try {
    const conv = db().get<{ patient_id: string; ended_at: string | null }>(
      'SELECT patient_id, ended_at FROM conversations WHERE id = ?',
      conversationId,
    );
    if (!conv || conv.patient_id !== patientId || conv.ended_at) return;
    db().run('UPDATE conversations SET ended_at = ? WHERE id = ?', nowIso(), conversationId);
    const state = states.get(conversationId) ?? freshState({ kind: 'chat' });
    await afterConversation(patientId, conversationId, state, reason);
  } finally {
    states.delete(conversationId);
    ending.delete(conversationId);
  }
}
