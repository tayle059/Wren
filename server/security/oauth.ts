// Sign in with Google, Apple and Facebook (OAuth 2.0 authorization code flow).
// Each provider turns on when its keys are set in the environment.
import { createHash, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { now, nowIso } from '../util/time.ts';

export type ProviderId = 'google' | 'apple' | 'facebook';

export interface Profile {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

interface Provider {
  id: ProviderId;
  name: string;
  enabled: () => boolean;
  authUrl: (p: { state: string; nonce: string; challenge: string; redirectUri: string }) => string;
  exchange: (p: { code: string; verifier: string; nonce: string; redirectUri: string; extra: Record<string, string> }) => Promise<Profile>;
}

const env = process.env;
const FB_VERSION = env.FACEBOOK_GRAPH_VERSION ?? 'v23.0';

export const redirectUri = (id: ProviderId) => `${config.publicUrl}/api/auth/oauth/${id}/callback`;

/** Reads the claims of an ID token received directly from the provider's token endpoint over TLS. */
export function decodeJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  if (!payload) throw new Error('Malformed ID token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

function checkIdToken(claims: Record<string, unknown>, issuers: string[], audience: string, nonce: string) {
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!issuers.includes(String(claims.iss))) throw new Error('ID token from an unexpected issuer');
  if (!aud.includes(audience)) throw new Error('ID token for a different app');
  if (Number(claims.exp) * 1000 < now().getTime()) throw new Error('ID token expired');
  if (claims.nonce !== undefined && claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
}

/** Apple's client secret is a short-lived ES256 JWT signed with your Sign in with Apple key. */
export function appleClientSecret(): string {
  const header = { alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' };
  const iat = Math.floor(now().getTime() / 1000);
  const payload = { iss: env.APPLE_TEAM_ID, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID };
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(header)}.${enc(payload)}`;
  const key = createPrivateKey((env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'));
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  google: {
    id: 'google',
    name: 'Google',
    enabled: () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authUrl: ({ state, nonce, challenge, redirectUri }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })}`,
    exchange: async ({ code, verifier, nonce, redirectUri }) => {
      const tok = await postForm('https://oauth2.googleapis.com/token', {
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      });
      const claims = decodeJwt(String(tok.id_token ?? ''));
      checkIdToken(claims, ['https://accounts.google.com', 'accounts.google.com'], env.GOOGLE_CLIENT_ID!, nonce);
      return {
        subject: String(claims.sub),
        email: String(claims.email ?? ''),
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        name: String(claims.name ?? ''),
      };
    },
  },
  apple: {
    id: 'apple',
    name: 'Apple',
    enabled: () => !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
    authUrl: ({ state, nonce, redirectUri }) =>
      `https://appleid.apple.com/auth/authorize?${new URLSearchParams({
        client_id: env.APPLE_CLIENT_ID!,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'form_post', // required by Apple when asking for name and email
        scope: 'name email',
        state,
        nonce,
      })}`,
    exchange: async ({ code, nonce, redirectUri, extra }) => {
      const tok = await postForm('https://appleid.apple.com/auth/token', {
        code,
        client_id: env.APPLE_CLIENT_ID!,
        client_secret: appleClientSecret(),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const claims = decodeJwt(String(tok.id_token ?? ''));
      checkIdToken(claims, ['https://appleid.apple.com'], env.APPLE_CLIENT_ID!, nonce);
      // Apple sends the person's name only the very first time, alongside the code.
      let name = '';
      try {
        const user = JSON.parse(extra.user ?? '{}') as { name?: { firstName?: string; lastName?: string } };
        name = [user.name?.firstName, user.name?.lastName].filter(Boolean).join(' ');
      } catch {
        // No name supplied; we'll use the email.
      }
      return {
        subject: String(claims.sub),
        email: String(claims.email ?? ''),
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        name,
      };
    },
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook',
    enabled: () => !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET),
    authUrl: ({ state, challenge, redirectUri }) =>
      `https://www.facebook.com/${FB_VERSION}/dialog/oauth?${new URLSearchParams({
        client_id: env.FACEBOOK_APP_ID!,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'email,public_profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    exchange: async ({ code, verifier, redirectUri }) => {
      const tok = await postForm(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token`, {
        code,
        client_id: env.FACEBOOK_APP_ID!,
        client_secret: env.FACEBOOK_APP_SECRET!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const access = String(tok.access_token ?? '');
      // appsecret_proof proves the call comes from our server, not a stolen token.
      const appsecretProof = createHmac('sha256', env.FACEBOOK_APP_SECRET!).update(access).digest('hex');
      const res = await fetch(
        `https://graph.facebook.com/${FB_VERSION}/me?${new URLSearchParams({ fields: 'id,name,email', access_token: access, appsecret_proof: appsecretProof })}`,
        { signal: AbortSignal.timeout(15000) },
      );
      const me = (await res.json()) as { id?: string; name?: string; email?: string };
      if (!res.ok || !me.id) throw new Error('Could not read the Facebook profile');
      // Facebook only shares confirmed email addresses.
      return { subject: me.id, email: me.email ?? '', emailVerified: !!me.email, name: me.name ?? '' };
    },
  },
};

export const isProvider = (id: string): id is ProviderId => id in PROVIDERS;

export function providerList() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, enabled: p.enabled() }));
}

// ---------- State: one-time, bound to the browser that started the flow ----------

const STATE_MS = 10 * 60 * 1000;
const b64url = (b: Buffer) => b.toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function beginFlow(provider: ProviderId, linkUserId: string | null) {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  const browser = b64url(randomBytes(24));
  db().run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso());
  db().run(
    'INSERT INTO oauth_states (state, provider, verifier, nonce, browser_hash, link_user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    state,
    provider,
    verifier,
    nonce,
    sha(browser),
    linkUserId,
    new Date(now().getTime() + STATE_MS).toISOString(),
  );
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const url = PROVIDERS[provider].authUrl({ state, nonce, challenge, redirectUri: redirectUri(provider) });
  return { url, browser };
}

/** Single use: the state row is deleted whether or not it matches. */
export function finishFlow(provider: ProviderId, state: string, browser: string | undefined) {
  const row = db().get<{ provider: string; verifier: string; nonce: string; browser_hash: string; link_user_id: string | null; expires_at: string }>(
    'SELECT * FROM oauth_states WHERE state = ?',
    state,
  );
  db().run('DELETE FROM oauth_states WHERE state = ?', state);
  if (!row || row.provider !== provider || row.expires_at < nowIso()) return null;
  if (!browser || sha(browser) !== row.browser_hash) return null; // stops login CSRF
  return { verifier: row.verifier, nonce: row.nonce, linkUserId: row.link_user_id };
}
