// Private media (photos, songs, voice notes) served through short-lived signed
// URLs, so a photo link can't be reused by anyone outside the family.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { db } from './db.ts';
import { config } from './config.ts';
import { newId } from './auth.ts';
import { now } from './util/time.ts';

const URL_TTL_MS = 6 * 3600 * 1000;

function secret(): Buffer {
  let row = db().get<{ value: string }>("SELECT value FROM kv WHERE key = 'media_secret'");
  if (!row) {
    const value = randomBytes(32).toString('base64');
    db().run("INSERT INTO kv (key, value) VALUES ('media_secret', ?)", value);
    row = { value };
  }
  return Buffer.from(row.value, 'base64');
}

const sign = (path: string, exp: number) => createHmac('sha256', secret()).update(`${path}:${exp}`).digest('base64url');

export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:|^\//.test(path)) return path; // bundled demo art
  const exp = now().getTime() + URL_TTL_MS;
  return `/media/${path}?exp=${exp}&sig=${sign(path, exp)}`;
}

export function verifyMedia(path: string, exp: string | undefined, sig: string | undefined): boolean {
  if (!exp || !sig || Number(exp) < now().getTime()) return false;
  const expected = Buffer.from(sign(path, Number(exp)));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const mediaRoot = () => join(config.dataDir, 'media');

/** Resolves a stored relative path safely inside the media root. */
export function mediaFile(path: string): string | null {
  const full = normalize(join(mediaRoot(), path));
  return full.startsWith(mediaRoot()) ? full : null;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
};

export function saveMedia(patientId: string, bytes: Uint8Array, contentType: string, originalName = ''): string {
  const type = contentType.split(';')[0].trim();
  const ext = EXT_BY_TYPE[type] ?? (extname(originalName).toLowerCase() || '.bin');
  const dir = join(mediaRoot(), patientId);
  mkdirSync(dir, { recursive: true });
  const rel = `${patientId}/${newId()}${ext}`;
  writeFileSync(join(mediaRoot(), rel), bytes);
  return rel;
}

export const CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_TYPE).map(([type, ext]) => [ext, type]),
);
