import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, device, tokens } from '../api';
import { Conversation, type OpenPlan, type SttMode } from './conversation';
import { Orb } from './Orb';
import { Pairing } from './Pairing';
import { unlockAudio } from './speech';
import './companion.css';

interface DeviceState {
  patient: { name: string; companionName: string; timezone: string; speechPatienceMs: number; hasExitPin: boolean };
  voiceNotes: { id: string; from: string; url: string }[];
  stt: SttMode;
  brain: 'muse' | 'offline';
}

type Part = 'morning' | 'afternoon' | 'evening' | 'night';

function useClock(tz: string | undefined) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => {
    const timeZone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...o }).format(now);
    const hour = Number(f({ hour: 'numeric', hourCycle: 'h23' }));
    const part: Part = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
    return {
      weekday: f({ weekday: 'long' }),
      date: f({ month: 'long', day: 'numeric', year: 'numeric' }),
      time: f({ hour: 'numeric', minute: '2-digit' }),
      part,
    };
  }, [now, tz]);
}

const PHASE_HINT: Record<string, (c: string) => string> = {
  idle: () => '',
  inviting: (c) => `${c} would like to talk`,
  speaking: (c) => `${c} is talking`,
  listening: () => 'I’m listening',
  hearing: () => 'I’m listening',
  thinking: () => 'Thinking…',
  playing: () => 'Playing',
};

export function Companion() {
  const [state, setState] = useState<DeviceState | null>(null);
  const [paired, setPaired] = useState(!!tokens.device);
  const [awake, setAwake] = useState(false);
  const [offline, setOffline] = useState(false);
  const conv = useRef<Conversation | null>(null);
  const demo = useMemo(() => /[?&]demo\b/.test(location.hash + location.search), []);

  const load = useCallback(async () => {
    try {
      const s = await device.get<DeviceState>('/state');
      setState(s);
      setOffline(false);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        tokens.device = null;
        setPaired(false);
      } else setOffline(true);
      return null;
    }
  }, []);

  useEffect(() => {
    if (paired) void load();
  }, [paired, load]);

  // A family member can open this screen with a one-time code in the link (#/companion?pair=123456).
  useEffect(() => {
    const code = location.hash.match(/[?&]pair=(\d{6})/)?.[1];
    if (!code) return;
    void device
      .post<{ token: string }>('/pair', { code })
      .then(({ token }) => {
        tokens.device = token;
        location.hash = location.hash.replace(/([?&])pair=\d{6}&?/, '$1').replace(/[?&]$/, '');
        setPaired(true);
        void load();
      })
      .catch(() => {});
  }, [load]);

  // One conversation controller for the life of the screen.
  if (state && !conv.current) {
    conv.current = new Conversation({ stt: state.stt, patienceMs: state.patient.speechPatienceMs, patientName: state.patient.name });
  }
  useEffect(() => {
    if (state) conv.current?.configure({ stt: state.stt, patienceMs: state.patient.speechPatienceMs, patientName: state.patient.name });
  }, [state]);

  // Live events: scheduled invites and voice notes. Reconnects on its own.
  useEffect(() => {
    if (!awake || !paired) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = device.events();
      es.addEventListener('invite', (e) => {
        const { invite } = JSON.parse((e as MessageEvent).data) as { invite: OpenPlan & { kind: OpenPlan['kind'] } };
        void conv.current?.open({ kind: invite.kind, scheduleItemId: invite.scheduleItemId ?? undefined, calming: invite.calming });
      });
      es.addEventListener('voice_note', (e) => {
        const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
        void conv.current?.open({ kind: 'voice_note', voiceNoteId: id });
      });
      es.onopen = () => setOffline(false);
      es.onerror = () => {
        setOffline(true);
        es?.close();
        retry = setTimeout(connect, 5000);
      };
    };
    connect();
    const beat = setInterval(() => void device.post('/heartbeat').catch(() => setOffline(true)), 60000);
    const refresh = setInterval(() => void load(), 5 * 60000);
    return () => {
      es?.close();
      clearTimeout(retry);
      clearInterval(beat);
      clearInterval(refresh);
    };
  }, [awake, paired, load]);

  // Keep the screen on while the companion is awake.
  useEffect(() => {
    if (!awake || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const request = () => void navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {});
    request();
    const onVis = () => document.visibilityState === 'visible' && request();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, [awake]);

  if (!paired) return <Pairing onPaired={() => setPaired(true)} />;
  if (!state || !conv.current) {
    return <main className="companion" data-part="morning"><div className="companion-loading">{offline ? 'Reconnecting…' : ''}</div></main>;
  }

  const wake = async () => {
    unlockAudio();
    setAwake(true);
    const s = await load();
    const note = s?.voiceNotes[0];
    if (note) void conv.current?.open({ kind: 'voice_note', voiceNoteId: note.id });
  };

  return (
    <CompanionScreen
      conv={conv.current}
      state={state}
      awake={awake}
      offline={offline}
      demo={demo}
      onWake={wake}
      onUnpaired={() => {
        tokens.device = null;
        setPaired(false);
        setState(null);
        conv.current = null;
      }}
    />
  );
}

function CompanionScreen({
  conv,
  state,
  awake,
  offline,
  demo,
  onWake,
  onUnpaired,
}: {
  conv: Conversation;
  state: DeviceState;
  awake: boolean;
  offline: boolean;
  demo: boolean;
  onWake: () => void;
  onUnpaired: () => void;
}) {
  const ui = useSyncExternalStore(conv.subscribe, conv.getSnapshot);
  const clock = useClock(state.patient.timezone);
  const companion = state.patient.companionName;
  const [exitOpen, setExitOpen] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startHold = () => {
    holdTimer.current = setTimeout(() => setExitOpen(true), 3000);
  };
  const endHold = () => holdTimer.current && clearTimeout(holdTimer.current);

  const talkLabel =
    ui.phase === 'idle' ? `Talk with ${companion}` : ui.phase === 'speaking' ? 'Tap to interrupt' : ui.phase === 'playing' ? 'Stop the music' : 'I’m listening…';

  return (
    <main className="companion" data-part={clock.part} data-mode={ui.mode} data-phase={ui.phase}>
      <div className="sky" aria-hidden />
      <div
        className="exit-corner"
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        aria-hidden
      />

      <header className="orientation" aria-live="polite">
        <p className="orientation-greeting">
          It’s <strong>{clock.weekday}</strong> {clock.part === 'night' ? 'night' : clock.part}
        </p>
        <p className="orientation-date">{clock.date}</p>
        <p className="orientation-time">{clock.time}</p>
      </header>

      <section className="presence">
        <Orb phase={ui.phase} mode={ui.mode} level={ui.level} onTap={() => void conv.talk()} label={talkLabel} />
        <p className="phase-hint">{PHASE_HINT[ui.phase]?.(companion)}</p>
        <div className="captions" aria-live="assertive">
          {ui.caption && <p className="caption">{ui.caption}</p>}
          {ui.heard && (ui.phase === 'hearing' || ui.phase === 'thinking') && <p className="heard">“{ui.heard}”</p>}
          {ui.nowPlaying && <p className="now-playing">♪ {ui.nowPlaying}</p>}
        </div>
      </section>

      {ui.photo && (
        <figure className="photo-card" key={ui.photo.id} onClick={() => conv.dismissPhoto()}>
          <img src={ui.photo.url} alt={ui.photo.caption} />
          <figcaption>{ui.photo.caption}</figcaption>
        </figure>
      )}

      {ui.reminder && (
        <section className="reminder-card" aria-label={ui.reminder.label}>
          {ui.reminder.url && <img src={ui.reminder.url} alt="" />}
          <h2>{ui.reminder.label}</h2>
          <div className="reminder-buttons">
            <button className="big-button yes" onClick={() => void conv.answerReminder('confirmed')}>
              I took it
            </button>
            <button className="big-button soft" onClick={() => void conv.answerReminder('not_yet')}>
              Not yet
            </button>
          </div>
        </section>
      )}

      <footer className="talk-bar">
        <button className="big-button talk" data-active={ui.phase !== 'idle'} onClick={() => void conv.talk()}>
          {talkLabel}
        </button>
        {ui.micError && <p className="mic-error">{ui.micError}</p>}
        {offline && <p className="offline-note">Reconnecting…</p>}
      </footer>

      {demo && <DemoDirector conv={conv} brain={state.brain} stt={state.stt} />}

      {!awake && (
        <button className="wake" onClick={onWake}>
          <span className="wake-orb" />
          <span className="wake-text">Tap to wake {companion}</span>
        </button>
      )}

      {exitOpen && <ExitDialog hasPin={state.patient.hasExitPin} onClose={() => setExitOpen(false)} onExited={onUnpaired} />}
    </main>
  );
}

function ExitDialog({ hasPin, onClose, onExited }: { hasPin: boolean; onClose: () => void; onExited: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      await device.post('/exit', { pin });
      onExited();
    } catch {
      setError('That PIN isn’t right.');
    }
  };
  return (
    <div className="exit-dialog" role="dialog" aria-modal>
      <div className="exit-card">
        <h2>Family settings</h2>
        <p>{hasPin ? 'Enter the family PIN to disconnect this tablet.' : 'Disconnect this tablet from Kindred?'}</p>
        {hasPin && <input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoFocus aria-label="PIN" />}
        {error && <p className="pairing-error">{error}</p>}
        <div className="exit-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="danger" onClick={() => void submit()}>
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}

const DEMO_LINES = ['Who is Leo?', 'What day is it?', 'Where is Frank?', 'I need to go home now', 'I’m scared', 'I fell and my hip hurts', 'Yes', 'Goodbye'];

/** For demos and judges without a microphone: speak as the person by typing. */
function DemoDirector({ conv, brain, stt }: { conv: Conversation; brain: string; stt: string }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <button className="demo-toggle" onClick={() => setOpen(true)}>
        Demo
      </button>
    );
  }
  return (
    <aside className="demo-director">
      <header>
        <b>Demo director</b>
        <span>
          brain: {brain} · ears: {stt}
        </span>
        <button onClick={() => setOpen(false)} aria-label="Hide">
          ×
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void conv.say(text);
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something as the person…" aria-label="Say as the person" />
        <button>Say</button>
      </form>
      <div className="demo-chips">
        {DEMO_LINES.map((l) => (
          <button key={l} onClick={() => void conv.say(l)}>
            {l}
          </button>
        ))}
      </div>
      <div className="demo-chips">
        <button onClick={() => void conv.open({ kind: 'session', calming: false })}>Start an activity</button>
        <button onClick={() => void conv.open({ kind: 'session', calming: true })}>Calming session</button>
      </div>
    </aside>
  );
}
