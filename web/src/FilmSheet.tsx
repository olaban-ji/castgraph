import { useEffect, useRef } from 'react';
import type { Edge, Layout, PlacedFilm } from './layout';
import { compactRating, sizedTmdbUrl } from './Node';

interface Props {
  film: PlacedFilm;
  layout: Layout;
  /** Blow this film out into the map; absent once it already has. */
  onDeepen?: (filmId: string) => void;
  /** Re-anchor the whole map here. */
  onReanchor?: (filmId: string) => void;
  /** Follow one of these people across the whole map. */
  onTrace?: (person: string) => void;
  onClose: () => void;
  deepening?: boolean;
}

/** Everything a card cannot hold: the full title, both ratings, and every
 *  person who connects this film to the rest of the map — the tooltip's
 *  content as text, which is also the keyboard and screen-reader path to
 *  the same information. */
export function FilmSheet({ film: m, layout, onDeepen, onReanchor, onTrace, onClose, deepening }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const connections = connectionsOf(layout, m.id);
  const cast = connections.filter((c) => !c.director);
  const directors = connections.filter((c) => c.director);
  const rating = compactRating(m.movie);
  const art = m.movie.poster ?? m.movie.backdrop;

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
      <div className="mc-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="mc-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${m.movie.label}, ${m.year}`}
        tabIndex={-1}
        ref={ref}
      >
        <button className="mc-sheet-close" aria-label="Close" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="mc-sheet-head">
          {art ? (
            <img className="mc-sheet-poster" src={sizedTmdbUrl(art, 84)} alt="" width={84} height={126} decoding="async" />
          ) : (
            <span className="mc-sheet-poster mc-column-poster-empty" aria-hidden="true" />
          )}
          <div className="mc-sheet-title-block">
            <h2 className="mc-sheet-title">{m.movie.label}</h2>
            <div className="mc-sheet-meta">
              <span className="mc-year">{m.year}</span>
              {m.movie.imdb_rating != null && (
                <span className="mc-pill">
                  <span className="mc-pill-label">IMDb</span>
                  <span className="mc-pill-value">{m.movie.imdb_rating.toFixed(1)}</span>
                </span>
              )}
              {m.movie.rating != null && (
                <span className="mc-pill">
                  <span className="mc-pill-label">TMDb</span>
                  <span className="mc-pill-value">{m.movie.rating.toFixed(1)}</span>
                </span>
              )}
              {!rating && <span className="mc-connection">No rating yet</span>}
            </div>
          </div>
        </div>

        {cast.length > 0 && (
          <PeopleSection heading="Connected through cast" rows={cast} onTrace={onTrace} />
        )}

        {directors.length > 0 && (
          <PeopleSection heading="Connected through direction" rows={directors} onTrace={onTrace} />
        )}

        {connections.length === 0 && (
          <p className="mc-sheet-empty">No connections drawn yet — explore from here to grow them.</p>
        )}

        {onDeepen ? (
          <button className="mc-sheet-primary" disabled={deepening} onClick={() => onDeepen(m.id)}>
            {deepening ? 'Exploring…' : 'Explore from here'}
          </button>
        ) : onReanchor ? (
          <button className="mc-sheet-primary" onClick={() => onReanchor(m.id)}>
            Make this the centre
          </button>
        ) : null}
      </div>
    </>
  );
}

/** The people whose lines reach this film. Each is a way out of it:
 *  picking one follows that person across the whole map. */
function PeopleSection({
  heading,
  rows,
  onTrace,
}: {
  heading: string;
  rows: SheetConnection[];
  onTrace?: (person: string) => void;
}) {
  return (
    <section className="mc-sheet-section">
      <h3 className="mc-sheet-heading">{heading}</h3>
      <ul className="mc-sheet-list">
        {rows.map((c) => (
          <li key={c.key}>
            {onTrace ? (
              <button type="button" className="mc-sheet-trace" onClick={() => onTrace(c.person)}>
                <span className="mc-sheet-person">{c.person}</span>
                <span className="mc-sheet-role">{c.detail}</span>
                <span className="mc-sheet-follow" aria-hidden="true">Follow →</span>
              </button>
            ) : (
              <>
                <span className="mc-sheet-person">{c.person}</span>
                <span className="mc-sheet-role">{c.detail}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface SheetConnection {
  key: string;
  person: string;
  detail: string;
  director: boolean;
  /** How many of the films on the map this person ties to this one. */
  films: number;
}

/** Every edge touching this film, described the way the hover tooltip
 *  describes one: who, and what they did. */
export function connectionsOf(layout: Layout, filmId: string): SheetConnection[] {
  // One row per person, not per edge: Keanu Reeves tying four films to The
  // Matrix is one door to walk through, not four identical ones. A person
  // who both acted and directed keeps a row in each group.
  const byPerson = new Map<string, SheetConnection>();
  for (const e of layout.edges as Edge[]) {
    if (e.from.id !== filmId && e.to.id !== filmId) continue;
    const other = e.from.id === filmId ? e.to : e.from;
    const person = e.actor || 'Unknown';
    const key = `${e.director ? 'd' : 'c'}:${person}`;
    const seen = byPerson.get(key);
    if (seen) {
      seen.films += 1;
      seen.detail = countDetail(e.director, seen.films);
      continue;
    }
    const what = e.director ? 'directed' : e.role ? `as ${e.role}` : 'appeared';
    byPerson.set(key, {
      key,
      person,
      detail: `${what} · ${other.movie.label}`,
      director: e.director,
      films: 1,
    });
  }
  // The people who hold the most of the map together are the ones worth
  // following, so they come first.
  return [...byPerson.values()].sort((a, b) => b.films - a.films);
}

/** What a person's row says once they connect more than one film. */
function countDetail(director: boolean, films: number): string {
  return `${director ? 'directed' : 'in'} ${films} of these movies`;
}
