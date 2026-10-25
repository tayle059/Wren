import { useEffect, useState } from 'react';
import { family } from '../api';
import { useData, useFamily } from './Family';
import { QrCode } from '../shared/QrCode';
import { ProviderLogo, type ProviderInfo } from './SocialButtons';
import { timeAgo } from './format';

interface SecurityData {
  email: string;
  hasPassword: boolean;
  twoStep: boolean;
  recoveryCodesLeft: number;
  identities: { provider: string; email: string; createdAt: string }[];
  providers: ProviderInfo[];
  sessions: { id: string; current: boolean; device: string; ip: string; method: string; createdAt: string; lastUsedAt: string }[];
  events: { kind: string; detail: string; at: string; device: string; ip: string }[];
}

const EVENT_LABEL: Record<string, string> = {
  account_created: 'Account created',
  sign_in: 'Signed in',
  sign_in_failed: 'Failed sign-in attempt',
  account_locked: 'Account paused after wrong passwords',
  two_step_enabled: 'Two-step verification turned on',
  two_step_disabled: 'Two-step verification turned off',
  recovery_code_used: 'Backup code used',
  password_changed: 'Password changed',
  identity_linked: 'Sign-in method connected',
  identity_unlinked: 'Sign-in method removed',
  session_revoked: 'Signed out a device',
  tablet_connected: 'Tablet connected',
  tablet_removed: 'Tablet disconnected',
  invite_created: 'Invitation created',
  member_joined: 'Joined a family circle',
  member_removed: 'Family circle changed',
};

const WARN = new Set(['sign_in_failed', 'account_locked', 'two_step_disabled', 'recovery_code_used']);

export function Security() {
  const { toast } = useFamily();
  const { data, reload } = useData<SecurityData>('/account/security');
  const [linked] = useState(() => location.hash.match(/[?&]linked=(\w+)/)?.[1]);
  const [linkError] = useState(() => decodeURIComponent(location.hash.match(/[?&]authError=([^&]+)/)?.[1] ?? ''));

  useEffect(() => {
    if (linked) toast('Sign-in method connected.');
    if (linkError) toast(linkError, 'fyi');
    if (linked || linkError) history.replaceState(null, '', location.pathname + '#/family/settings');
  }, [linked, linkError, toast]);

  if (!data) return null;
  return (
    <>
      <TwoStep data={data} onChange={reload} />
      <Password data={data} onChange={reload} />
      <SignInMethods data={data} onChange={reload} />
      <Sessions data={data} onChange={reload} />
      <section className="card">
        <h2>Recent account activity</h2>
        <p className="muted small">If something here wasn’t you, change your password and sign out other devices.</p>
        <ul className="activity">
          {data.events.map((e, i) => (
            <li key={i} data-warn={WARN.has(e.kind)}>
              <span className="activity-what">
                <b>{EVENT_LABEL[e.kind] ?? e.kind}</b>
                {e.detail && <span className="muted"> · {e.detail}</span>}
              </span>
              <span className="muted small">
                {timeAgo(e.at)}
                {e.device ? ` · ${e.device}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function TwoStep({ data, onChange }: { data: SecurityData; onChange: () => void }) {
  const { toast } = useFamily();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [proof, setProof] = useState<'off' | 'codes' | null>(null);
  const [error, setError] = useState('');

  const begin = async () => {
    setError('');
    setSetup(await family.post('/account/two-step/setup'));
  };
  const enable = async () => {
    try {
      const r = await family.post<{ recoveryCodes: string[] }>('/account/two-step/enable', { code });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const confirmProof = async () => {
    const body = /^\d{6}$/.test(code) ? { code } : { password: code };
    try {
      if (proof === 'off') {
        await family.post('/account/two-step/disable', body);
        toast('Two-step verification is off.', 'fyi');
      } else {
        const r = await family.post<{ recoveryCodes: string[] }>('/account/two-step/recovery-codes', body);
        setCodes(r.recoveryCodes);
      }
      setProof(null);
      setCode('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const download = () => {
    const text = `Kindred backup codes for ${data.email}\nEach code works once.\n\n${codes!.join('\n')}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'kindred-backup-codes.txt';
    a.click();
  };

  return (
    <section className="card" id="security">
      <div className="card-head">
        <h2>Two-step verification</h2>
        <span className="status" data-tone={data.twoStep ? 'good' : 'fyi'}>
          {data.twoStep ? 'On' : 'Off'}
        </span>
      </div>
      <p className="muted small">
        Protects alerts and family memories even if your password is stolen. Signing in asks for a code from an authenticator app like Google
        Authenticator, Microsoft Authenticator or 1Password.
      </p>

      {codes && (
        <div className="codes">
          <p>
            <b>Save these backup codes.</b> Each one gets you in once if you lose your phone. You won’t see them again.
          </p>
          <ol className="code-grid">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="row">
            <button className="btn small" onClick={download}>
              Download
            </button>
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Copied.'))}>
              Copy
            </button>
            <button className="btn primary small" onClick={() => setCodes(null)}>
              I’ve saved them
            </button>
          </div>
        </div>
      )}

      {!data.twoStep && !setup && !codes && (
        <button className="btn primary" onClick={() => void begin()}>
          Turn on two-step verification
        </button>
      )}

      {setup && (
        <div className="setup-2fa">
          <QrCode value={setup.uri} size={180} label="QR code for your authenticator app" />
          <div className="setup-steps">
            <ol className="steps">
              <li>In your authenticator app, add an account and scan this code.</li>
              <li>
                Can’t scan? Enter this key: <code className="secret">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
              </li>
              <li>Type the 6-digit code it shows:</li>
            </ol>
            <div className="copy-row">
              <input className="code-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" aria-label="Code" />
              <button className="btn primary small" disabled={code.length !== 6} onClick={() => void enable()}>
                Turn on
              </button>
            </div>
            {error && <p className="error-text">{error}</p>}
            <button className="link-button" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {data.twoStep && !codes && !proof && (
        <div className="row">
          <span className="muted small">{data.recoveryCodesLeft} backup codes left.</span>
          <button className="btn small" onClick={() => (setProof('codes'), setError(''), setCode(''))}>
            New backup codes
          </button>
          <button className="btn small danger" onClick={() => (setProof('off'), setError(''), setCode(''))}>
            Turn off
          </button>
        </div>
      )}

      {proof && (
        <div className="copy-row">
          <input
            type={/^\d{0,6}$/.test(code) ? 'text' : 'password'}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={data.hasPassword ? 'Code from your app, or your password' : 'Code from your app'}
            aria-label="Confirm it's you"
            autoFocus
          />
          <button className={`btn small ${proof === 'off' ? 'danger' : 'primary'}`} onClick={() => void confirmProof()}>
            Confirm
          </button>
          <button className="btn small" onClick={() => setProof(null)}>
            Cancel
          </button>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </section>
  );
}

function Password({ data, onChange }: { data: SecurityData; onChange: () => void }) {
  const { toast } = useFamily();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await family.post('/account/password', { current, next });
      toast('Password saved. Other devices were signed out.');
      setOpen(false);
      setCurrent('');
      setNext('');
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Password</h2>
        {!open && (
          <button className="btn small" onClick={() => (setOpen(true), setError(''))}>
            {data.hasPassword ? 'Change password' : 'Set a password'}
          </button>
        )}
      </div>
      {!data.hasPassword && !open && <p className="muted small">You sign in with Google, Apple or Facebook. A password gives you another way in.</p>}
      {open && (
        <form className="stack" onSubmit={save}>
          {data.hasPassword && (
            <label className="field">
              Current password
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
            </label>
          )}
          <label className="field">
            New password
            <small>At least 10 characters, and not a common password.</small>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          </label>
          {error && <p className="error-text">{error}</p>}
          <div className="row">
            <button className="btn primary small">Save password</button>
            <button type="button" className="btn small" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function SignInMethods({ data, onChange }: { data: SecurityData; onChange: () => void }) {
  const { toast } = useFamily();
  const disconnect = async (provider: string) => {
    try {
      await family.del(`/account/identities/${provider}`);
      onChange();
    } catch (e) {
      toast((e as Error).message, 'fyi');
    }
  };
  return (
    <section className="card">
      <h2>Ways to sign in</h2>
      <ul className="list">
        <li>
          <span className="method-icon" aria-hidden>
            ✉
          </span>
          <span className="list-main">
            <b>Email and password</b>
            <span className="muted small">{data.hasPassword ? data.email : 'No password set'}</span>
          </span>
        </li>
        {data.providers.map((p) => {
          const id = data.identities.find((i) => i.provider === p.id);
          return (
            <li key={p.id}>
              <span className="method-icon" aria-hidden>
                <ProviderLogo id={p.id} />
              </span>
              <span className="list-main">
                <b>{p.name}</b>
                <span className="muted small">{id ? `Connected${id.email ? ` · ${id.email}` : ''}` : p.enabled ? 'Not connected' : 'Not available on this server yet'}</span>
              </span>
              {id ? (
                <button className="btn small" onClick={() => void disconnect(p.id)}>
                  Disconnect
                </button>
              ) : (
                p.enabled && (
                  <a className="btn small" href={`/api/auth/oauth/${p.id}/start?link=1`}>
                    Connect
                  </a>
                )
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Sessions({ data, onChange }: { data: SecurityData; onChange: () => void }) {
  const { toast } = useFamily();
  const signOut = async (id: string) => {
    await family.del(`/account/sessions/${id}`);
    onChange();
  };
  const others = async () => {
    const r = await family.post<{ signedOut: number }>('/account/sessions/sign-out-others');
    toast(`Signed out ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}.`);
    onChange();
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Where you’re signed in</h2>
        {data.sessions.length > 1 && (
          <button className="btn small" onClick={() => void others()}>
            Sign out everywhere else
          </button>
        )}
      </div>
      <ul className="list">
        {data.sessions.map((s) => (
          <li key={s.id}>
            <span className="dot" data-on={s.current} aria-hidden />
            <span className="list-main">
              <b>
                {s.device}
                {s.current && <span className="tag">This device</span>}
              </b>
              <span className="muted small">
                Signed in {timeAgo(s.createdAt)} with {s.method === 'password' ? 'a password' : s.method} · active {timeAgo(s.lastUsedAt)}
              </span>
            </span>
            {!s.current && (
              <button className="btn small" onClick={() => void signOut(s.id)}>
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
