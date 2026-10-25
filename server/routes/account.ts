// Signing up, signing in (password, Google, Apple, Facebook), two-step
// verification, sessions, and invitations to join a family's circle.
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  checkLogin,
  consumeChallenge,
  createChallenge,
  createSession,
  createUser,
  endSession,
  hasPassword,
  readChallenge,
  setPassword,
  sha256Hex,
  userForToken,
  verifyUserPassword,
  type User,
} from '../auth.ts';
import { db } from '../db.ts';
import { getPatient } from '../domain.ts';
import { toFamily } from '../events.ts';
import { now, nowIso } from '../util/time.ts';
import { audit, describeAgent, recentEvents } from '../security/audit.ts';
import { allow } from '../security/limits.ts';
import { checkPassword } from '../security/password.ts';
import { newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from '../security/totp.ts';
import { beginFlow, finishFlow, isProvider, PROVIDERS, providerList, redirectUri, type ProviderId } from '../security/oauth.ts';
import { clearSessionCookie, isHttps, requestMeta, sessionToken, setSessionCookie } from './common.ts';

type Env = { Variables: { user: User & { sessionHash: string } } };

export const accountRoutes = new Hono<Env>();

const FLOW_COOKIE = 'kindred_oauth';

function startSession(c: Context, user: User, method: string) {
  const meta = requestMeta(c);
  setSessionCookie(c, createSession(user.id, { ...meta, method }));
  audit(user.id, 'sign_in', method === 'password' ? 'with a password' : `with ${method}`, meta);
}

const signedIn = (c: Context) => userForToken(sessionToken(c));

// ---------- Password accounts ----------

accountRoutes.post('/auth/password-strength', async (c) => {
  const { password, email, name } = await c.req.json<{ password: string; email?: string; name?: string }>();
  return c.json(checkPassword(String(password ?? ''), { email, name }));
});

accountRoutes.post('/auth/signup', async (c) => {
  const meta = requestMeta(c);
  if (!allow(`signup:${meta.ip}`, 10, 3600_000)) return c.json({ error: 'Too many new accounts from here. Please try again later.' }, 429);
  const { email, name, password } = await c.req.json<{ email: string; name: string; password: string }>();
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || !name?.trim()) {
    return c.json({ error: 'Please enter your name and a valid email address.' }, 400);
  }
  const strength = checkPassword(String(password ?? ''), { email: cleanEmail, name });
  if (!strength.ok) return c.json({ error: strength.problems[0], problems: strength.problems }, 400);
  if (db().get('SELECT 1 FROM users WHERE email = ?', cleanEmail)) {
    return c.json({ error: 'That email already has an account. Try signing in.' }, 409);
  }
  const user = createUser(cleanEmail, name, password);
  audit(user.id, 'account_created', 'with a password', meta);
  startSession(c, user, 'password');
  return c.json({ user });
});

accountRoutes.post('/auth/login', async (c) => {
  const meta = requestMeta(c);
  if (!allow(`login:${meta.ip}`, 20, 900_000)) return c.json({ error: 'Too many sign-in attempts. Please wait 15 minutes.' }, 429);
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const result = checkLogin(String(email ?? ''), String(password ?? ''));
  if (!result.ok) {
    if (result.userId) audit(result.userId, result.reason === 'locked' ? 'account_locked' : 'sign_in_failed', '', meta);
    if (result.reason === 'locked') {
      return c.json({ error: 'Too many wrong passwords. For your safety this account is paused for 15 minutes.' }, 429);
    }
    return c.json({ error: 'That email and password don’t match.' }, 401);
  }
  if (result.twoStep) return c.json({ twoStep: true, challenge: createChallenge(result.user.id, 'password') });
  startSession(c, result.user, 'password');
  return c.json({ user: result.user });
});

/** Second step: a code from the authenticator app, or a one-time backup code. */
accountRoutes.post('/auth/two-step', async (c) => {
  const meta = requestMeta(c);
  if (!allow(`2fa:${meta.ip}`, 30, 900_000)) return c.json({ error: 'Too many attempts. Please wait 15 minutes.' }, 429);
  const { challenge, code } = await c.req.json<{ challenge: string; code: string }>();
  const ch = readChallenge(String(challenge ?? ''));
  if (!ch) return c.json({ error: 'That sign-in has expired. Please start again.' }, 401);
  const u = db().get<User & { totp_secret: string; totp_last_step: number; recovery_codes_json: string }>(
    'SELECT id, email, name, totp_secret, totp_last_step, recovery_codes_json FROM users WHERE id = ?',
    ch.userId,
  )!;
  const step = verifyTotp(u.totp_secret, String(code ?? ''), now().getTime(), u.totp_last_step);
  if (step !== null) {
    db().run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, u.id);
  } else {
    const hashes = JSON.parse(u.recovery_codes_json) as string[];
    const h = sha256Hex(String(code ?? '').trim().toLowerCase());
    if (!hashes.includes(h)) {
      audit(u.id, 'sign_in_failed', 'wrong two-step code', meta);
      return c.json({ error: 'That code didn’t work. Check the time on your phone and try again.' }, 401);
    }
    db().run('UPDATE users SET recovery_codes_json = ? WHERE id = ?', JSON.stringify(hashes.filter((x) => x !== h)), u.id);
    audit(u.id, 'recovery_code_used', `${hashes.length - 1} left`, meta);
  }
  consumeChallenge(ch.hash);
  startSession(c, { id: u.id, email: u.email, name: u.name }, ch.method);
  return c.json({ user: { id: u.id, email: u.email, name: u.name } });
});

accountRoutes.post('/auth/logout', (c) => {
  const token = sessionToken(c);
  if (token) endSession(token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------- Google, Apple, Facebook ----------

accountRoutes.get('/auth/providers', (c) => c.json(providerList()));

accountRoutes.get('/auth/oauth/:provider/start', (c) => {
  const id = c.req.param('provider');
  if (!isProvider(id)) return c.text('Unknown provider', 404);
  if (!PROVIDERS[id].enabled()) {
    return c.redirect(`/#/family?authError=${encodeURIComponent(`${PROVIDERS[id].name} sign-in isn’t set up on this server yet.`)}`);
  }
  // Linking from Settings: attach this provider to the signed-in account.
  const linking = c.req.query('link') === '1' ? signedIn(c) : null;
  const { url, browser } = beginFlow(id, linking?.id ?? null);
  // Apple posts back from its own site, so this cookie must be SameSite=None (which requires HTTPS).
  setCookie(c, FLOW_COOKIE, browser, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: isHttps(c) ? 'None' : 'Lax',
    path: '/api/auth/oauth',
    maxAge: 600,
  });
  return c.redirect(url);
});

async function oauthCallback(c: Context) {
  const id = c.req.param('provider') as ProviderId;
  const fail = (msg: string) => c.redirect(`/#/family?authError=${encodeURIComponent(msg)}`);
  if (!isProvider(id)) return fail('Unknown sign-in provider.');
  const params: Record<string, string> =
    c.req.method === 'POST' ? Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)])) : c.req.query();
  if (params.error) return fail(params.error === 'access_denied' || params.error === 'user_cancelled_authorize' ? 'Sign-in was cancelled.' : 'Sign-in didn’t work. Please try again.');
  const flow = finishFlow(id, params.state ?? '', getCookie(c, FLOW_COOKIE));
  deleteCookie(c, FLOW_COOKIE, { path: '/api/auth/oauth', secure: isHttps(c) });
  if (!flow) return fail('That sign-in link expired. Please try again.');

  let profile;
  try {
    profile = await PROVIDERS[id].exchange({ code: params.code ?? '', verifier: flow.verifier, nonce: flow.nonce, redirectUri: redirectUri(id), extra: params });
  } catch (e) {
    console.warn('[oauth]', id, (e as Error).message);
    return fail(`We couldn’t confirm your ${PROVIDERS[id].name} account. Please try again.`);
  }
  const meta = requestMeta(c);
  const name = PROVIDERS[id].name;
  const linked = db().get<{ user_id: string }>('SELECT user_id FROM identities WHERE provider = ? AND subject = ?', id, profile.subject);

  // Linking a provider to an existing, signed-in account.
  if (flow.linkUserId) {
    if (linked && linked.user_id !== flow.linkUserId) return c.redirect(`/#/family/settings?authError=${encodeURIComponent(`That ${name} account is already used by another Kindred account.`)}`);
    if (!linked) {
      db().run('INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)', id, profile.subject, flow.linkUserId, profile.email, nowIso());
      audit(flow.linkUserId, 'identity_linked', name, meta);
    }
    return c.redirect(`/#/family/settings?linked=${id}`);
  }

  let userId = linked?.user_id;
  if (!userId && profile.email && profile.emailVerified) {
    // Same verified email as an existing account: that's the same person.
    userId = db().get<{ id: string }>('SELECT id FROM users WHERE email = ?', profile.email.toLowerCase())?.id;
    if (userId) audit(userId, 'identity_linked', `${name} (same verified email)`, meta);
  }
  if (!userId) {
    if (!profile.email) return fail(`Please allow ${name} to share your email address with Kindred.`);
    if (db().get('SELECT 1 FROM users WHERE email = ?', profile.email.toLowerCase())) {
      return fail(`An account with ${profile.email} already exists. Sign in with your password, then connect ${name} in Settings.`);
    }
    const user = createUser(profile.email, profile.name || profile.email.split('@')[0], null);
    userId = user.id;
    audit(userId, 'account_created', `with ${name}`, meta);
  }
  if (!linked) {
    db().run('INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)', id, profile.subject, userId, profile.email, nowIso());
  }
  const user = db().get<User & { totp_enabled: number }>('SELECT id, email, name, totp_enabled FROM users WHERE id = ?', userId)!;
  if (user.totp_enabled) {
    // The fragment never reaches servers or logs; the challenge is single-use and short-lived.
    return c.redirect(`/#/family?twoStep=${encodeURIComponent(createChallenge(user.id, name))}`);
  }
  startSession(c, { id: user.id, email: user.email, name: user.name }, name);
  return c.redirect('/#/family');
}

accountRoutes.get('/auth/oauth/:provider/callback', oauthCallback);
accountRoutes.post('/auth/oauth/:provider/callback', oauthCallback); // Apple's form_post

// ---------- Invitations (public preview) ----------

function inviteRow(token: string) {
  return db().get<{ token_hash: string; patient_id: string; created_by: string; relationship: string; expires_at: string; used_at: string | null }>(
    'SELECT * FROM invites WHERE token_hash = ?',
    sha256Hex(token ?? ''),
  );
}

accountRoutes.get('/invites/:token', (c) => {
  if (!allow(`invite:${requestMeta(c).ip}`, 60, 600_000)) return c.json({ error: 'Too many requests.' }, 429);
  const inv = inviteRow(c.req.param('token'));
  if (!inv || inv.used_at || inv.expires_at < nowIso()) return c.json({ valid: false });
  const patient = getPatient(inv.patient_id)!;
  const from = db().get<{ name: string }>('SELECT name FROM users WHERE id = ?', inv.created_by);
  return c.json({ valid: true, patientName: patient.preferred_name, inviterName: from?.name.split(' ')[0] ?? 'Your family', relationship: inv.relationship });
});

// ---------- Signed in ----------

accountRoutes.use('/account/*', async (c, next) => {
  const user = signedIn(c);
  if (!user) return c.json({ error: 'Please sign in.' }, 401);
  c.set('user', user);
  await next();
});
accountRoutes.use('/invites/:token/accept', async (c, next) => {
  const user = signedIn(c);
  if (!user) return c.json({ error: 'Please sign in.' }, 401);
  c.set('user', user);
  await next();
});

accountRoutes.post('/invites/:token/accept', async (c) => {
  const user = c.get('user');
  const inv = inviteRow(c.req.param('token'));
  if (!inv || inv.used_at || inv.expires_at < nowIso()) return c.json({ error: 'This invitation has expired. Ask for a new one.' }, 410);
  const { relationship } = await c.req.json<{ relationship?: string }>().catch(() => ({ relationship: '' }));
  db().run('UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ?', user.id, nowIso(), inv.token_hash);
  db().run(
    "INSERT OR IGNORE INTO memberships (user_id, patient_id, relationship, role) VALUES (?, ?, ?, 'family')",
    user.id,
    inv.patient_id,
    (relationship || inv.relationship || '').slice(0, 60),
  );
  const patient = getPatient(inv.patient_id)!;
  audit(user.id, 'member_joined', `${patient.preferred_name}'s circle`, requestMeta(c));
  audit(inv.created_by, 'member_joined', `${user.name} joined ${patient.preferred_name}'s circle`, requestMeta(c));
  toFamily(inv.patient_id, { type: 'member_joined', name: user.name });
  return c.json({ ok: true, patientId: inv.patient_id });
});

accountRoutes.get('/account/security', (c) => {
  const user = c.get('user');
  const u = db().get<{ totp_enabled: number; recovery_codes_json: string }>('SELECT totp_enabled, recovery_codes_json FROM users WHERE id = ?', user.id)!;
  const sessions = db()
    .all<{ token_hash: string; created_at: string; last_used_at: string | null; user_agent: string; ip: string; method: string }>(
      'SELECT token_hash, created_at, last_used_at, user_agent, ip, method FROM sessions WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY COALESCE(last_used_at, created_at) DESC',
      user.id,
      nowIso(),
    )
    .map((s) => ({
      id: s.token_hash.slice(0, 16),
      current: s.token_hash === user.sessionHash,
      device: s.user_agent ? describeAgent(s.user_agent) : 'Unknown device',
      ip: s.ip,
      method: s.method,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at ?? s.created_at,
    }));
  return c.json({
    email: user.email,
    hasPassword: hasPassword(user.id),
    twoStep: !!u.totp_enabled,
    recoveryCodesLeft: (JSON.parse(u.recovery_codes_json) as string[]).length,
    identities: db().all('SELECT provider, email, created_at AS createdAt FROM identities WHERE user_id = ?', user.id),
    providers: providerList(),
    sessions,
    events: recentEvents(user.id).map((e) => ({ kind: e.kind, detail: e.detail, at: e.at, device: e.user_agent ? describeAgent(e.user_agent) : '', ip: e.ip })),
  });
});

accountRoutes.post('/account/password', async (c) => {
  const user = c.get('user');
  const meta = requestMeta(c);
  if (!allow(`pw:${user.id}`, 10, 900_000)) return c.json({ error: 'Too many attempts. Please wait 15 minutes.' }, 429);
  const { current, next } = await c.req.json<{ current?: string; next: string }>();
  if (hasPassword(user.id) && !verifyUserPassword(user.id, String(current ?? ''))) return c.json({ error: 'Your current password isn’t right.' }, 401);
  const strength = checkPassword(String(next ?? ''), { email: user.email, name: user.name });
  if (!strength.ok) return c.json({ error: strength.problems[0], problems: strength.problems }, 400);
  setPassword(user.id, next);
  // Everyone else signed in as you is signed out.
  db().run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', user.id, user.sessionHash);
  audit(user.id, 'password_changed', 'other devices were signed out', meta);
  return c.json({ ok: true });
});

accountRoutes.post('/account/two-step/setup', (c) => {
  const user = c.get('user');
  const secret = newTotpSecret();
  db().run('UPDATE users SET totp_pending = ? WHERE id = ?', secret, user.id);
  return c.json({ secret, uri: otpauthUri(secret, user.email) });
});

accountRoutes.post('/account/two-step/enable', async (c) => {
  const user = c.get('user');
  const { code } = await c.req.json<{ code: string }>();
  const pending = db().get<{ totp_pending: string | null }>('SELECT totp_pending FROM users WHERE id = ?', user.id)?.totp_pending;
  if (!pending) return c.json({ error: 'Start setup again.' }, 400);
  const step = verifyTotp(pending, String(code ?? ''), now().getTime());
  if (step === null) return c.json({ error: 'That code didn’t match. Check the time on your phone and try the newest code.' }, 400);
  const codes = newRecoveryCodes();
  db().run(
    'UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?, recovery_codes_json = ? WHERE id = ?',
    pending,
    step,
    JSON.stringify(codes.map((x) => sha256Hex(x))),
    user.id,
  );
  audit(user.id, 'two_step_enabled', 'authenticator app', requestMeta(c));
  return c.json({ recoveryCodes: codes });
});

/** Turning protection off needs proof it's really you: a current code or your password. */
async function provesIdentity(userId: string, body: { code?: string; password?: string }): Promise<boolean> {
  if (body.password && verifyUserPassword(userId, body.password)) return true;
  const u = db().get<{ totp_secret: string | null; totp_last_step: number }>('SELECT totp_secret, totp_last_step FROM users WHERE id = ?', userId);
  if (body.code && u?.totp_secret) {
    const step = verifyTotp(u.totp_secret, body.code, now().getTime(), u.totp_last_step);
    if (step !== null) {
      db().run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, userId);
      return true;
    }
  }
  return false;
}

accountRoutes.post('/account/two-step/disable', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ code?: string; password?: string }>();
  if (!(await provesIdentity(user.id, body))) return c.json({ error: 'Enter a current code from your authenticator app, or your password.' }, 401);
  db().run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes_json = '[]' WHERE id = ?", user.id);
  audit(user.id, 'two_step_disabled', '', requestMeta(c));
  return c.json({ ok: true });
});

accountRoutes.post('/account/two-step/recovery-codes', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ code?: string; password?: string }>();
  if (!(await provesIdentity(user.id, body))) return c.json({ error: 'Enter a current code from your authenticator app, or your password.' }, 401);
  const codes = newRecoveryCodes();
  db().run('UPDATE users SET recovery_codes_json = ? WHERE id = ?', JSON.stringify(codes.map((x) => sha256Hex(x))), user.id);
  return c.json({ recoveryCodes: codes });
});

accountRoutes.delete('/account/sessions/:id', (c) => {
  const user = c.get('user');
  const prefix = c.req.param('id')!.replace(/[^0-9a-f]/g, '');
  if (prefix.length !== 16) return c.json({ error: 'Not found' }, 404);
  const row = db().get<{ token_hash: string; user_agent: string }>(
    'SELECT token_hash, user_agent FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?',
    user.id,
    prefix,
  );
  if (!row) return c.json({ error: 'Not found' }, 404);
  db().run('DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
  audit(user.id, 'session_revoked', describeAgent(row.user_agent), requestMeta(c));
  return c.json({ ok: true });
});

accountRoutes.post('/account/sessions/sign-out-others', (c) => {
  const user = c.get('user');
  const n = db().run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', user.id, user.sessionHash).changes;
  audit(user.id, 'session_revoked', `${n} other device${n === 1 ? '' : 's'}`, requestMeta(c));
  return c.json({ ok: true, signedOut: n });
});

/** Disconnect Google/Apple/Facebook, as long as another way to sign in remains. */
accountRoutes.delete('/account/identities/:provider', (c) => {
  const user = c.get('user');
  const provider = c.req.param('provider')!;
  const others = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM identities WHERE user_id = ? AND provider != ?', user.id, provider)!.n;
  if (!hasPassword(user.id) && others === 0) {
    return c.json({ error: 'Set a password first, so you can still sign in.' }, 409);
  }
  db().run('DELETE FROM identities WHERE user_id = ? AND provider = ?', user.id, provider);
  audit(user.id, 'identity_unlinked', isProvider(provider) ? PROVIDERS[provider].name : provider, requestMeta(c));
  return c.json({ ok: true });
});

