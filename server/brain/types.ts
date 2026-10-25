import type { MemoryItem, Patient, ScheduleItem } from '../domain.ts';
import type { SafetyAssessment } from './safety.ts';
import type { Activity } from '../adapt/bandit.ts';

export type Mode = 'normal' | 'calm';

export type UiAction =
  | { type: 'show_photo'; id: string; title: string; caption: string; url: string }
  | { type: 'play_song'; id: string; title: string; url: string }
  | { type: 'reminder_card'; scheduleItemId: string; label: string; url: string | null }
  | { type: 'play_voice_note'; id: string; from: string; url: string }
  | { type: 'set_mode'; mode: Mode };

export type PlanKind = 'chat' | 'checkin' | 'reminder' | 'session' | 'voice_note';

export interface SessionPlan {
  kind: PlanKind;
  activity?: Activity;
  calming?: boolean;
  scheduleItem?: ScheduleItem | null;
  voiceNote?: { id: string; from: string; url: string } | null;
}

/** Per-conversation working memory, used mostly by the offline brain. */
export interface ConvState {
  plan: SessionPlan;
  mode: Mode;
  step: number;
  reminderPending: string | null; // schedule item id awaiting yes/no
  shownPhotos: string[];
  usedLines: string[];
  gameIndex: number;
  declined: boolean;
  completed: boolean;
  offer: 'song' | 'photo' | null;
  activityTurns: number;
}

export interface TodayItem extends ScheduleItem {
  status: string;
}

export interface BrainInput {
  patient: Patient;
  memory: MemoryItem[];
  schedule: TodayItem[];
  conversationId: string;
  history: { role: 'patient' | 'companion'; text: string }[];
  patientText: string | null; // null when the companion is opening or reacting to an event
  event?: 'media_ended' | null; // a song or voice message just finished
  safety: SafetyAssessment | null;
  repeats: number;
  state: ConvState;
}

export interface BrainOutput {
  text: string;
  actions: UiAction[];
  end: boolean;
  toolLog: string[];
  source: 'muse' | 'offline';
}
