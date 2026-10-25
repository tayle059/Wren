import { useEffect, useRef, useState } from 'react';
import { family } from '../api';
import { useFamily } from './Family';
import { QrCode } from '../shared/QrCode';

interface Pairing {
  code: string;
  expiresAt: string;
  url: string;
}

/**
 * Connect a tablet: point its camera at the QR code and it opens Kindred,
 * already connected. The 6-digit code is there for tablets without a camera.
 */
export function PairDialog({ onClose }: { onClose: () => void }) {
  const { pid, name } = useFamily();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(0);
  const [connected, setConnected] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const fresh = () => {
    setError('');
    family
      .post<Pairing>(`/patients/${pid}/pairing`)
      .then(setPairing)
      .catch((e) => setError((e as Error).message));
  };
  useEffect(fresh, [pid]);

  // Countdown, and a fresh code when this one runs out.
  useEffect(() => {
    if (!pairing) return;
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(pairing.expiresAt) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) fresh();
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing]);

  // Watch for the new tablet to appear.
  useEffect(() => {
    if (connected) return;
    const check = async () => {
      const devices = await family.get<{ id: string; name: string }[]>(`/patients/${pid}/devices`).catch(() => null);
      if (!devices) return;
      if (!known.current) known.current = new Set(devices.map((d) => d.id));
      const added = devices.find((d) => !known.current!.has(d.id));
      if (added) setConnected(added.name);
    };
    void check();
    const t = setInterval(() => void check(), 2500);
    return () => clearInterval(t);
  }, [pid, connected]);

  const mins = Math.floor(left / 60);
  const secs = String(left % 60).padStart(2, '0');

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal aria-labelledby="pair-title" onClick={onClose}>
      <div className="dialog pair-dialog" onClick={(e) => e.stopPropagation()}>
        {connected ? (
          <div className="pair-done">
            <span className="pair-check" aria-hidden>
              ✓
            </span>
            <h2 id="pair-title">{name}’s tablet is connected</h2>
            <p className="muted">{connected}. Tap “Wake Wren” on the tablet, and you’re all set.</p>
            <p className="muted small">Tip: turn on Guided Access (iPad) or screen pinning (Android) so the tablet stays in Kindred.</p>
            <div className="row end">
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 id="pair-title">Connect {name}’s tablet</h2>
            <div className="pair-body">
              <div className="pair-qr">
                {pairing ? <QrCode value={pairing.url} size={200} label={`QR code to connect ${name}'s tablet`} /> : <div className="qr" style={{ width: 200, height: 200 }} />}
              </div>
              <ol className="steps">
                <li>
                  Open the <b>Camera</b> on {name}’s tablet and point it at this code.
                </li>
                <li>Tap the link that appears. Kindred opens, already connected.</li>
              </ol>
            </div>
            <div className="pair-or">
              <span>No camera? On the tablet, open this website, choose “This is the companion tablet”, and enter:</span>
              <p className="pair-code" aria-live="polite">
                {pairing ? `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}` : '…'}
              </p>
            </div>
            <p className="muted small center">
              Works once. {pairing && left > 0 ? `New code in ${mins}:${secs}.` : ''}{' '}
              {pairing && (
                <a href={`#/companion?pair=${pairing.code}&demo`} target="_blank" rel="noreferrer">
                  Demo on this computer
                </a>
              )}
            </p>
            {error && <p className="error-text">{error}</p>}
            <div className="row end">
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
