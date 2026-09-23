import { Fragment, useMemo } from 'react';
import type { Layout, PlacedFilm } from './layout';
import { linkedFilms } from './MapCanvas';
import { compactRating, connectionLabel, LockButton, sizedTmdbUrl } from './Node';
import { traceLabelFor, type Trace } from './trace';

interface Props {
  layout: Layout;
  /** Films that survive the filters; null when nothing is filtered. */
  visible: Set<string> | null;
  /** The route being traced through one person, if any. */
  trace?: Trace | null;
  onOpen: (filmId: string) => void;
  deepeningId?: string | null;
  lockedId?: string | null;
  onLock?: (filmId: string) => void;
}

/** The map metaphor does not survive a 390px viewport; the chronology
 *  does. Under the phone breakpoint the two axes collapse to one: a
 *  single column of full-width cards in year order, with the year as a
 *  sticky section header instead of a fixed rail. */
export function FilmColumn({ layout, visible, trace, onOpen, deepeningId, lockedId, onLock }: Props) {
  const films = useMemo(
    () => (visible ? layout.placed.filter((f) => visible.has(f.id)) : layout.placed),
    [layout.placed, visible],
  );
  const rows = useMemo(() => groupByYear(films), [films]);
  const linked = useMemo(() => (lockedId ? linkedFilms(layout, lockedId) : null), [layout, lockedId]);
  const anchor = layout.placed.find((p) => p.anchor);
  return (
    <div className="mc-column" id="mc-map" role="region" aria-label="Films by year">
      {anchor && (
        <p className="mc-column-anchored">
          Anchored on <strong>{anchor.movie.label}</strong> ({anchor.year})
        </p>
      )}
      {rows.map(([year, films]) => (
        <Fragment key={year}>
          <h2 className="mc-column-year">{year}</h2>
          {films.map((f) => (
            <ColumnCard
              key={f.id}
              film={f}
              onOpen={onOpen}
              busy={deepeningId === f.id}
              onRoute={!!trace && trace.films.has(f.id)}
              traceLabel={trace ? traceLabelFor(layout, trace, f.id) : undefined}
              locked={lockedId === f.id}
              linked={!!linked?.has(f.id)}
              onLock={onLock}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function ColumnCard({
  film: m,
  onOpen,
  busy,
  onRoute,
  traceLabel: traced,
  locked,
  linked,
  onLock,
}: {
  film: PlacedFilm;
  onOpen: (filmId: string) => void;
  busy: boolean;
  onRoute?: boolean;
  traceLabel?: string;
  locked?: boolean;
  linked?: boolean;
  onLock?: (filmId: string) => void;
}) {
  const rating = compactRating(m.movie);
  const connection = traced ?? connectionLabel(m);
  const art = m.movie.poster ?? m.movie.backdrop;
  return (
    <div className="mc-column-row">
    <button
      type="button"
      className={`mc-column-card${m.anchor ? ' mc-column-anchor' : ''}${onRoute ? ' mc-column-route' : ''}${locked ? ' mc-column-locked' : ''}${linked ? ' mc-column-linked' : ''}`}
      aria-label={`${m.movie.label}, ${m.year}${connection ? `. Connected by ${connection.replace(' · ', ', ')}` : ''}`}
      onClick={() => onOpen(m.id)}
    >
      {art ? (
        <img className="mc-column-poster" src={sizedTmdbUrl(art, 64)} alt="" width={64} height={96} decoding="async" loading="lazy" />
      ) : (
        <span className="mc-column-poster mc-column-poster-empty" aria-hidden="true" />
      )}
      <span className="mc-column-body">
        <span className="mc-column-title">{m.movie.label}</span>
        <span className="mc-column-meta">
          <span className="mc-year">{m.year}</span>
          {rating ? <span className="mc-rating-compact">{rating.value.toFixed(1)}</span> : null}
        </span>
        {connection ? <span className="mc-connection">{connection}</span> : null}
      </span>
      {busy ? <span className="mc-explore-spin" aria-label="Exploring" /> : null}
    </button>
    {onLock ? <LockButton filmId={m.id} locked={!!locked} onLock={onLock} className="mc-lock-row" /> : null}
    </div>
  );
}

/** Films by year, oldest first, so scrolling the column is scrolling
 *  time — the one thing the wide map encodes that is worth keeping. */
export function groupByYear(films: PlacedFilm[]): [number, PlacedFilm[]][] {
  const byYear = new Map<number, PlacedFilm[]>();
  for (const f of films) {
    const row = byYear.get(f.year);
    if (row) row.push(f);
    else byYear.set(f.year, [f]);
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, list]) => [year, list.sort(sortWithin)] as [number, PlacedFilm[]]);
}

/** The searched film first in its year, then the closest hops. */
function sortWithin(a: PlacedFilm, b: PlacedFilm): number {
  if (a.anchor !== b.anchor) return a.anchor ? -1 : 1;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.movie.label.localeCompare(b.movie.label);
}
