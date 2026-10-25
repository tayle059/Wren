import { useState } from 'react';
import { family, tokens } from './api';

export function Landing() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const tryDemo = async () => {
    setBusy(true);
    setError('');
    try {
      const { token } = await family.post<{ token: string }>('/auth/login', { email: 'sarah@kindred.demo', password: 'kindred-demo' });
      tokens.family = token;
      location.hash = '#/family';
    } catch {
      setError('The demo isn’t loaded on this server yet. Run "npm run seed" first.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="landing">
      <div className="landing-glow" aria-hidden />
      <header className="landing-head">
        <span className="brand-mark" aria-hidden />
        <span className="brand-name">Kindred</span>
      </header>
      <section className="landing-hero">
        <h1>
          A gentle companion for people living with dementia, and a window for the families who love them.
        </h1>
        <p>
          Wren talks, remembers, and keeps the day on track at home. It learns what brings your loved one joy and
          what calms them, keeps their stories, and tells you the moment something isn’t right.
        </p>
      </section>
      <section className="landing-choices">
        <a className="choice" href="#/family">
          <span className="choice-kicker">For family</span>
          <span className="choice-title">I’m family or a caregiver</span>
          <span className="choice-body">See how they’re doing, get alerts, and fill the memory book.</span>
        </a>
        <a className="choice" href="#/companion">
          <span className="choice-kicker">For the home</span>
          <span className="choice-title">This is the companion tablet</span>
          <span className="choice-body">Connect this tablet with a code from the family app.</span>
        </a>
      </section>
      <section className="landing-demo">
        <button className="demo-button" onClick={() => void tryDemo()} disabled={busy}>
          {busy ? 'Opening…' : 'Try the live demo with Rose and her family'}
        </button>
        {error && <p className="landing-error">{error}</p>}
        <p className="landing-fine">Built on Meta Muse Spark and Muse Voice Transcribe. Not a medical device or an emergency service.</p>
      </section>
    </main>
  );
}
