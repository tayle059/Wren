import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { subscribe, type KEvent } from '../events.ts';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function bearer(c: Context): string | undefined {
  const h = c.req.header('Authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return c.req.query('token') ?? undefined; // EventSource can't set headers
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
