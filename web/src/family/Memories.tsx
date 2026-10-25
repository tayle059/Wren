import { useState } from 'react';
import { family } from '../api';
import { useData, useFamily } from './Family';

interface Memory {
  id: string;
  kind: 'person' | 'place' | 'story' | 'song' | 'photo';
  title: string;
  body: string;
  relationship: string;
  deceased: boolean;
  photoUrl: string | null;
  audioUrl: string | null;
  aiDescription: string;
  prompts: string[];
  source: string;
}

const KIND_LABEL: Record<Memory['kind'], string> = {
  person: 'People',
  place: 'Places',
  story: 'Moments',
  photo: 'Photos',
  song: 'Songs',
};

export function Memories() {
  const { pid, name } = useFamily();
  const { data, reload } = useData<Memory[]>(`/patients/${pid}/memory`);
  const [adding, setAdding] = useState(false);

  const groups = (Object.keys(KIND_LABEL) as Memory['kind'][])
    .map((k) => ({ kind: k, items: (data ?? []).filter((m) => m.kind === k) }))
    .filter((g) => g.items.length);

  return (
    <div className="screen memories">
      <header className="screen-head">
        <div>
          <p className="kicker">What Wren knows</p>
          <h1>Memory book</h1>
        </div>
        <button className="btn primary small" onClick={() => setAdding(true)}>
          Add a memory
        </button>
      </header>
      <p className="muted">
        Wren only shares facts that are written here, so {name} never hears something made up. Photos with names get used in memory chats.
      </p>
      {groups.map((g) => (
        <section key={g.kind}>
          <h2 className="group-title">{KIND_LABEL[g.kind]}</h2>
          <div className="memory-grid">
            {g.items.map((m) => (
              <MemoryCard key={m.id} m={m} onChange={reload} />
            ))}
          </div>
        </section>
      ))}
      {adding && <AddMemory onClose={() => setAdding(false)} onAdded={reload} />}
    </div>
  );
}

function MemoryCard({ m, onChange }: { m: Memory; onChange: () => void }) {
  const { pid } = useFamily();
  const remove = async () => {
    if (!confirm(`Remove “${m.title}” from the memory book?`)) return;
    await family.del(`/patients/${pid}/memory/${m.id}`);
    onChange();
  };
  return (
    <article className="memory-card">
      {m.photoUrl && <img src={m.photoUrl} alt={m.title} loading="lazy" />}
      <div className="memory-body">
        <h3>
          {m.title}
          {m.relationship && <span className="muted"> · {m.relationship}</span>}
        </h3>
        {m.deceased && <p className="tag soft">Has passed away · Wren won’t mention the loss</p>}
        {m.body && <p>{m.body}</p>}
        {m.audioUrl && <audio src={m.audioUrl} controls preload="none" />}
        {m.aiDescription && (
          <p className="ai-note">
            <b>Wren sees:</b> {m.aiDescription}
          </p>
        )}
        {m.prompts.length > 0 && (
          <details>
            <summary>Conversation starters</summary>
            <ul>
              {m.prompts.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </details>
        )}
        <button className="link-button danger" onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </article>
  );
}

function AddMemory({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { pid, name, toast } = useFamily();
  const [kind, setKind] = useState<Memory['kind']>('person');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    form.set('kind', kind);
    form.set('deceased', form.get('deceased') ? 'true' : 'false');
    try {
      await family.upload(`/patients/${pid}/memory`, form);
      toast('Added to the memory book.');
      onAdded();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Add to {name}’s memory book</h2>
        <div className="segmented" role="radiogroup" aria-label="Kind">
          {(['person', 'place', 'story', 'photo', 'song'] as const).map((k) => (
            <button type="button" key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
              {k === 'story' ? 'Moment' : k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <label className="field">
          {kind === 'person' ? 'Name' : kind === 'song' ? 'Song title' : 'Title'}
          <input name="title" required />
        </label>
        {kind === 'person' && (
          <>
            <label className="field">
              Relationship to {name}
              <input name="relationship" placeholder="Grandson, neighbor, best friend…" />
            </label>
            <label className="check">
              <input type="checkbox" name="deceased" /> Has passed away
              <small className="muted"> Wren will share happy memories and never announce the loss.</small>
            </label>
          </>
        )}
        <label className="field">
          Notes
          <small>Details Wren can use. For example, “Leo is 12 and plays soccer.”</small>
          <textarea name="body" rows={3} />
        </label>
        {kind !== 'song' ? (
          <label className="field">
            Photo
            <small>Muse Spark will look at it and suggest gentle conversation starters.</small>
            <input type="file" name="photo" accept="image/*" />
          </label>
        ) : (
          <label className="field">
            Audio file
            <input type="file" name="audio" accept="audio/*" />
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
