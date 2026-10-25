import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { freshWorld } from './helpers.ts';
import { buildApp } from '../server/app.ts';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../server/seed.ts';
import { base32Encode, hotp, base32Decode, totpAt, verifyTotp, stepAt } from '../server/security/totp.ts';
import { checkPassword } from '../server/security/password.ts';
import { resetLimits } from '../server/security/limits.ts';
import { appleClientSecret } from '../server/security/oauth.ts';
import { setClock } from '../server/util/time.ts';
import { db } from '../server/db.ts';

beforeEach(() => {
  resetLimits();
  setClock(() => new Date());
});

// ---------- helpers ----------

type J = Record<string, any>;

function client() {
  const app = buildApp();
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    const session = set?.match(/kindred_session=([^;]*)/);
    if (session) cookie = session[1] ? `kindred_session=${session[1]}` : '';
    const text = await res.text();
    let json: J = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, body: json, res };
  };
  return {
    app,
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}, h: Record<string, string> = {}) => call('POST', p, b, h),
    del: (p: string) => call('DELETE', p),
    get cookie() {
      return cookie;
    },
    set cookie(v: string) {
      cookie = v;
    },
  };
}

// ---------- two-step codes ----------

test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const key = base32Decode(secret);
  assert.equal(hotp(key, stepAt(59_000), 8), '94287082');
  assert.equal(hotp(key, stepAt(1111111109_000), 8), '07081804');
  assert.equal(hotp(key, stepAt(1234567890_000), 8), '89005924');
  assert.equal(hotp(key, stepAt(2000000000_000), 8), '69279037');
});

test('TOTP allows one step of clock drift and refuses a code twice', () => {
  const secret = base32Encode(Buffer.from('abcdefghijklmnopqrst'));
  const t = 1_800_000_000_000;
  const code = totpAt(secret, t);
  const step = verifyTotp(secret, code, t + 25_000);
  assert.ok(step !== null, 'accepted within drift');
  assert.equal(verifyTotp(secret, code, t, step!), null, 'replay refused');
  assert.equal(verifyTotp(secret, code, t + 120_000), null, 'too old');
  assert.equal(verifyTotp(secret, '12345', t), null, 'wrong length');
});

// ---------- passwords ----------

test('passwords: length, common passwords, and names are refused', () => {
  assert.equal(checkPassword('short').ok, false);
  assert.equal(checkPassword('password123').ok, false);
  assert.equal(checkPassword('Sarah2024!!', { name: 'Sarah Miller' }).ok, false);
  assert.equal(checkPassword('sarahmiller-99', { email: 'sarahmiller@x.com' }).ok, false);
  const good = checkPassword('a long harbor sunrise 42');
  assert.equal(good.ok, true);
  assert.ok(good.score >= 2);
});

// ---------- lockout ----------

test('five wrong passwords pause the account, and the right one waits too', async () => {
  await freshWorld();
  const c = client();
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/auth/login', { email: DEMO_EMAIL, password: 'nope-nope-nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: DEMO_EMAIL, password: 'nope-nope-nope' })).status, 429);
  assert.equal((await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD })).status, 429, 'still locked');
  const t = Date.now() + 16 * 60_000;
  setClock(() => new Date(t));
  assert.equal((await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD })).status, 200, 'unlocks after 15 minutes');
  const events = db().all<{ kind: string }>("SELECT kind FROM security_events WHERE kind IN ('sign_in_failed', 'account_locked')");
  assert.ok(events.some((e) => e.kind === 'account_locked'));
});

test('an unknown email gets the same answer as a wrong password', async () => {
  await freshWorld();
  const c = client();
  const a = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever-it-is' });
  const b = await c.post('/api/auth/login', { email: DEMO_EMAIL, password: 'whatever-it-is' });
  assert.equal(a.status, b.status);
  assert.equal(a.body.error, b.body.error);
});

// ---------- two-step sign-in ----------

test('two-step verification: set up, sign in with a code, and with a backup code once', async () => {
  await freshWorld();
  const c = client();
  await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  const setup = await c.post('/api/account/two-step/setup');
  assert.match(setup.body.uri, /^otpauth:\/\/totp\/Kindred:/);
  assert.equal((await c.post('/api/account/two-step/enable', { code: '000000' })).status, 400);
  const enabled = await c.post('/api/account/two-step/enable', { code: totpAt(setup.body.secret, Date.now()) });
  assert.equal(enabled.body.recoveryCodes.length, 10);

  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);

  // Password alone isn't enough any more.
  const first = await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  assert.equal(first.body.twoStep, true);
  assert.equal(c.cookie, '', 'no session before the second step');
  assert.equal((await c.post('/api/auth/two-step', { challenge: first.body.challenge, code: '123456' })).status, 401);
  // Next 30-second window, so the code used during setup isn't a replay.
  const later = Date.now() + 30_000;
  setClock(() => new Date(later));
  const ok = await c.post('/api/auth/two-step', { challenge: first.body.challenge, code: totpAt(setup.body.secret, later) });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).status, 200);

  // A backup code works exactly once.
  await c.post('/api/auth/logout');
  const backup = enabled.body.recoveryCodes[0];
  const ch1 = (await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD })).body.challenge;
  assert.equal((await c.post('/api/auth/two-step', { challenge: ch1, code: backup })).status, 200);
  await c.post('/api/auth/logout');
  const ch2 = (await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD })).body.challenge;
  assert.equal((await c.post('/api/auth/two-step', { challenge: ch2, code: backup })).status, 401);
});

// ---------- sessions ----------

test('sessions expire after 30 days idle, and can be signed out remotely', async () => {
  await freshWorld();
  const phone = client();
  const laptop = client();
  await phone.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD }, { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
  await laptop.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD }, { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0 Safari/537.36' });
  const sec = await laptop.get('/api/account/security');
  const phoneSession = sec.body.sessions.find((s: J) => s.device === 'Safari on iPhone');
  assert.ok(phoneSession && !phoneSession.current);
  assert.equal((await laptop.del(`/api/account/sessions/${phoneSession.id}`)).status, 200);
  assert.equal((await phone.get('/api/me')).status, 401, 'phone was signed out');

  const t = Date.now() + 31 * 86400_000;
  setClock(() => new Date(t));
  assert.equal((await laptop.get('/api/me')).status, 401, 'expired');
});

test('changing your password signs out your other devices', async () => {
  await freshWorld();
  const a = client();
  const b = client();
  await a.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  await b.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  assert.equal((await a.post('/api/account/password', { current: 'wrong', next: 'a long harbor sunrise 42' })).status, 401);
  assert.equal((await a.post('/api/account/password', { current: DEMO_PASSWORD, next: 'password123' })).status, 400);
  assert.equal((await a.post('/api/account/password', { current: DEMO_PASSWORD, next: 'a long harbor sunrise 42' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);
});

// ---------- invitations ----------

test('invite a family member by link: preview, join once, and only owners remove people', async () => {
  await freshWorld();
  const sarah = client();
  await sarah.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  const pid = (await sarah.get('/api/me')).body.patients[0].id;
  const inv = await sarah.post(`/api/patients/${pid}/invites`, { relationship: 'Son' });
  assert.match(inv.body.url, /#\/join\?invite=/);

  const tom = client();
  const preview = await tom.get(`/api/invites/${inv.body.token}`);
  assert.deepEqual([preview.body.valid, preview.body.patientName, preview.body.inviterName], [true, 'Rose', 'Sarah']);
  assert.equal((await tom.post(`/api/invites/${inv.body.token}/accept`)).status, 401, 'must sign in first');
  await tom.post('/api/auth/signup', { email: 'tom@example.com', name: 'Tom Miller', password: 'a long harbor sunrise 42' });
  assert.equal((await tom.post(`/api/invites/${inv.body.token}/accept`)).status, 200);
  assert.equal((await tom.get(`/api/patients/${pid}/home`)).status, 200, 'Tom can see Rose now');
  assert.equal((await tom.get(`/api/invites/${inv.body.token}`)).body.valid, false, 'single use');

  const members = (await sarah.get(`/api/patients/${pid}/members`)).body as J[];
  assert.deepEqual(members.map((m) => [m.name, m.role]), [['Sarah Miller', 'owner'], ['Tom Miller', 'family']]);
  const sarahId = members[0].id;
  assert.equal((await tom.del(`/api/patients/${pid}/members/${sarahId}`)).status, 403);
});

// ---------- tablets ----------

test('pairing codes resist guessing, and removing a tablet disconnects it', async () => {
  await freshWorld();
  const c = client();
  await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  const pid = (await c.get('/api/me')).body.patients[0].id;
  const pairing = await c.post(`/api/patients/${pid}/pairing`);
  assert.match(pairing.body.url, /#\/companion\?pair=\d{6}$/);
  const tablet = client();
  const paired = await tablet.post('/api/device/pair', { code: pairing.body.code }, { 'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1' });
  const devices = (await c.get(`/api/patients/${pid}/devices`)).body as J[];
  assert.equal(devices[0].name, 'Safari on iPad');
  const auth = { Authorization: `Bearer ${paired.body.token}` };
  assert.equal((await c.app.request('/api/device/state', { headers: auth })).status, 200);
  assert.equal((await c.del(`/api/patients/${pid}/devices/${devices[0].id}`)).status, 200);
  assert.equal((await c.app.request('/api/device/state', { headers: auth })).status, 401);

  for (let i = 0; i < 9; i++) await tablet.post('/api/device/pair', { code: '000000' });
  assert.equal((await tablet.post('/api/device/pair', { code: '000001' })).status, 429);
});

// ---------- Google, Apple, Facebook ----------

test('Sign in with Google: new account, same account next time, and stolen links are refused', async () => {
  await freshWorld();
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  const realFetch = globalThis.fetch;
  let nonce = '';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(init.body));
    assert.ok(form.get('code_verifier'), 'PKCE verifier sent');
    const claims = {
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      sub: 'google-123',
      email: 'grace@example.com',
      email_verified: true,
      name: 'Grace Miller',
      nonce,
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const jwt = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
    return new Response(JSON.stringify({ id_token: jwt, access_token: 'x' }), { status: 200 });
  }) as typeof fetch;
  try {
    const signIn = async (withCookie = true) => {
      const c = client();
      const start = await c.app.request('/api/auth/oauth/google/start');
      assert.equal(start.status, 302);
      const to = new URL(start.headers.get('location')!);
      assert.equal(to.host, 'accounts.google.com');
      assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
      nonce = to.searchParams.get('nonce')!;
      const flow = start.headers.get('set-cookie')!.match(/kindred_oauth=([^;]+)/)![1];
      const cb = await c.app.request(`/api/auth/oauth/google/callback?code=abc&state=${to.searchParams.get('state')}`, {
        headers: withCookie ? { Cookie: `kindred_oauth=${flow}` } : {},
      });
      return { cb, state: to.searchParams.get('state')!, flow };
    };

    const { cb, state, flow } = await signIn();
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/#/family');
    assert.match(cb.headers.get('set-cookie') ?? '', /kindred_session=/);
    const user = db().get<{ id: string; name: string }>("SELECT id, name FROM users WHERE email = 'grace@example.com'")!;
    assert.equal(user.name, 'Grace Miller');

    // The same callback link can't be replayed.
    const replay = await buildApp().request(`/api/auth/oauth/google/callback?code=abc&state=${state}`, { headers: { Cookie: `kindred_oauth=${flow}` } });
    assert.match(replay.headers.get('location')!, /authError/);

    // Signing in again finds the same account.
    await signIn();
    assert.equal(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = 'grace@example.com'")!.n, 1);

    // A callback opened in a different browser (login CSRF) is refused.
    const csrf = await signIn(false);
    assert.match(csrf.cb.headers.get('location')!, /authError/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test('providers that aren’t set up say so instead of failing', async () => {
  await freshWorld();
  const c = client();
  const list = (await c.get('/api/auth/providers')).body as J[];
  assert.deepEqual(list.map((p) => p.id), ['google', 'apple', 'facebook']);
  const res = await c.app.request('/api/auth/oauth/apple/start');
  assert.match(decodeURIComponent(res.headers.get('location')!), /isn’t set up/);
});

test('Apple client secret is a valid ES256 JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  Object.assign(process.env, {
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_CLIENT_ID: 'com.example.kindred.web',
    APPLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  try {
    const jwt = appleClientSecret();
    const [h, p, s] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'ES256');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.deepEqual([payload.iss, payload.sub, payload.aud], ['TEAM123456', 'com.example.kindred.web', 'https://appleid.apple.com']);
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  } finally {
    for (const k of ['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_CLIENT_ID', 'APPLE_PRIVATE_KEY']) delete process.env[k];
  }
});
