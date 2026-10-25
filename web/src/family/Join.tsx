import { useEffect, useState } from 'react';
import { ApiError, family, pendingInvite } from '../api';
import { Auth } from './Auth';
import './family.css';

interface Preview {
  valid: boolean;
  patientName?: string;
  inviterName?: string;
  relationship?: string;
}

/** #/join?invite=…: a family member's invitation to help care for someone. */
export function Join() {
  const token = location.hash.match(/[?&]invite=([\w-]+)/)?.[1] ?? '';
  const [preview, setPreview] = useState<Preview | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [relationship, setRelationship] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    family
      .get<Preview>(`/invites/${token}`)
      .then((p) => (setPreview(p), setRelationship(p.relationship ?? '')))
      .catch(() => setPreview({ valid: false }));
    family
      .get('/me')
      .then(() => setSignedIn(true))
      .catch((e) => setSignedIn(e instanceof ApiError && e.status === 401 ? false : null));
    // Survives a round trip through Google, Apple or Facebook.
    pendingInvite.set(token);
  }, [token]);

  const accept = async () => {
    try {
      await family.post(`/invites/${token}/accept`, { relationship });
      pendingInvite.set(null);
      location.hash = '#/family';
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!preview || signedIn === null) return <div className="family-loading" />;
  if (!preview.valid) {
    return (
      <main className="auth">
        <div className="auth-card">
          <h1>This invitation has expired</h1>
          <p className="muted">Invitations work once, for 7 days. Ask the person who sent it for a new one.</p>
          <a className="btn" href="#/">Go to Kindred</a>
        </div>
      </main>
    );
  }

  const banner = (
    <div className="invite-banner">
      <span className="brand-mark" aria-hidden />
      <p>
        <b>{preview.inviterName}</b> invited you to help care for <b>{preview.patientName}</b> with Kindred.
      </p>
    </div>
  );

  if (!signedIn) return <Auth heading={banner} onAuthed={() => setSignedIn(true)} />;

  return (
    <main className="auth">
      <div className="auth-card">
        {banner}
        <h1>Join {preview.patientName}’s circle</h1>
        <p className="muted">
          You’ll see alerts and daily updates, add to the memory book, and be able to reach out through {preview.patientName}’s tablet.
        </p>
        <label className="field">
          You are {preview.patientName}’s…
          <input value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="Son, niece, neighbor, caregiver…" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" onClick={() => void accept()}>
          Join
        </button>
      </div>
    </main>
  );
}
