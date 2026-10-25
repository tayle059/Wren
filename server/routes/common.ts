import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { subscribe, type KEvent } from '../events.ts';
import { SESSION_DAYS } from '../auth.ts';
import type { RequestMeta } from '../security/audit.ts';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Device tokens: an Authorization header, or ?token= for EventSource, which can't set headers. */
export function bearer(c: Context): string | undefined {
  const h = c.req.header('Authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return c.req.query('token') ?? undefined;
}

// ---------- Family sessions live in an HttpOnly cookie ----------
// Scripts on the page can't read it (so a script injection can't steal it), and
// SameSite=Lax keeps other sites from making requests with it.

export const SESSION_COOKIE = 'kindred_session';

export const isHttps = (c: Context) =>
  c.req.url.startsWith('https:') || c.req.header('x-forwarded-proto') === 'https';

export function sessionToken(c: Context): string | undefined {
  const h = c.req.header('Authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7); // API clients and tests
  return getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
}

export function requestMeta(c: Context): RequestMeta {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return { ip: forwarded || incoming?.socket?.remoteAddress || 'local', userAgent: c.req.header('user-agent') ?? '' };
}

export function sse(c: Context, channel: string, hello: KEvent) {
  return streamSSE(c, async (stream) => {
    const queue: KEvent[] = [hello];
    let wake: (() => void) | null = null;
    const unsubscribe = subscribe(channel, (e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });
    let lastPing = Date.now();
    while (!stream.aborted) {
      while (queue.length) {
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
      if (Date.now() - lastPing > 20000) {
        await stream.writeSSE({ event: 'ping', data: '{}' });
        lastPing = Date.now();
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 20000);
      });
      wake = null;
    }
    unsubscribe();
  });
}

export type Body = Record<string, string | File | (string | File)[]>;

export async function fileField(body: Body, field: string): Promise<{ bytes: Uint8Array; type: string; name: string } | null> {
  const f = body[field];
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File is too large (15 MB max).');
  return { bytes: new Uint8Array(await f.arrayBuffer()), type: f.type || 'application/octet-stream', name: f.name };
}

export const textField = (body: Body, field: string) => (typeof body[field] === 'string' ? (body[field] as string) : '');

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
