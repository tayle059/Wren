// A per-account log of security-relevant events, shown in Settings → Security.
import { randomUUID } from 'node:crypto';
import { db } from '../db.ts';
import { nowIso } from '../util/time.ts';

export type SecurityEvent =
  | 'account_created'
  | 'sign_in'
  | 'sign_in_failed'
  | 'account_locked'
  | 'two_step_enabled'
  | 'two_step_disabled'
  | 'recovery_code_used'
  | 'password_changed'
  | 'identity_linked'
  | 'identity_unlinked'
  | 'session_revoked'
  | 'tablet_connected'
  | 'tablet_removed'
  | 'invite_created'
  | 'member_joined'
  | 'member_removed';

export interface RequestMeta {
  ip: string;
  userAgent: string;
}

export function audit(userId: string, kind: SecurityEvent, detail = '', meta: Partial<RequestMeta> = {}) {
  db().run(
    'INSERT INTO security_events (id, user_id, kind, detail, ip, user_agent, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(),
    userId,
    kind,
    detail.slice(0, 300),
    (meta.ip ?? '').slice(0, 64),
    (meta.userAgent ?? '').slice(0, 300),
    nowIso(),
  );
}

export function recentEvents(userId: string, limit = 30) {
  return db().all<{ kind: string; detail: string; ip: string; user_agent: string; at: string }>(
    'SELECT kind, detail, ip, user_agent, at FROM security_events WHERE user_id = ? ORDER BY at DESC LIMIT ?',
    userId,
    limit,
  );
}

/** "Chrome on Mac", "Safari on iPad". Good enough for people to recognize their devices. */
export function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /FBAN|FBAV/.test(ua)
      ? 'Facebook app'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? 'Android phone'
          : 'Android tablet'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'device';
  return `${browser} on ${os}`;
}
