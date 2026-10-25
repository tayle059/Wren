import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.ts';
import { nowIso, now } from './util/time.ts';

export const newId = () => randomUUID();

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(secret, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

// ---------- Family accounts ----------

export interface User {
  id: string;
  email: string;
  name: string;
}

export function createUser(email: string, name: string, password: string): User {
  const id = newId();
  db().run(
    'INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    email.trim().toLowerCase(),
    name.trim(),
    hashSecret(password),
    nowIso(),
  );
  return { id, email: email.trim().toLowerCase(), name: name.trim() };
}

export function checkLogin(email: string, password: string): User | null {
  const row = db().get<User & { password_hash: string }>(
    'SELECT id, email, name, password_hash FROM users WHERE email = ?',
    email.trim().toLowerCase(),
  );
  if (!row || !verifySecret(password, row.password_hash)) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export function createSession(userId: string): string {
  const token = randomBytes(32).toString('base64url');
  db().run('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)', sha256(token), userId, nowIso());
  return token;
}

export function userForToken(token: string | undefined): User | null {
  if (!token) return null;
  return (
    db().get<User>(
      'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      sha256(token),
    ) ?? null
  );
}

export function endSession(token: string) {
  db().run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

/** Every family request is scoped through this check. */
export function canAccessPatient(userId: string, patientId: string): boolean {
  return !!db().get('SELECT 1 FROM memberships WHERE user_id = ? AND patient_id = ?', userId, patientId);
}

// ---------- Companion devices ----------

const PAIRING_TTL_MS = 15 * 60 * 1000;

export function createPairingCode(patientId: string): { code: string; expiresAt: string } {
  db().run('DELETE FROM pairing_codes WHERE patient_id = ? OR expires_at < ?', patientId, nowIso());
  let code = '';
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (db().get('SELECT 1 FROM pairing_codes WHERE code = ?', code));
  const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS).toISOString();
  db().run('INSERT INTO pairing_codes (code, patient_id, expires_at) VALUES (?, ?, ?)', code, patientId, expiresAt);
  return { code, expiresAt };
}

/** Exchanges a pairing code for a long-lived device token. Codes are single use. */
export function redeemPairingCode(code: string): { deviceId: string; token: string; patientId: string } | null {
  const row = db().get<{ patient_id: string; expires_at: string }>(
    'SELECT patient_id, expires_at FROM pairing_codes WHERE code = ?',
    code.replace(/\D/g, ''),
  );
  if (!row) return null;
  db().run('DELETE FROM pairing_codes WHERE code = ?', code.replace(/\D/g, ''));
  if (row.expires_at < nowIso()) return null;
  const deviceId = newId();
  const token = randomBytes(32).toString('base64url');
  db().run(
    'INSERT INTO devices (id, patient_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    deviceId,
    row.patient_id,
    sha256(token),
    nowIso(),
    nowIso(),
  );
  return { deviceId, token, patientId: row.patient_id };
}

export interface Device {
  id: string;
  patient_id: string;
}

export function deviceForToken(token: string | undefined): Device | null {
  if (!token) return null;
  return db().get<Device>('SELECT id, patient_id FROM devices WHERE token_hash = ?', sha256(token)) ?? null;
}
