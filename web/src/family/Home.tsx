import { useState } from 'react';
import { family } from '../api';
import { useData, useFamily } from './Family';
import { VoiceNote } from './VoiceNote';
import { PairDialog } from './PairDialog';
import { timeAgo, to12h } from './format';

interface HomeData {
  patient: { preferredName: string; companionName: string };
  device: { paired: boolean; online: boolean; lastSeenAt: string | null };
  alerts: { id: string; level: 'urgent' | 'fyi'; category: string; reason: string; evidence: string; createdAt: string; conversationId: string | null }[];
  today: { date: string; conversations: number; schedule: { id: string; kind: string; label: string; time: string; status: string; calming: boolean }[] };
  summary: { date: string; mood: string; text: string; highlights: string[] } | null;
  visitPrep: { starters?: string[]; avoid?: string };
  suggestions: { id: string; kind: string; text: string }[];
  stories: { id: string; title: string; quote: string }[];
}

const STATUS: Record<string, { label: string; tone: string }> = {
  upcoming: { label: 'Coming up', tone: 'muted' },
  invited: { label: 'Offered', tone: 'info' },
  completed: { label: 'Done', tone: 'good' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  not_yet: { label: 'Not yet', tone: 'fyi' },
  declined: { label: 'Said no', tone: 'muted' },
  no_response: { label: 'No answer', tone: 'fyi' },
  skipped: { label: 'Skipped', tone: 'muted' },
  missed: { label: 'Missed', tone: 'fyi' },
};

const MOOD: Record<string, string> = {
  bright: 'A bright day',
  content: 'A good day',
  mixed: 'A mixed day',
  unsettled: 'An unsettled day',
  quiet: 'A quiet day',
};

export function Home() {
  const { pid, name, toast, refresh } = useFamily();
  const { data, reload } = useData<HomeData>(`/patients/${pid}/home`);
  const [pairOpen, setPairOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  if (!data) return <div className="screen-loading" />;
  const companion = data.patient.companionName;

  const reachOut = async (kind: 'checkin' | 'session' | 'calming') => {
    try {
      await family.post(`/patients/${pid}/reach-out`, { kind });
      toast(kind === 'calming' ? `${companion} is starting a calming session.` : `${companion} is reaching out to ${name} now.`);
    } catch (e) {
      toast((e as Error).message, 'fyi');
    }
  };

  const ack = async (id: string) => {
    await family.post(`/patients/${pid}/alerts/${id}/ack`);
    reload();
  };

  const answer = async (id: string, action: 'accept' | 'dismiss') => {
    await family.post(`/patients/${pid}/suggestions/${id}`, { action });
    if (action === 'accept') toast('Schedule updated.');
    refresh();
  };

  return (
    <div className="screen home">
      <header className="screen-head">
        <div>
          <p className="kicker">{new Date(`${data.today.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>{name} today</h1>
        </div>
        <DeviceChip device={data.device} onPair={() => setPairOpen(true)} />
      </header>

      {data.alerts.length > 0 && (
        <section className="alerts" aria-label="Alerts">
          {data.alerts.map((a) => (
            <AlertCard key={a.id} alert={a} onAck={() => void ack(a.id)} />
          ))}
        </section>
      )}

      {data.suggestions.map((s) => (
        <section key={s.id} className="card suggestion">
          <p className="kicker">{companion} noticed something</p>
          <p className="suggestion-text">{s.text}</p>
          <div className="row">
            <button className="btn primary small" onClick={() => void answer(s.id, 'accept')}>
              Yes, move it
            </button>
            <button className="btn small" onClick={() => void answer(s.id, 'dismiss')}>
              Not now
            </button>
          </div>
        </section>
      ))}

      <div className="home-grid">
        <div className="home-col">
          <section className="card summary">
            {data.summary ? (
              <>
                <p className="kicker">
                  {data.summary.date === data.today.date ? 'Tonight’s update' : `Update from ${new Date(`${data.summary.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}`}
                </p>
                <h2>
                  <span className="mood-dot" data-mood={data.summary.mood} aria-hidden /> {MOOD[data.summary.mood] ?? 'Today'}
                </h2>
                <p className="summary-text">{data.summary.text}</p>
                {data.summary.highlights.length > 0 && (
                  <ul className="highlights">
                    {data.summary.highlights.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <>
                <h2>Your first update arrives tonight</h2>
                <p className="muted">Each evening {companion} writes a short note about {name}’s day.</p>
              </>
            )}
          </section>

          <section className="card">
            <h2>Today’s rhythm</h2>
            <ol className="timeline">
              {data.today.schedule.map((s) => {
                const st = STATUS[s.status] ?? { label: s.status, tone: 'muted' };
                return (
                  <li key={s.id} data-tone={st.tone}>
                    <span className="timeline-time">{to12h(s.time)}</span>
                    <span className="timeline-label">
                      {s.label}
                      {s.calming && <span className="tag">calming</span>}
                    </span>
                    <span className="status" data-tone={st.tone}>
                      {st.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <div className="home-col">
          <section className="card actions">
            <h2>Reach out</h2>
            <div className="action-grid">
              <button className="action" onClick={() => void reachOut('checkin')} disabled={!data.device.online}>
                <span className="action-icon" aria-hidden>
                  ☀
                </span>
                Check in now
              </button>
              <button className="action" onClick={() => void reachOut('session')} disabled={!data.device.online}>
                <span className="action-icon" aria-hidden>
                  ✿
                </span>
                Start an activity
              </button>
              <button className="action" onClick={() => void reachOut('calming')} disabled={!data.device.online}>
                <span className="action-icon" aria-hidden>
                  ☾
                </span>
                Calming session
              </button>
              <button className="action" onClick={() => setNoteOpen(true)}>
                <span className="action-icon" aria-hidden>
                  ♡
                </span>
                Send a voice message
              </button>
            </div>
            {!data.device.online && <p className="muted small">{data.device.paired ? `${name}’s tablet is offline right now.` : `Connect ${name}’s tablet to reach out.`}</p>}
          </section>

          {(data.visitPrep.starters?.length ?? 0) > 0 && (
            <section className="card prep">
              <p className="kicker">Before you call or visit</p>
              <h2>Things {name} has been enjoying</h2>
              <ul>
                {data.visitPrep.starters!.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              {data.visitPrep.avoid && (
                <p className="avoid">
                  <b>Gently avoid:</b> {data.visitPrep.avoid}
                </p>
              )}
            </section>
          )}

          {data.stories.length > 0 && (
            <a className="card story-teaser" href="#/family/book">
              <p className="kicker">From {name}’s Book</p>
              <h2>{data.stories[0].title}</h2>
              {data.stories[0].quote && <blockquote>“{data.stories[0].quote}”</blockquote>}
              <span className="link">Read {name}’s stories →</span>
            </a>
          )}
        </div>
      </div>

      {pairOpen && <PairDialog onClose={() => setPairOpen(false)} />}
      {noteOpen && <VoiceNote onClose={() => setNoteOpen(false)} />}
    </div>
  );
}

function DeviceChip({ device, onPair }: { device: HomeData['device']; onPair: () => void }) {
  if (!device.paired) {
    return (
      <button className="btn primary small" onClick={onPair}>
        Connect tablet
      </button>
    );
  }
  return (
    <button className="device-chip" data-online={device.online} onClick={onPair} title="Tablet connection">
      <span className="dot" aria-hidden />
      {device.online ? 'Tablet connected' : `Tablet offline${device.lastSeenAt ? ` · seen ${timeAgo(device.lastSeenAt)}` : ''}`}
    </button>
  );
}

function AlertCard({ alert, onAck }: { alert: HomeData['alerts'][number]; onAck: () => void }) {
  const { pid } = useFamily();
  const [open, setOpen] = useState(false);
  const { data } = useData<{ messages: { role: string; text: string; created_at: string }[] }>(
    open && alert.conversationId ? `/patients/${pid}/conversations/${alert.conversationId}` : null,
  );
  return (
    <article className="alert" data-level={alert.level}>
      <div className="alert-icon" aria-hidden>
        {alert.level === 'urgent' ? '!' : 'i'}
      </div>
      <div className="alert-body">
        <p className="alert-meta">
          <b>{alert.level === 'urgent' ? 'Urgent' : 'Good to know'}</b> · {timeAgo(alert.createdAt)}
        </p>
        <p className="alert-reason">{alert.reason}</p>
        {open && data && (
          <div className="transcript">
            {data.messages.map((m, i) => (
              <p key={i} data-role={m.role}>
                {m.text}
              </p>
            ))}
          </div>
        )}
        <div className="row">
          {alert.conversationId && (
            <button className="btn small" onClick={() => setOpen(!open)}>
              {open ? 'Hide conversation' : 'Read conversation'}
            </button>
          )}
          <button className="btn small" onClick={onAck}>
            Mark as seen
          </button>
        </div>
      </div>
    </article>
  );
}
