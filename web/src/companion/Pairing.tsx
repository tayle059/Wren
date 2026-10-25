import { useState } from 'react';
import { device, tokens } from '../api';

export function Pairing({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token } = await device.post<{ token: string }>('/pair', { code });
      tokens.device = token;
      onPaired();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pairing">
      <form onSubmit={submit} className="pairing-card">
        <h1>Set up this tablet</h1>
        <p>In the Kindred app on a family member’s phone, open <b>Settings → Connect a tablet</b> and enter the 6-digit code here.</p>
        <input
          className="pairing-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="••••••"
          aria-label="Pairing code"
          autoFocus
        />
        {error && <p className="pairing-error" role="alert">{error}</p>}
        <button className="big-button" disabled={code.length !== 6 || busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <a className="pairing-back" href="#/">Back</a>
      </form>
    </main>
  );
}
