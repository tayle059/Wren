import { useEffect, useState } from 'react';
import { family } from '../api';
import { SocialButtons, useProviders } from './SocialButtons';

interface Strength {
  ok: boolean;
  score: number;
  problems: string[];
}

const STRENGTH_LABEL = ['Too weak', 'Weak', 'Okay', 'Strong', 'Very strong'];

export function Auth({
  onAuthed,
  initialError = '',
  initialChallenge = '',
  heading,
}: {
  onAuthed: () => void;
  initialError?: string;
  initialChallenge?: string;
  heading?: React.ReactNode;
}) {
  const providers = useProviders();
  const [mode, setMode] = useState<'login' | 'signup' | 'twoStep'>(initialChallenge ? 'twoStep' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState(initialChallenge);
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [strength, setStrength] = useState<Strength | null>(null);

  // Live password feedback while signing up.
  useEffect(() => {
    if (mode !== 'signup' || !password) return setStrength(null);
    const t = setTimeout(() => {
      family
        .post<Strength>('/auth/password-strength', { password, email, name })
        .then(setStrength)
        .catch(() => setStrength(null));
    }, 250);
    return () => clearTimeout(t);
  }, [mode, password, email, name]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'twoStep') {
        await family.post('/auth/two-step', { challenge, code });
        return onAuthed();
      }
      const res = await family.post<{ twoStep?: boolean; challenge?: string }>(mode === 'login' ? '/auth/login' : '/auth/signup', { name, email, password });
      if (res.twoStep && res.challenge) {
        setChallenge(res.challenge);
        setMode('twoStep');
        setCode('');
        return;
      }
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'twoStep') {
    return (
      <main className="auth">
        <form className="auth-card" onSubmit={submit}>
          <Brand />
          <h1>Two-step verification</h1>
          <p className="muted">
            {backup ? 'Enter one of the backup codes you saved when you turned on two-step verification.' : 'Open your authenticator app and enter the 6-digit code for Kindred.'}
          </p>
          <label className="field">
            {backup ? 'Backup code' : 'Code'}
            <input
              className={backup ? '' : 'code-input'}
              value={code}
              onChange={(e) => setCode(backup ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode={backup ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              autoFocus
              placeholder={backup ? 'xxxx-xxxx-xxxx' : '123456'}
              required
            />
          </label>
          {error && <p className="error-text" role="alert">{error}</p>}
          <button className="btn primary" disabled={busy || (!backup && code.length !== 6)}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button type="button" className="link-button" onClick={() => (setBackup(!backup), setCode(''))}>
            {backup ? 'Use my authenticator app' : 'Use a backup code instead'}
          </button>
          <button type="button" className="link-button" onClick={() => (setMode('login'), setError(''))}>
            Start over
          </button>
        </form>
      </main>
    );
  }

  const signup = mode === 'signup';
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <Brand />
        {heading}
        <h1>{signup ? 'Create your family account' : 'Welcome back'}</h1>
        <SocialButtons providers={providers} verb={signup ? 'Sign up' : 'Continue'} />
        {providers.length > 0 && <div className="divider"><span>or use email</span></div>}
        {signup && (
          <label className="field">
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          Password
          {signup && <small>At least 10 characters. A short phrase is easy to remember and hard to guess.</small>}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signup ? 'new-password' : 'current-password'}
            required
          />
        </label>
        {signup && strength && (
          <div className="strength" data-score={strength.score} aria-live="polite">
            <div className="strength-bar">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} data-on={i < Math.max(1, strength.score)} />
              ))}
            </div>
            <span className="strength-label">{strength.ok ? STRENGTH_LABEL[strength.score] : strength.problems[0]}</span>
          </div>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy || (signup && strength !== null && !strength.ok)}>
          {busy ? 'One moment…' : signup ? 'Create account' : 'Sign in'}
        </button>
        <button type="button" className="link-button" onClick={() => (setMode(signup ? 'login' : 'signup'), setError(''))}>
          {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
        <p className="fine-print">
          Your session is kept in a secure cookie and expires after 30 days without use. You can add two-step verification in Settings.
        </p>
      </form>
    </main>
  );
}

function Brand() {
  return (
    <a className="family-brand" href="#/">
      <span className="brand-mark" aria-hidden />
      <span>Kindred</span>
    </a>
  );
}
