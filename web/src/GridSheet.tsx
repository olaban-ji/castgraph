import { useEffect, useRef } from 'react';
import type { GridFilm, GridPayload, GridPerson } from './grid';
import { toneOf } from './PeopleChips';

interface Props {
  film: GridFilm;
  payload: GridPayload;
  /** How many films on the grid each person is in. */
  counts: Map<number, number>;
  onOnly: (personId: number) => void;
  onRemap: (film: GridFilm) => void;
  onClose: () => void;
}

/** Everything a 96px card cannot hold: the full title, how the film sits
 *  against the searched one, and who put it on the grid. */
export function GridSheet({ film, payload, counts, onOnly, onRemap, onClose }: Props) {
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
              {versus(film, payload.anchor) && <span>{versus(film, payload.anchor)}</span>}
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
                onClick={() => onOnly(p.id)}
              >
                <span className="cd-sheet-dot" style={{ ['--tone' as string]: toneOf(p.role) }} />
                <span className="cd-sheet-person-text">
                  <span className="cd-sheet-name">{p.name}</span>
                  <span className="cd-sheet-role">{roleLine(p, payload.anchor.title)}</span>
                </span>
                <span className="cd-sheet-only">Only their {counts.get(p.id) ?? 0} →</span>
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

/** How this film's rating sits against the searched one. Omitted for the
 *  searched film itself and for anything nobody has rated. */
export function versus(film: GridFilm, anchor: GridFilm): string {
  if (film.isAnchor || film.rating == null || anchor.rating == null) return '';
  const delta = Math.round((film.rating - anchor.rating) * 10) / 10;
  if (delta === 0) return `Same as ${anchor.title}`;
  return `${Math.abs(delta).toFixed(1)} ${delta > 0 ? 'above' : 'below'} ${anchor.title}`;
}
