import { useState } from 'react';
import { family } from '../api';
import { useData, useFamily } from './Family';
import { PairDialog } from './PairDialog';
import { QrCode } from '../shared/QrCode';
import { timeAgo } from './format';

interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  online: boolean;
}

interface Member {
  id: string;
  name: string;
  email: string;
  relationship: string;
  role: 'owner' | 'family';
}

export function FamilyAndDevices() {
  const { pid, name, me, toast, refresh } = useFamily();
  const { data: devices, reload: reloadDevices } = useData<Device[]>(`/patients/${pid}/devices`);
  const { data: members, reload: reloadMembers } = useData<Member[]>(`/patients/${pid}/members`);
  const [pairOpen, setPairOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const myRole = members?.find((m) => m.id === me.user.id)?.role;

  const rename = async (d: Device) => {
    const next = prompt('Name this tablet', d.name);
    if (!next?.trim()) return;
    await family.patch(`/patients/${pid}/devices/${d.id}`, { name: next });
    reloadDevices();
  };

  const disconnect = async (d: Device) => {
    if (!confirm(`Disconnect “${d.name}”? It will stop working as ${name}’s companion right away.`)) return;
    await family.del(`/patients/${pid}/devices/${d.id}`);
    toast('Tablet disconnected.');
    reloadDevices();
    refresh();
  };

  const remove = async (m: Member) => {
    const self = m.id === me.user.id;
    if (!confirm(self ? `Leave ${name}’s circle? You’ll stop getting updates.` : `Remove ${m.name} from ${name}’s circle?`)) return;
    try {
      await family.del(`/patients/${pid}/members/${m.id}`);
      if (self) location.reload();
      else reloadMembers();
    } catch (e) {
      toast((e as Error).message, 'fyi');
    }
  };

  return (
    <>
      <section className="card" id="tablets">
        <div className="card-head">
          <h2>Tablets</h2>
          <button className="btn primary small" onClick={() => setPairOpen(true)}>
            Add a tablet
          </button>
        </div>
        {devices?.length === 0 && <p className="muted">No tablet yet. Add one with a QR code in under a minute.</p>}
        <ul className="list">
          {devices?.map((d) => (
            <li key={d.id}>
              <span className="dot" data-on={d.online} aria-hidden />
              <span className="list-main">
                <b>{d.name}</b>
                <span className="muted small">
                  {d.online ? 'Connected now' : d.last_seen_at ? `Last seen ${timeAgo(d.last_seen_at)}` : 'Not seen yet'} · added {timeAgo(d.created_at)}
                </span>
              </span>
              <button className="btn small" onClick={() => void rename(d)}>
                Rename
              </button>
              <button className="btn small danger" onClick={() => void disconnect(d)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" id="family">
        <div className="card-head">
          <h2>{name}’s circle</h2>
          <button className="btn primary small" onClick={() => setInviteOpen(true)}>
            Invite family
          </button>
        </div>
        <p className="muted small">Everyone here gets alerts and updates, can add memories, and can reach out through the tablet.</p>
        <ul className="list">
          {members?.map((m) => (
            <li key={m.id}>
              <span className="avatar" aria-hidden>
                {m.name.slice(0, 1)}
              </span>
              <span className="list-main">
                <b>
                  {m.name}
                  {m.id === me.user.id && <span className="muted"> (you)</span>}
                </b>
                <span className="muted small">
                  {m.relationship || 'Family'} · {m.role === 'owner' ? 'Owner' : 'Family member'}
                </span>
              </span>
              {(myRole === 'owner' || m.id === me.user.id) && !(m.role === 'owner' && m.id === me.user.id) && (
                <button className="btn small danger" onClick={() => void remove(m)}>
                  {m.id === me.user.id ? 'Leave' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {pairOpen && (
        <PairDialog
          onClose={() => {
            setPairOpen(false);
            reloadDevices();
          }}
        />
      )}
      {inviteOpen && <InviteDialog onClose={() => (setInviteOpen(false), reloadMembers())} />}
    </>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { pid, name } = useFamily();
  const [relationship, setRelationship] = useState('');
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    try {
      setInvite(await family.post(`/patients/${pid}/invites`, { relationship }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const share = async () => {
    if (!invite) return;
    const text = `Join me in caring for ${name} with Kindred`;
    if ('share' in navigator) {
      await navigator.share({ title: 'Kindred', text, url: invite.url }).catch(() => {});
    } else {
      await (navigator as Navigator).clipboard.writeText(invite.url);
      setCopied(true);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Invite someone to {name}’s circle</h2>
        {!invite ? (
          <>
            <p className="muted">They’ll create their own account (or use Google, Apple or Facebook) and join with one tap.</p>
            <label className="field">
              They are {name}’s…
              <input value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="Son, granddaughter, neighbor, caregiver…" />
            </label>
            {error && <p className="error-text">{error}</p>}
            <div className="row end">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void create()}>
                Create invitation
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="pair-body">
              <div className="pair-qr">
                <QrCode value={invite.url} size={190} label="QR code invitation" />
              </div>
              <ol className="steps">
                <li>With them? They point their phone’s camera here.</li>
                <li>Far away? Send them the link.</li>
              </ol>
            </div>
            <div className="copy-row">
              <input readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
              <button className="btn primary small" onClick={() => void share()}>
                {'share' in navigator ? 'Share link' : copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
            <p className="muted small">Works once, for 7 days.</p>
            <div className="row end">
              <button className="btn" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
