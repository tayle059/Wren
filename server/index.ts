import { serve } from '@hono/node-server';
import { config, hasMeta } from './config.ts';
import { db } from './db.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './jobs/scheduler.ts';

db(); // open and migrate before taking traffic

if (config.autoSeed && !db().get('SELECT 1 FROM users LIMIT 1')) {
  const { seedDemo } = await import('./seed.ts');
  await seedDemo();
  console.log('Empty database: loaded the demo (sarah@kindred.demo / kindred-demo).');
}

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
