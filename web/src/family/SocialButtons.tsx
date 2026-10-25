import { useEffect, useState } from 'react';
import { family } from '../api';

export interface ProviderInfo {
  id: 'google' | 'apple' | 'facebook';
  name: string;
  enabled: boolean;
}

export function useProviders() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    family
      .get<ProviderInfo[]>('/auth/providers')
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);
  return providers;
}

export function ProviderLogo({ id }: { id: ProviderInfo['id'] }) {
  if (id === 'google') {
    return (
      <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden>
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
    );
  }
  if (id === 'apple') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="currentColor">
        <path d="M16.37 12.6c-.02-2.34 1.92-3.47 2-3.52-1.09-1.6-2.79-1.82-3.39-1.84-1.44-.15-2.82.85-3.55.85-.74 0-1.87-.83-3.07-.81-1.58.02-3.04.92-3.85 2.33-1.65 2.86-.42 7.08 1.18 9.4.79 1.13 1.72 2.4 2.94 2.36 1.18-.05 1.63-.76 3.06-.76 1.43 0 1.83.76 3.08.73 1.27-.02 2.07-1.15 2.84-2.29.9-1.31 1.27-2.58 1.29-2.65-.03-.01-2.47-.95-2.5-3.77zM14.04 5.73c.65-.79 1.09-1.88.97-2.97-.94.04-2.08.63-2.75 1.41-.6.7-1.13 1.82-.99 2.89 1.05.08 2.12-.53 2.77-1.33z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="currentColor">
      <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
    </svg>
  );
}

/** Full-page redirects: the provider's sign-in page, then back to Kindred. */
export function SocialButtons({ providers, verb = 'Continue', link = false }: { providers: ProviderInfo[]; verb?: string; link?: boolean }) {
  const [note, setNote] = useState('');
  if (!providers.length) return null;
  return (
    <div className="social">
      {providers.map((p) => (
        <a
          key={p.id}
          className={`social-button ${p.id}`}
          href={`/api/auth/oauth/${p.id}/start${link ? '?link=1' : ''}`}
          aria-disabled={!p.enabled}
          onClick={(e) => {
            if (!p.enabled) {
              e.preventDefault();
              setNote(`${p.name} sign-in needs to be switched on by whoever runs this Kindred server (see the README).`);
            }
          }}
        >
          <ProviderLogo id={p.id} />
          <span>
            {verb} with {p.name}
          </span>
        </a>
      ))}
      {note && <p className="muted small social-note">{note}</p>}
    </div>
  );
}
