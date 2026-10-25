import { useEffect, useState } from 'react';
import { family, tokens } from '../api';
import { useData, useFamily } from './Family';
import { PairDialog } from './PairDialog';
import { to12h } from './format';

interface Profile {
  preferredName: string;
  pronouns: string;
  companionName: string;
  timezone: string;
  about: string;
  whatWorks: string;
  speechPatienceMs: number;
  hasExitPin: boolean;
}

interface ScheduleItem {
  id: string;
  kind: string;
  label: string;
  time_of_day: string;
  calming: number;
  enabled: number;
}

export function Settings({ onSignOut }: { onSignOut: () => void }) {
  const { pid, name, toast, refresh } = useFamily();
  const { data: profile, reload } = useData<Profile>(`/patients/${pid}`);
  const { data: schedule, reload: reloadSchedule } = useData<ScheduleItem[]>(`/patients/${pid}/schedule`);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [pin, setPin] = useState('');
  const [pairOpen, setPairOpen] = useState(false);
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off' | 'unsupported'>('unknown');

  useEffect(() => setDraft(profile), [profile]);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPushState('unsupported');
    void navigator.serviceWorker.getRegistration().then(async (reg) => setPushState((await reg?.pushManager.getSubscription()) ? 'on' : 'off'));
  }, []);

  if (!draft) return <div className="screen-loading" />;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setDraft({ ...draft, [k]: v });

  const save = async () => {
    try {
      await family.patch(`/patients/${pid}`, { ...draft, exitPin: pin || undefined });
      setPin('');
      toast('Saved.');
      reload();
      refresh();
    } catch (e) {
      toast((e as Error).message, 'fyi');
    }
  };

  const enablePush = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('Notifications are blocked in your browser settings.', 'fyi');
      const { key } = await family.get<{ key: string }>('/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      await family.post('/push/subscribe', sub.toJSON());
      setPushState('on');
      toast('Alerts will now reach this phone.');
    } catch (e) {
      toast(`Couldn’t turn on notifications: ${(e as Error).message}`, 'fyi');
    }
  };

  const updateItem = async (id: string, patch: Partial<{ time: string; label: string; enabled: boolean }>) => {
    await family.patch(`/patients/${pid}/schedule/${id}`, patch);
    reloadSchedule();
    refresh();
  };

  const signOut = async () => {
    await family.post('/auth/logout').catch(() => {});
    tokens.family = null;
    onSignOut();
  };

  const runNightly = async () => {
    await family.post(`/patients/${pid}/nightly`);
    toast('Tonight’s reflection is done. See Today and Insights.');
    refresh();
  };

  return (
    <div className="screen settings">
      <header className="screen-head">
        <div>
          <p className="kicker">Settings</p>
          <h1>{name} and Wren</h1>
        </div>
      </header>

      <section className="card">
        <h2>Notifications</h2>
        {pushState === 'on' ? (
          <p>✓ Urgent alerts reach this device.</p>
        ) : pushState === 'unsupported' ? (
          <p className="muted">This browser can’t receive push notifications. On iPhone, add Kindred to your Home Screen first.</p>
        ) : (
          <button className="btn primary" onClick={() => void enablePush()}>
            Send alerts to this phone
          </button>
        )}
      </section>

      <section className="card">
        <h2>About {name}</h2>
        <label className="field">
          What the family wants Wren to know
          <small>Wren reads this before every conversation. Likes, dislikes, topics to avoid, what calms them.</small>
          <textarea value={draft.about} onChange={(e) => set('about', e.target.value)} rows={6} />
        </label>
        <label className="field">
          What works for {name}
          <small>
            Wren rewrites this every night from what it learns. Lines you end with <code>[family]</code> are always kept word for word.
          </small>
          <textarea value={draft.whatWorks} onChange={(e) => set('whatWorks', e.target.value)} rows={8} />
        </label>
        <div className="form-grid">
          <label className="field">
            Called
            <input value={draft.preferredName} onChange={(e) => set('preferredName', e.target.value)} />
          </label>
          <label className="field">
            Pronouns
            <select value={draft.pronouns} onChange={(e) => set('pronouns', e.target.value)}>
              <option>they/them</option>
              <option>she/her</option>
              <option>he/him</option>
            </select>
          </label>
          <label className="field">
            Companion’s name
            <input value={draft.companionName} onChange={(e) => set('companionName', e.target.value)} />
          </label>
          <label className="field">
            Time zone
            <input value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </label>
        </div>
        <label className="field">
          Patience when {name} pauses: {(draft.speechPatienceMs / 1000).toFixed(1)} seconds
          <small>How long Wren waits in silence before answering. Longer is kinder for slow or halting speech.</small>
          <input type="range" min={800} max={5000} step={100} value={draft.speechPatienceMs} onChange={(e) => set('speechPatienceMs', Number(e.target.value))} />
        </label>
        <label className="field">
          Tablet exit PIN {draft.hasExitPin && <small>(set; enter a new one to change it)</small>}
          <input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="4 to 8 digits" />
        </label>
        <button className="btn primary" onClick={() => void save()}>
          Save changes
        </button>
      </section>

      <section className="card">
        <h2>Daily rhythm</h2>
        <p className="muted small">Wren speaks first at these times. Calming time is best just before {name} usually gets restless.</p>
        <ul className="schedule-list">
          {(schedule ?? []).map((s) => (
            <li key={s.id} data-enabled={!!s.enabled}>
              <input
                type="time"
                value={s.time_of_day}
                onChange={(e) => void updateItem(s.id, { time: e.target.value })}
                aria-label={`Time for ${s.label}`}
              />
              <span>
                {s.label} <span className="muted small">· {s.kind === 'checkin' ? 'check-in' : s.kind}{s.calming ? ', calming' : ''}</span>
              </span>
              <label className="check">
                <input type="checkbox" checked={!!s.enabled} onChange={(e) => void updateItem(s.id, { enabled: e.target.checked })} /> On
              </label>
              <span className="sr-only">{to12h(s.time_of_day)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Tablet</h2>
        <button className="btn" onClick={() => setPairOpen(true)}>
          Connect a tablet
        </button>
      </section>

      <section className="card">
        <h2>Demo tools</h2>
        <p className="muted small">Wren reflects on the day automatically at 9 PM. Run it now to see tonight’s summary and updated notes.</p>
        <button className="btn" onClick={() => void runNightly()}>
          Run tonight’s reflection now
        </button>
      </section>

      <button className="btn danger" onClick={() => void signOut()}>
        Sign out
      </button>
      {pairOpen && <PairDialog onClose={() => setPairOpen(false)} />}
    </div>
  );
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
