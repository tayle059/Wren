import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preferred_name TEXT NOT NULL,
  pronouns TEXT NOT NULL DEFAULT 'they/them',
  companion_name TEXT NOT NULL DEFAULT 'Wren',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  birth_year INTEGER,
  about_text TEXT NOT NULL DEFAULT '',
  what_works_text TEXT NOT NULL DEFAULT '',
  visit_prep_json TEXT NOT NULL DEFAULT '[]',
  speech_patience_ms INTEGER NOT NULL DEFAULT 1600,
  exit_pin_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, patient_id)
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  offline_alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- person | place | story | song | photo
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL DEFAULT '',
  deceased INTEGER NOT NULL DEFAULT 0,
  photo_path TEXT,
  audio_path TEXT,
  ai_description TEXT NOT NULL DEFAULT '',
  prompts_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'family', -- family | patient (learned from conversation)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_items (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- checkin | reminder | session
  label TEXT NOT NULL,
  time_of_day TEXT NOT NULL,      -- HH:MM in the patient's timezone
  days TEXT NOT NULL DEFAULT '*', -- '*' or comma list of mon..sun
  photo_path TEXT,
  calming INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_item_id TEXT NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL,           -- invited | started | completed | declined | skipped | confirmed | not_yet | missed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  conversation_id TEXT,
  UNIQUE (schedule_item_id, date)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  schedule_item_id TEXT,
  activity TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mode TEXT NOT NULL DEFAULT 'normal',
  processed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,             -- patient | companion
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id TEXT,
  kind TEXT NOT NULL,             -- distress | repeat | exit_seeking | deceased_ask | confusion | joy
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id TEXT,
  level TEXT NOT NULL,            -- urgent | fyi
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  ack_by TEXT,
  ack_at TEXT
);
CREATE TABLE IF NOT EXISTS daily_summaries (
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  mood TEXT NOT NULL,
  summary TEXT NOT NULL,
  highlights_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (patient_id, date)
);
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id TEXT,
  title TEXT NOT NULL,
  era TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity_stats (
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  alpha REAL NOT NULL,
  beta REAL NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (patient_id, activity)
);
CREATE TABLE IF NOT EXISTS activity_outcomes (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id TEXT,
  activity TEXT NOT NULL,
  hour INTEGER NOT NULL,
  score REAL NOT NULL,            -- 0..1 engagement
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signals_daily (
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  turns INTEGER NOT NULL,
  words_per_turn REAL NOT NULL,
  unique_ratio REAL NOT NULL,
  repeats INTEGER NOT NULL,
  engaged_minutes REAL NOT NULL,
  sessions_offered INTEGER NOT NULL,
  sessions_accepted INTEGER NOT NULL,
  distress_events INTEGER NOT NULL,
  PRIMARY KEY (patient_id, date)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- move_session
  text TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_notes (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  from_name TEXT NOT NULL,
  audio_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  played_at TEXT
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_patient ON conversations(patient_id, started_at);
CREATE INDEX IF NOT EXISTS idx_alerts_patient ON alerts(patient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_obs_patient ON observations(patient_id, at);
`;

type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.raw.exec(SCHEMA);
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}

let instance: Db | null = null;

export function openDb(file?: string): Db {
  if (file) return new Db(file);
  if (!instance) {
    mkdirSync(config.dataDir, { recursive: true });
    instance = new Db(join(config.dataDir, 'kindred.db'));
  }
  return instance;
}

// Allows tests to inject an in-memory database.
export function setDb(db: Db) {
  instance = db;
}

export function db(): Db {
  return instance ?? openDb();
}
