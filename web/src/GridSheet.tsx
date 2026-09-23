import { useEffect, useRef } from 'react';
import type { GridFilm, GridPayload, GridPerson } from './grid';
import { toneOf } from './PeopleChips';

interface Props {
  film: GridFilm;
  payload: GridPayload;
  onOnly: (personId: number) => void;
  onRemap: (film: GridFilm) => void;
  onClose: () => void;
}

/** Everything a 96px card cannot hold: the full title, how the film sits
 *  against the searched one, and who put it on the grid. */
export function GridSheet({ film, payload, onOnly, onRemap, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const people = payload.people.filter((p) => film.people.includes(p.id));

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="cd-scrim" onClick={onClose} aria-hidden="true" />
      <div className="cd-sheet" role="dialog" aria-label={film.title} tabIndex={-1} ref={ref}>
        <button type="button" className="cd-sheet-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="cd-sheet-head">
          {film.poster ? (
            <img
              className="cd-sheet-poster"
              src={film.poster}
              alt=""
              width={92}
              height={138}
              decoding="async"
            />
          ) : (
            <span className="cd-sheet-poster" aria-hidden="true" />
          )}
          <div className="cd-sheet-head-text">
            {film.isAnchor && <span className="cd-sheet-eyebrow">Searched film</span>}
            <h2 className="cd-sheet-title">{film.title}</h2>
            <div className="cd-sheet-meta">
              <span>{film.year}</span>
              <span className="cd-sheet-pill">
                {film.rating == null ? 'No rating' : film.rating.toFixed(1)}
              </span>
              <VersusLine film={film} anchor={payload.anchor} />
            </div>
          </div>
        </div>

        {people.length > 0 && (
          <div className="cd-sheet-people">
            <div className="cd-sheet-heading">Connected to {payload.anchor.title} through</div>
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                className="cd-sheet-person"
                style={{ ['--tone' as string]: toneOf(p.role) }}
                aria-label={`Show only ${p.name}'s films`}
                onClick={() => onOnly(p.id)}
              >
                <span className="cd-sheet-dot" />
                <span className="cd-sheet-person-text">
                  <span className="cd-sheet-name">{p.name}</span>
                  <span className="cd-sheet-role">{roleLine(p, payload.anchor.title)}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {!film.isAnchor && (
          <button type="button" className="cd-sheet-primary" onClick={() => onRemap(film)}>
            Map this film instead
          </button>
        )}
      </div>
    </>
  );
}

/** What a person did on the searched film. */
export function roleLine(p: GridPerson, anchorTitle: string): string {
  if (p.role === 'director') return `Directed ${anchorTitle}`;
  return p.character ? `${p.character} in ${anchorTitle}` : `In ${anchorTitle}`;
}

export type Versus = {
  dir: 'up' | 'down' | 'same';
  delta: number;
  title: string;
};

/** How this film's rating sits against the searched one. Omitted for the
 *  searched film itself and for anything nobody has rated. */
export function versus(film: GridFilm, anchor: GridFilm): Versus | null {
  if (film.isAnchor || film.rating == null || anchor.rating == null) return null;
  const delta = Math.round((film.rating - anchor.rating) * 10) / 10;
  if (delta === 0) return { dir: 'same', delta: 0, title: anchor.title };
  return { dir: delta > 0 ? 'up' : 'down', delta, title: anchor.title };
}

function VersusLine({ film, anchor }: { film: GridFilm; anchor: GridFilm }) {
  const cmp = versus(film, anchor);
  if (!cmp) return null;
  if (cmp.dir === 'same') {
    return <span className="cd-sheet-versus cd-sheet-versus-same">Same as {cmp.title}</span>;
  }
  const amount = Math.abs(cmp.delta).toFixed(1);
  const word = cmp.dir === 'up' ? 'above' : 'below';
  return (
    <span
      className={`cd-sheet-versus cd-sheet-versus-${cmp.dir}`}
      aria-label={`${amount} ${word} ${cmp.title}`}
    >
      <span className="cd-sheet-versus-dir" aria-hidden="true">
        {cmp.dir === 'up' ? '▲' : '▼'}
      </span>
      {amount} {cmp.title}
    </span>
  );
}
