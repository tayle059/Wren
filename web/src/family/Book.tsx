import { family } from '../api';
import { useData, useFamily } from './Family';

interface Story {
  id: string;
  title: string;
  era: string;
  text: string;
  quote: string;
  createdAt: string;
  hidden: number;
}

/** The stories they've told, kept in their own words: a keepsake for the family. */
export function Book() {
  const { pid, name } = useFamily();
  const { data, reload } = useData<Story[]>(`/patients/${pid}/stories`);
  const visible = (data ?? []).filter((s) => !s.hidden);
  const hidden = (data ?? []).filter((s) => s.hidden);

  const toggle = async (s: Story) => {
    await family.patch(`/patients/${pid}/stories/${s.id}`, { hidden: !s.hidden });
    reload();
  };

  return (
    <div className="screen book">
      <header className="screen-head">
        <div>
          <p className="kicker">Kept by Wren, in {name}’s own words</p>
          <h1>{name}’s Book</h1>
        </div>
        <button className="btn small no-print" onClick={() => window.print()}>
          Print the book
        </button>
      </header>
      <p className="book-intro muted no-print">
        When {name} tells a story, it’s saved here. One day these may be the stories only you remember, so they’re yours to keep, print, and share.
      </p>
      {data && visible.length === 0 && <p className="muted">No stories yet. They’ll appear as {name} shares them.</p>}
      <div className="pages">
        {visible.map((s) => (
          <article key={s.id} className="page">
            <p className="page-era">{s.era || new Date(s.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
            <h2>{s.title}</h2>
            {s.quote && <blockquote>“{s.quote}”</blockquote>}
            <p>{s.text}</p>
            <button className="link-button no-print" onClick={() => void toggle(s)}>
              Hide this story
            </button>
          </article>
        ))}
      </div>
      {hidden.length > 0 && (
        <details className="no-print hidden-stories">
          <summary>{hidden.length} hidden</summary>
          {hidden.map((s) => (
            <p key={s.id}>
              {s.title}{' '}
              <button className="link-button" onClick={() => void toggle(s)}>
                Restore
              </button>
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
