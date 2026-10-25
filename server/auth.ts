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

export const sha256Hex = sha256;

/** Social-only accounts have no password; their hash is empty and never verifies. */
export function createUser(email: string, name: string, password: string | null): User {
  const id = newId();
  db().run(
    'INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    email.trim().toLowerCase(),
    name.trim(),
    password ? hashSecret(password) : '',
    nowIso(),
  );
  return { id, email: email.trim().toLowerCase(), name: name.trim() };
}

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

export type LoginResult =
  | { ok: true; user: User; twoStep: boolean }
  | { ok: false; reason: 'invalid' | 'locked'; until?: string; userId?: string };

/**
 * Checks a password with account lockout: five wrong passwords lock the
 * account for 15 minutes. The answer never reveals whether the email exists.
 */
export function checkLogin(email: string, password: string): LoginResult {
  const row = db().get<User & { password_hash: string; failed_logins: number; locked_until: string | null; totp_enabled: number }>(
    'SELECT id, email, name, password_hash, failed_logins, locked_until, totp_enabled FROM users WHERE email = ?',
    email.trim().toLowerCase(),
  );
  if (!row) {
    // Spend the same time as a real check so timing doesn't reveal accounts.
    verifySecret(password, DUMMY_HASH);
    return { ok: false, reason: 'invalid' };
  }
  if (row.locked_until && row.locked_until > nowIso()) return { ok: false, reason: 'locked', until: row.locked_until, userId: row.id };
  if (!verifySecret(password, row.password_hash)) {
    const failed = row.failed_logins + 1;
    const lock = failed >= LOCK_AFTER ? new Date(now().getTime() + LOCK_MS).toISOString() : null;
    db().run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : failed, lock, row.id);
    return lock ? { ok: false, reason: 'locked', until: lock, userId: row.id } : { ok: false, reason: 'invalid', userId: row.id };
  }
  db().run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', row.id);
  return { ok: true, user: { id: row.id, email: row.email, name: row.name }, twoStep: !!row.totp_enabled };
}

const DUMMY_HASH = hashSecret('not-a-real-password');

export function setPassword(userId: string, password: string) {
  db().run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hashSecret(password), userId);
}

export function hasPassword(userId: string): boolean {
  return !!db().get<{ h: string }>("SELECT 1 AS h FROM users WHERE id = ? AND password_hash != ''", userId);
}

export function verifyUserPassword(userId: string, password: string): boolean {
  const row = db().get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', userId);
  return !!row && verifySecret(password, row.password_hash);
}

// ---------- Sessions ----------

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86400_000;

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
  method?: string;
}

export function createSession(userId: string, meta: SessionMeta = {}): string {
  const token = randomBytes(32).toString('base64url');
  const t = now().getTime();
  db().run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent, ip, method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    userId,
    new Date(t).toISOString(),
    new Date(t + SESSION_MS).toISOString(),
    new Date(t).toISOString(),
    (meta.userAgent ?? '').slice(0, 300),
    (meta.ip ?? '').slice(0, 64),
    meta.method ?? 'password',
  );
  return token;
}

/** Looks up a session, expiring old ones and sliding active ones forward. */
export function userForToken(token: string | undefined): (User & { sessionHash: string }) | null {
  if (!token) return null;
  const hash = sha256(token);
  const row = db().get<User & { expires_at: string | null; last_used_at: string | null }>(
    'SELECT u.id, u.email, u.name, s.expires_at, s.last_used_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    hash,
  );
  if (!row) return null;
  const t = now().getTime();
  if (row.expires_at && Date.parse(row.expires_at) < t) {
    db().run('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  // Touch at most once a minute; extend when more than half the lifetime has passed.
  if (!row.last_used_at || t - Date.parse(row.last_used_at) > 60_000) {
    const extend = !row.expires_at || Date.parse(row.expires_at) - t < SESSION_MS / 2;
    db().run(
      'UPDATE sessions SET last_used_at = ?, expires_at = COALESCE(?, expires_at) WHERE token_hash = ?',
      new Date(t).toISOString(),
      extend ? new Date(t + SESSION_MS).toISOString() : null,
      hash,
    );
  }
  return { id: row.id, email: row.email, name: row.name, sessionHash: hash };
}

export function endSession(token: string) {
  db().run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

// ---------- Two-step sign-in challenges ----------

const CHALLENGE_MS = 10 * 60 * 1000;

export function createChallenge(userId: string, method: string): string {
  const token = randomBytes(32).toString('base64url');
  db().run('DELETE FROM mfa_challenges WHERE expires_at < ?', nowIso());
  db().run(
    'INSERT INTO mfa_challenges (token_hash, user_id, method, expires_at) VALUES (?, ?, ?, ?)',
    sha256(token),
    userId,
    method,
    new Date(now().getTime() + CHALLENGE_MS).toISOString(),
  );
  return token;
}

/** Five tries per challenge; then the person starts over. */
export function readChallenge(token: string): { userId: string; method: string; hash: string } | null {
  const hash = sha256(token ?? '');
  const row = db().get<{ user_id: string; method: string; attempts: number; expires_at: string }>(
    'SELECT user_id, method, attempts, expires_at FROM mfa_challenges WHERE token_hash = ?',
    hash,
  );
  if (!row || row.expires_at < nowIso() || row.attempts >= 5) return null;
  db().run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', hash);
  return { userId: row.user_id, method: row.method, hash };
}

export function consumeChallenge(hash: string) {
  db().run('DELETE FROM mfa_challenges WHERE token_hash = ?', hash);
}

/** Every family request is scoped through this check. */
export function canAccessPatient(userId: string, patientId: string): boolean {
  return !!db().get('SELECT 1 FROM memberships WHERE user_id = ? AND patient_id = ?', userId, patientId);
}

// ---------- Companion devices ----------

const PAIRING_TTL_MS = 15 * 60 * 1000;

export function createPairingCode(patientId: string, createdBy: string | null = null): { code: string; expiresAt: string } {
  db().run('DELETE FROM pairing_codes WHERE patient_id = ? OR expires_at < ?', patientId, nowIso());
  let code = '';
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (db().get('SELECT 1 FROM pairing_codes WHERE code = ?', code));
  const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS).toISOString();
  db().run('INSERT INTO pairing_codes (code, patient_id, expires_at, created_by) VALUES (?, ?, ?, ?)', code, patientId, expiresAt, createdBy);
  return { code, expiresAt };
}

/** Exchanges a pairing code for a long-lived device token. Codes are single use. */
export function redeemPairingCode(
  code: string,
  name = 'Tablet',
): { deviceId: string; token: string; patientId: string; createdBy: string | null } | null {
  const clean = code.replace(/\D/g, '');
  const row = db().get<{ patient_id: string; expires_at: string; created_by: string | null }>(
    'SELECT patient_id, expires_at, created_by FROM pairing_codes WHERE code = ?',
    clean,
  );
  if (!row) return null;
  db().run('DELETE FROM pairing_codes WHERE code = ?', clean);
  if (row.expires_at < nowIso()) return null;
  const deviceId = newId();
  const token = randomBytes(32).toString('base64url');
  db().run(
    'INSERT INTO devices (id, patient_id, token_hash, created_at, last_seen_at, name) VALUES (?, ?, ?, ?, ?, ?)',
    deviceId,
    row.patient_id,
    sha256(token),
    nowIso(),
    nowIso(),
    name.slice(0, 60),
  );
  return { deviceId, token, patientId: row.patient_id, createdBy: row.created_by };
}

export interface Device {
  id: string;
  patient_id: string;
}

export function deviceForToken(token: string | undefined): Device | null {
  if (!token) return null;
  return db().get<Device>('SELECT id, patient_id FROM devices WHERE token_hash = ?', sha256(token)) ?? null;
}
