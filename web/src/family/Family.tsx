import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, family, pendingInvite } from '../api';
import { Auth } from './Auth';
import { Setup } from './Setup';
import { Home } from './Home';
import { Book } from './Book';
import { Memories } from './Memories';
import { Insights } from './Insights';
import { Settings } from './Settings';
import './family.css';

interface Me {
  user: { id: string; name: string; email: string };
  patients: { id: string; preferred_name: string; relationship: string }[];
}

interface Ctx {
  me: Me;
  pid: string;
  name: string;
  /** Bumps whenever something changes server-side; screens refetch on it. */
  version: number;
  refresh: () => void;
  toast: (text: string, level?: 'urgent' | 'fyi' | 'ok') => void;
}

const FamilyCtx = createContext<Ctx | null>(null);
export const useFamily = () => useContext(FamilyCtx)!;

/** Fetch helper that refetches when the shared version changes. */
export function useData<T>(path: string | null): { data: T | null; error: string; reload: () => void } {
  const { version } = useFamily();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    family
      .get<T>(path)
      .then((d) => live && (setData(d), setError('')))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [path, version, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

const TABS = [
  { path: '/family', label: 'Today', icon: '☀' },
  { path: '/family/book', label: 'Book', icon: '❦' },
  { path: '/family/memories', label: 'Memories', icon: '◎' },
  { path: '/family/insights', label: 'Insights', icon: '∿' },
  { path: '/family/settings', label: 'Settings', icon: '⚙' },
];

export function Family({ path }: { path: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<{ id: number; text: string; level: string }[]>([]);
  // Messages handed back by Google/Apple/Facebook sign-in, carried in the URL fragment.
  const [authError] = useState(() => decodeURIComponent(location.hash.match(/[?&]authError=([^&]+)/)?.[1] ?? ''));
  const [challenge] = useState(() => decodeURIComponent(location.hash.match(/[?&]twoStep=([^&]+)/)?.[1] ?? ''));

  const loadMe = useCallback(async () => {
    try {
      setMe(await family.get<Me>('/me'));
      setAuthed(true);
      // Finish joining a family circle that started before signing in.
      const invite = pendingInvite.get();
      if (invite) location.hash = `#/join?invite=${invite}`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
    if (/[?&](authError|twoStep|linked)=/.test(location.hash) && !location.hash.includes('/settings')) {
      history.replaceState(null, '', location.pathname + location.hash.replace(/\?.*$/, ''));
    }
  }, [loadMe]);

  const toast = useCallback((text: string, level: 'urgent' | 'fyi' | 'ok' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'urgent' ? 12000 : 6000);
  }, []);

  const pid = me?.patients[0]?.id;

  // Live updates while the app is open.
  useEffect(() => {
    if (!pid) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = family.events(`/patients/${pid}/events`);
      const bump = () => setVersion((v) => v + 1);
      es.addEventListener('alert', (e) => {
        const { alert } = JSON.parse((e as MessageEvent).data) as { alert: { level: 'urgent' | 'fyi'; reason: string } };
        toast(alert.reason, alert.level);
        bump();
      });
      for (const type of ['conversation_processed', 'story', 'nightly', 'memory_updated']) es.addEventListener(type, bump);
      es.addEventListener('device_paired', (e) => {
        const { name } = JSON.parse((e as MessageEvent).data) as { name: string };
        toast(`Tablet connected: ${name}.`);
        bump();
      });
      es.addEventListener('member_joined', (e) => {
        const { name } = JSON.parse((e as MessageEvent).data) as { name: string };
        toast(`${name} joined the family circle.`);
        bump();
      });
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
    };
  }, [pid, toast]);

  if (authed === null) return <div className="family-loading" />;
  if (!authed) return <Auth onAuthed={() => void loadMe()} initialError={authError} initialChallenge={challenge} />;
  if (!me) return <div className="family-loading" />;
  if (!pid) return <Setup onCreated={() => void loadMe()} />;

  const name = me.patients[0].preferred_name;
  const ctx: Ctx = { me, pid, name, version, refresh: () => setVersion((v) => v + 1), toast };
  const screen =
    path === '/family/book' ? <Book /> : path === '/family/memories' ? <Memories /> : path === '/family/insights' ? <Insights /> : path === '/family/settings' ? <Settings onSignOut={() => (setMe(null), setAuthed(false))} /> : <Home />;

  return (
    <FamilyCtx.Provider value={ctx}>
      <div className="family">
        <nav className="family-nav" aria-label="Sections">
          <a className="family-brand" href="#/family">
            <span className="brand-mark" aria-hidden />
            <span>Kindred</span>
          </a>
          {TABS.map((t) => (
            <a key={t.path} href={`#${t.path}`} className="tab" aria-current={path === t.path ? 'page' : undefined}>
              <span className="tab-icon" aria-hidden>
                {t.icon}
              </span>
              <span>{t.label}</span>
            </a>
          ))}
        </nav>
        <main className="family-main">{screen}</main>
        <div className="toasts" aria-live="assertive">
          {toasts.map((t) => (
            <div key={t.id} className="toast" data-level={t.level}>
              {t.level === 'urgent' ? <b>Urgent · </b> : null}
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </FamilyCtx.Provider>
  );
}
