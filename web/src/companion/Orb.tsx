import type { CSSProperties } from 'react';
import type { Phase } from './conversation';
import type { Mode } from '../api';

/** The companion's presence: a soft, breathing light whose motion shows what it's doing. */
export function Orb({ phase, mode, level, onTap, label }: { phase: Phase; mode: Mode; level: number; onTap: () => void; label: string }) {
  const style = { '--level': phase === 'hearing' ? level.toFixed(2) : '0' } as CSSProperties;
  return (
    <button className="orb" data-phase={phase} data-mode={mode} style={style} onClick={onTap} aria-label={label}>
      <span className="orb-halo" />
      <span className="orb-ring" />
      <span className="orb-core">
        <span className="orb-swirl" />
        <span className="orb-shine" />
      </span>
    </button>
  );
}
