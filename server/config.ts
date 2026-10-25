import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader so the project runs with zero extra dependencies.
function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv(resolve(process.cwd(), '.env'));

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  dataDir: resolve(env.DATA_DIR ?? './data'),
  // Render and Railway tell us our public address; fall back to localhost.
  publicUrl:
    env.PUBLIC_URL ??
    env.RENDER_EXTERNAL_URL ??
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT ?? 8787}`),
  // Hosted demos start with Rose's world when the database is empty.
  autoSeed: env.KINDRED_AUTO_SEED === '1',
  meta: {
    apiKey: env.META_API_KEY ?? '',
    base: env.META_API_BASE ?? 'https://api.meta.ai/v1',
    chatModel: env.META_CHAT_MODEL ?? 'muse-spark-1.3',
    visionModel: env.META_VISION_MODEL ?? 'muse-spark-1.3',
    asrModel: env.META_ASR_MODEL ?? 'muse-voice-transcribe-1.0',
    timeoutMs: Number(env.META_TIMEOUT_MS ?? 15000),
  },
  // 'fake' is used by the end-to-end tests: transcripts come from a queue.
  sttMode: (env.KINDRED_STT ?? '') as '' | 'fake',
  // Scheduler tick; tests drive the scheduler manually.
  schedulerIntervalMs: Number(env.KINDRED_SCHEDULER_MS ?? 30000),
  disableBackground: env.KINDRED_NO_BACKGROUND === '1',
};

export const hasMeta = () => config.meta.apiKey.length > 0;
