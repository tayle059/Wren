import { useState } from 'react';
import { family } from '../api';

export function Setup({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({
    name: '',
    preferred_name: '',
    pronouns: 'they/them',
    relationship: '',
    birth_year: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    about: '',
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await family.post('/patients', { ...f, birth_year: f.birth_year ? Number(f.birth_year) : null });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="auth">
      <form className="auth-card wide" onSubmit={submit}>
        <h1>Who is Kindred for?</h1>
        <p className="muted">You can change all of this later. The more you share, the more personal the companion feels from day one.</p>
        <div className="form-grid">
          <label className="field">
            Full name
            <input value={f.name} onChange={set('name')} required placeholder="Rose Miller" />
          </label>
          <label className="field">
            What they like to be called
            <input value={f.preferred_name} onChange={set('preferred_name')} placeholder="Rose" />
          </label>
          <label className="field">
            Pronouns
            <select value={f.pronouns} onChange={set('pronouns')}>
              <option>they/them</option>
              <option>she/her</option>
              <option>he/him</option>
            </select>
          </label>
          <label className="field">
            You are their…
            <input value={f.relationship} onChange={set('relationship')} placeholder="Daughter" />
          </label>
          <label className="field">
            Year of birth
            <input value={f.birth_year} onChange={set('birth_year')} inputMode="numeric" placeholder="1944" />
          </label>
          <label className="field">
            Time zone
            <input value={f.timezone} onChange={set('timezone')} />
          </label>
        </div>
        <label className="field">
          About them
          <small>Where they grew up, work, what they love, what calms them, what to avoid, hearing or vision needs.</small>
          <textarea value={f.about} onChange={set('about')} rows={5} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary">Continue</button>
      </form>
    </main>
  );
}
