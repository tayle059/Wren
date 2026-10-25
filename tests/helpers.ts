import { openDb, setDb, db } from '../server/db.ts';
import { seedDemo } from '../server/seed.ts';
import { setForceOffline } from '../server/brain/index.ts';
import { config } from '../server/config.ts';
import { setClock } from '../server/util/time.ts';

/** A fresh in-memory database with Rose's world. Always uses the offline brain unless told otherwise. */
export async function freshWorld(opts: { history?: boolean } = {}) {
  setDb(openDb(':memory:'));
  config.meta.apiKey = '';
  setClock(() => new Date());
  setForceOffline(true);
  return seedDemo({ history: opts.history ?? false });
}

export function alerts(patientId: string) {
  return db().all<{ level: string; category: string; reason: string }>(
    'SELECT level, category, reason FROM alerts WHERE patient_id = ? ORDER BY created_at',
    patientId,
  );
}

export const DEATH_WORDS = /\b(died|dead|passed away|passed on|no longer with us|funeral|buried|death)\b/i;
