import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { familyRoutes } from './routes/family.ts';
import { deviceRoutes } from './routes/device.ts';
import { HttpError } from './routes/common.ts';
import { CONTENT_TYPES, mediaFile, verifyMedia } from './media.ts';
import { config, hasMeta } from './config.ts';
import { queueFakeTranscript, sttMode } from './stt.ts';

export function buildApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error('[api]', err);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  });

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/api/config', (c) => c.json({ brain: hasMeta() ? 'muse' : 'offline', stt: sttMode() }));
  // End-to-end tests script what the fake ear "hears".
  if (config.sttMode === 'fake') {
    app.post('/api/test/stt-queue', async (c) => {
      const { texts } = await c.req.json<{ texts: string[] }>();
      queueFakeTranscript(...texts);
      return c.json({ ok: true });
    });
  }
  app.route('/api/device', deviceRoutes);
  app.route('/api', familyRoutes);

  // Signed, private media.
  app.get('/media/*', (c) => {
    const path = decodeURIComponent(c.req.path.slice('/media/'.length));
    if (!verifyMedia(path, c.req.query('exp'), c.req.query('sig'))) return c.text('Link expired', 403);
    const file = mediaFile(path);
    if (!file || !existsSync(file)) return c.text('Not found', 404);
    const size = statSync(file).size;
    const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    const range = c.req.header('Range')?.match(/bytes=(\d*)-(\d*)/);
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    };
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = String(end - start + 1);
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new Response(stream, { status: 206, headers });
    }
    headers['Content-Length'] = String(size);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  });

  // The built web app (production). In development Vite serves it.
  if (existsSync('dist/index.html')) {
    app.use('/*', serveStatic({ root: './dist' }));
    app.get('*', serveStatic({ path: './dist/index.html' }));
  }
  return app;
}
