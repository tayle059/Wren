import webpush from 'web-push';
import { db } from './db.ts';
import { config } from './config.ts';

let configured = false;

export function vapidPublicKey(): string {
  ensureVapid();
  return db().get<{ value: string }>("SELECT value FROM kv WHERE key = 'vapid_public'")!.value;
}

function ensureVapid() {
  if (configured) return;
  let pub = db().get<{ value: string }>("SELECT value FROM kv WHERE key = 'vapid_public'")?.value;
  let priv = db().get<{ value: string }>("SELECT value FROM kv WHERE key = 'vapid_private'")?.value;
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    db().run("INSERT OR REPLACE INTO kv (key, value) VALUES ('vapid_public', ?)", pub);
    db().run("INSERT OR REPLACE INTO kv (key, value) VALUES ('vapid_private', ?)", priv);
  }
  webpush.setVapidDetails(`mailto:hello@kindred.local`, pub, priv);
  configured = true;
}

export function saveSubscription(userId: string, sub: { endpoint: string }) {
  db().run(
    'INSERT OR REPLACE INTO push_subs (endpoint, user_id, json) VALUES (?, ?, ?)',
    sub.endpoint,
    userId,
    JSON.stringify(sub),
  );
}

export interface PushPayload {
  title: string;
  body: string;
  level: 'urgent' | 'fyi';
  url?: string;
  tag?: string;
}

/** Sends to every subscribed family member of a patient. Never throws. */
export async function pushToFamily(patientId: string, payload: PushPayload): Promise<number> {
  ensureVapid();
  const subs = db().all<{ endpoint: string; json: string }>(
    `SELECT p.endpoint, p.json FROM push_subs p
     JOIN memberships m ON m.user_id = p.user_id WHERE m.patient_id = ?`,
    patientId,
  );
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          JSON.parse(s.json),
          JSON.stringify({ ...payload, url: payload.url ?? `${config.publicUrl}/#/family` }),
          { urgency: payload.level === 'urgent' ? 'high' : 'normal', TTL: 3600 },
        );
        sent++;
      } catch (err: unknown) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) db().run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
      }
    }),
  );
  return sent;
}
