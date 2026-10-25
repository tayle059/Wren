import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** A crisp, scannable QR code. Rendered locally; the link never goes to a QR service. */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2a2420', light: '#ffffff' } })
      .then((svg) => live && setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [value]);
  return (
    <div className="qr" style={{ width: size, height: size }}>
      {src ? <img src={src} width={size} height={size} alt={label} /> : <span className="qr-placeholder" />}
    </div>
  );
}
