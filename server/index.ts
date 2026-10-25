import { serve } from '@hono/node-server';
import { config, hasMeta } from './config.ts';
import { db } from './db.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './jobs/scheduler.ts';

db(); // open and migrate before taking traffic

const app = buildApp();
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Kindred is listening on http://localhost:${info.port}`);
  console.log(
    hasMeta()
      ? `Brain: Muse Spark (${config.meta.chatModel}); speech: Muse Voice Transcribe`
      : 'Brain: offline (set META_API_KEY in .env to use Muse Spark); speech: browser',
  );
});

if (!config.disableBackground) startScheduler(config.schedulerIntervalMs);
