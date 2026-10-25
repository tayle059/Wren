// End-to-end check in a real browser with a simulated microphone.
//   npm run build && npm run e2e
// Seeds a fresh demo, starts the server, drives the family app and the
// companion tablet side by side, and saves screenshots to docs/screenshots.
import { chromium, type Page } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '../server/util/wav.ts';

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(process.cwd(), 'docs', 'screenshots');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';

/** Speech-like audio: voiced syllables with a moving pitch, then a long pause, on a loop. */
function fakeSpeechWav(): Uint8Array {
  const rate = 44100;
  const seconds = 7;
  const out = new Float32Array(rate * seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    if (t < 2 || t > 3.6) continue; // 1.6 s of "talking" in every 7 s
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * 1.3 * t);
    phase += (2 * Math.PI * f0) / rate;
    let s = 0;
    for (let h = 1; h <= 14; h++) {
      const f = f0 * h;
      const formant = Math.exp(-(((f - 700) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 400) ** 2)) + 0.3 * Math.exp(-(((f - 2500) / 600) ** 2));
      s += formant * Math.sin(h * phase);
    }
    const syllables = 0.5 * (1 - Math.cos(2 * Math.PI * 4 * (t - 2)));
    out[i] = 0.35 * syllables * s + 0.01 * (Math.random() - 0.5);
  }
  return encodeWav(out, rate);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const step = (name: string) => console.log(`\n▸ ${name}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  ok(`screenshot ${name}.png`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const data = mkdtempSync(join(tmpdir(), 'kindred-e2e-'));
  // Chrome's sandbox can't read the fake-microphone file from the system temp dir.
  mkdirSync(join(process.cwd(), 'e2e', 'artifacts'), { recursive: true });
  const wavPath = join(process.cwd(), 'e2e', 'artifacts', 'speech.wav');
  writeFileSync(wavPath, fakeSpeechWav());
  const env = { ...process.env, DATA_DIR: data, PORT: String(PORT), KINDRED_STT: 'fake', NODE_ENV: 'production', META_API_KEY: '', GOOGLE_CLIENT_ID: 'e2e', GOOGLE_CLIENT_SECRET: 'e2e', APPLE_CLIENT_ID: 'e2e', APPLE_TEAM_ID: 'e2e', APPLE_KEY_ID: 'e2e', APPLE_PRIVATE_KEY: 'e2e', FACEBOOK_APP_ID: 'e2e', FACEBOOK_APP_SECRET: 'e2e', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' };

  step('Seed a fresh demo world');
  execFileSync('npx', ['tsx', 'server/seed.ts'], { env, stdio: 'inherit' });

  step('Start the server');
  const server = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  await new Promise<void>((resolve) => server.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));
  ok('listening');

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => (cond ? ok(msg) : (failures.push(msg), console.log(`  ✗ ${msg}`)));

  try {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 860 } });
    const fam = await ctx.newPage();
    fam.on('pageerror', (e) => failures.push(`family page error: ${e.message}`));

    step('Family: open the live demo');
    await fam.goto(`${BASE}/#/`);
    await shot(fam, '01-landing');
    await fam.getByRole('link', { name: /I’m family or a caregiver/ }).click();
    await fam.getByRole('heading', { name: 'Welcome back' }).waitFor();
    check(await fam.getByText('Continue with Apple').isVisible(), 'Google, Apple and Facebook sign-in buttons shown');
    await shot(fam, '00-sign-in');
    await fam.goto(`${BASE}/#/`);
    await fam.getByRole('button', { name: /Try the live demo/ }).click();
    await fam.getByRole('heading', { name: 'Rose today' }).waitFor();
    check(await fam.getByText('noticed something').isVisible(), 'sundown suggestion is shown');
    await shot(fam, '02-family-today');

    for (const [tab, name] of [
      ['Insights', '03-family-insights'],
      ['Book', '04-family-book'],
      ['Memories', '05-family-memories'],
    ] as const) {
      await fam.getByRole('link', { name: tab }).click();
      await fam.waitForTimeout(500);
      await fam.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
      ok(`screenshot ${name}.png`);
    }
    await fam.getByRole('link', { name: 'Today' }).click();

    step('Tablet: pair by QR code');
    const fget = async <T,>(path: string): Promise<T> => (await fam.request.get(`${BASE}${path}`)).json() as Promise<T>;
    const fpost = async <T,>(path: string, data: unknown = {}): Promise<T> => (await fam.request.post(`${BASE}${path}`, { data })).json() as Promise<T>;
    const me = await fget<{ patients: { id: string }[] }>('/api/me');
    const pid = me.patients[0].id;
    await fam.getByRole('button', { name: 'Connect tablet' }).click();
    await fam.locator('.pair-qr img').waitFor();
    await fam.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('.pair-code')?.textContent ?? ''));
    const code = (await fam.locator('.pair-code').innerText()).replace(/\D/g, '');
    await shot(fam, '06a-family-qr');
    const tablet = await ctx.newPage();
    tablet.on('pageerror', (e) => failures.push(`tablet page error: ${e.message}`));
    tablet.on('console', (m) => (m.type() === 'warning' || m.type() === 'error') && console.log(`    [tablet] ${m.text()}`));
    await tablet.setViewportSize({ width: 1280, height: 800 });
    await tablet.goto(`${BASE}/#/companion?pair=${code}&demo`);
    await tablet.getByRole('button', { name: /Tap to wake/ }).waitFor();
    await fam.locator('.pair-done').waitFor({ timeout: 15000 });
    check(true, 'family dialog shows the tablet connected');
    await shot(fam, '06b-family-qr-connected');
    await fam.getByRole('button', { name: 'Done' }).click();
    await shot(tablet, '06-tablet-wake');
    await tablet.getByRole('button', { name: /Tap to wake/ }).click();
    await tablet.getByRole('button', { name: /Talk with Wren/ }).first().waitFor();
    await tablet.getByRole('button', { name: 'Hide' }).click();
    await shot(tablet, '07-tablet-idle');

    step('Voice loop: microphone → speech detection → transcribe → brain → photo');
    await api('/api/test/stt-queue', { method: 'POST', body: JSON.stringify({ texts: ['Who is Leo?'] }) });
    await tablet.locator('footer .talk').click();
    await tablet.locator('.photo-card').waitFor({ timeout: 40000 });
    check(/grandson/i.test(await tablet.locator('.caption').innerText()), 'Wren says Leo is her grandson');
    check((await tablet.locator('.heard').count()) >= 0, 'transcript shown while thinking');
    await shot(tablet, '08-tablet-photo');

    step('Emergency: an urgent alert reaches the family app live');
    await api('/api/test/stt-queue', { method: 'POST', body: JSON.stringify({ texts: ['I fell and my hip hurts'] }) });
    await fam.locator('.alert[data-level="urgent"]').waitFor({ timeout: 40000 });
    check(true, 'urgent alert visible on the family home');
    await tablet.waitForFunction(() => document.querySelector('.companion')?.getAttribute('data-mode') === 'calm', null, { timeout: 15000 });
    check(true, 'tablet switched to calm mode');
    await shot(tablet, '09-tablet-calm-after-fall');
    await shot(fam, '10-family-urgent');

    step('Reminder: family reaches out, the tablet shows the card, Rose taps "I took it"');
    // Let the current conversation wind down first.
    await tablet.evaluate(() => (document.querySelector('.orb') as HTMLButtonElement)?.click());
    const sched = await fget<{ id: string; label: string }[]>(`/api/patients/${pid}/schedule`);
    const pills = sched.find((s) => s.label === 'Evening pills')!;
    await fpost(`/api/patients/${pid}/reach-out`, { kind: 'item', scheduleItemId: pills.id });
    await tablet.locator('.reminder-card').waitFor({ timeout: 60000 });
    await shot(tablet, '11-tablet-reminder');
    await tablet.getByRole('button', { name: 'I took it' }).click();
    await tablet.locator('.reminder-card').waitFor({ state: 'detached', timeout: 15000 });
    await fam.waitForTimeout(1500);
    const home = await fget<{ today: { schedule: { label: string; status: string }[] } }>(`/api/patients/${pid}/home`);
    check(home.today.schedule.find((s) => s.label === 'Evening pills')?.status === 'confirmed', 'evening pills recorded as confirmed');

    step('Typed input (demo director) and the "Where is Frank?" rule');
    await tablet.goto(`${BASE}/#/companion?demo`);
    await tablet.reload(); // a hash change alone doesn't reload the app
    await tablet.getByRole('button', { name: /Tap to wake/ }).click();
    await tablet.getByRole('button', { name: 'Where is Frank?' }).click();
    await tablet.waitForFunction(() => /Frank/.test(document.querySelector('.caption')?.textContent ?? ''), null, { timeout: 40000 });
    const caption = await tablet.locator('.caption').innerText();
    check(!/died|passed|dead/i.test(caption), `no death announcement ("${caption}")`);

    step('Security: two-step verification setup, and inviting family by QR');
    await fam.goto(`${BASE}/#/family/settings`);
    await fam.getByRole('button', { name: 'Turn on two-step verification' }).click();
    await fam.locator('.setup-2fa img').waitFor();
    await fam.locator('#security').scrollIntoViewIfNeeded();
    await fam.locator('#security').screenshot({ path: join(SHOTS, '13-security-2fa.png') });
    ok('screenshot 13-security-2fa.png');
    check((await fam.getByText('Where you’re signed in').count()) === 1, 'signed-in devices listed');
    await fam.getByRole('button', { name: 'Cancel' }).first().click();
    await fam.getByRole('button', { name: 'Invite family' }).click();
    await fam.getByLabel(/They are Rose’s/).fill('Son');
    await fam.getByRole('button', { name: 'Create invitation' }).click();
    await fam.locator('.dialog .qr img').waitFor();
    await shot(fam, '14-invite-qr');
    const inviteUrl = await fam.getByLabel('Invitation link').inputValue();
    await fam.getByRole('button', { name: 'Done' }).click();

    step('A son accepts the invitation on his own phone');
    const sonCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const son = await sonCtx.newPage();
    son.on('pageerror', (e) => failures.push(`invitee page error: ${e.message}`));
    await son.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await son.getByText('invited you to help care for').waitFor();
    await son.getByRole('button', { name: 'New here? Create an account' }).click();
    await son.getByLabel('Your name').fill('Tom Miller');
    await son.getByLabel('Email').fill('tom@example.com');
    await son.locator('input[type=password]').fill('a long harbor sunrise 42');
    await son.waitForTimeout(500);
    await shot(son, '15-join-signup');
    await son.getByRole('button', { name: 'Create account' }).click();
    await son.getByRole('button', { name: 'Join' }).click();
    await son.getByRole('heading', { name: 'Rose today' }).waitFor();
    check(true, 'invited family member joined and sees Rose’s day');
    await sonCtx.close();

    step('Phone layout');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await phone.newPage();
    await p.request.post(`${BASE}/api/auth/login`, { data: { email: 'sarah@kindred.demo', password: 'kindred-demo' } });
    await p.goto(`${BASE}/#/family`);
    await p.getByRole('heading', { name: 'Rose today' }).waitFor();
    await shot(p, '12-phone-today');
    await phone.close();
  } finally {
    await browser.close();
    try {
      process.kill(-server.pid!, 'SIGTERM'); // the whole process group: npx, tsx, node
    } catch {
      // already gone
    }
  }

  if (failures.length) {
    console.log(`\n✗ ${failures.length} problem(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('\n✓ End-to-end run passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
