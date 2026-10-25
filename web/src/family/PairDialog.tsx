import { useEffect, useState } from 'react';
import { family } from '../api';
import { useFamily } from './Family';

export function PairDialog({ onClose }: { onClose: () => void }) {
  const { pid, name } = useFamily();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    family
      .post<{ code: string }>(`/patients/${pid}/pairing`)
      .then((r) => setCode(r.code))
      .catch((e) => setError((e as Error).message));
  }, [pid]);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal aria-labelledby="pair-title" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="pair-title">Connect {name}’s tablet</h2>
        <ol className="steps">
          <li>On the tablet, open this site and choose <b>This is the companion tablet</b>.</li>
          <li>Enter this code. It works once, for 15 minutes.</li>
        </ol>
        <p className="pair-code" aria-live="polite">
          {code ? `${code.slice(0, 3)} ${code.slice(3)}` : '…'}
        </p>
        {error && <p className="error-text">{error}</p>}
        <p className="muted small">
          Showing a demo on one computer? <a href={`#/companion?pair=${code}&demo`} target="_blank" rel="noreferrer">Open {name}’s tablet in a new tab</a>.
        </p>
        <div className="row end">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
