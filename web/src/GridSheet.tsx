import { useMemo, useRef } from 'react';
import { initialsFor, type GridFilm, type GridPayload, type GridPerson } from './grid';
import { personColour } from './personColour';
import { PosterImage } from './PosterImage';
import { SHEET_POSTER_PX } from './poster';
import { useScreen } from './screen';
import { useDrag, useEscape, useFocusTrapped, useGlide } from './sheet';
import { useResolvedTheme } from './theme';

interface Props {
  film: GridFilm;
  payload: GridPayload;
  onOnly: (personId: string) => void;
  onRemap: (film: GridFilm) => void;
  onClose: () => void;
}

/** Everything a 96px card cannot hold: the full title, how the film sits
 *  against the searched one, and who put it on the grid.
 *
 *  It arrives and leaves under its own power. Whatever it was asked to
 *  do — narrow the map, map another film — waits until it is gone, so
 *  nothing ever changes underneath a sheet that is still on the way out. */
export function GridSheet({ film, payload, onOnly, onRemap, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { phone } = useScreen();
  const { phase, leave } = useGlide(onClose);
  const drag = useDrag(phone, leave);
  useEscape(leave);
  useFocusTrapped(ref);
  const people = payload.people.filter((p) => film.people.includes(p.id));
  // Worked out over the whole map rather than this film's few, so a
  // person has the same initials here as on every card.
  const codes = useMemo(() => initialsFor(payload.people), [payload.people]);
  const theme = useResolvedTheme();
  const held = drag.held && drag.y > 0;

  return (
    <>
      <div
        className={`cd-scrim${phase === 'in' ? ' cd-scrim-in' : ''}`}
        onClick={() => leave()}
        aria-hidden="true"
      />
      <div
        className={`cd-sheet cd-sheet-${phase}`}
        style={held ? { transform: `translateY(${drag.y}px)`, transition: 'none' } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={film.title}
        tabIndex={-1}
        ref={ref}
      >
        <span
          className="cd-sheet-grip"
          aria-hidden="true"
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerUp}
        />
        <button type="button" className="cd-sheet-close" aria-label="Close" onClick={() => leave()}>
          ×
        </button>
        <div className="cd-sheet-body">
          <div className="cd-sheet-head">
            <PosterImage
              id={film.id}
              url={film.poster}
              cssPx={SHEET_POSTER_PX}
              className="cd-sheet-poster"
              width={SHEET_POSTER_PX}
              height={Math.round(SHEET_POSTER_PX * 1.5)}
            />
            <div className="cd-sheet-head-text">
              {film.isAnchor && <span className="cd-sheet-eyebrow">Searched movie</span>}
              <h2 className="cd-sheet-title">{film.title}</h2>
              <div className="cd-sheet-meta">
                <span>{film.year}</span>
                <span className="cd-sheet-pill">
                  {film.rating == null ? 'No rating' : film.rating.toFixed(1)}
                </span>
                <VersusLine film={film} anchor={payload.anchor} />
              </div>
              {/* On a desktop the button belongs with the title it
                  names, where the eye already is. The sticky foot is a
                  phone's answer to a thumb that cannot reach up. */}
              {!film.isAnchor && <RemapButton film={film} onRemap={() => leave(() => onRemap(film))} />}
            </div>
          </div>

          {people.length > 0 && (
            <div className="cd-sheet-people">
              <div className="cd-sheet-heading">{headingFor(film, payload.anchor.title)}</div>
              {people.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="cd-sheet-person"
                  style={{ ['--tone' as string]: personColour(p.id, theme) }}
                  aria-label={`Show only ${p.name}'s movies`}
                  onClick={() => leave(() => onOnly(p.id))}
                >
                  {/* Round whatever the role: the line beside it already
                      says who directed, so only the swatches, which have
                      no words next to them, need the shape to say it. */}
                  <span className="cd-sheet-initials" aria-hidden="true">
                    {codes.get(p.id) ?? '?'}
                  </span>
                  <span className="cd-sheet-person-text">
                    <span className="cd-sheet-name">{p.name}</span>
                    <span className="cd-sheet-role">{roleLine(p, payload.anchor.title)}</span>
                  </span>
                  <span className="cd-sheet-only" aria-hidden="true">
                    Show only
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {!film.isAnchor && (
          <div className="cd-sheet-foot">
            <RemapButton film={film} onRemap={() => leave(() => onRemap(film))} />
          </div>
        )}
      </div>
    </>
  );
}

/** Whose map this is. The searched film is not connected to itself. */
export function headingFor(film: GridFilm, anchorTitle: string): string {
  return film.isAnchor ? 'Its cast and directors' : `Connected to ${anchorTitle} through`;
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
      {amount} vs {cmp.title}
    </span>
  );
}

/** The longest title the button will name. Past this the sentence is
 *  longer than the panel and the name is cut to nothing useful, so it
 *  says what it does instead. */
const NAMEABLE = 28;

/** "Map Bad Words" rather than "Map this movie instead".
 *
 *  The old label described the control; this one says what will
 *  happen, which is the only thing the reader is deciding. The arrow
 *  is the going. */
function RemapButton({ film, onRemap }: { film: GridFilm; onRemap: () => void }) {
  const named = film.title.length <= NAMEABLE;
  return (
    <button
      type="button"
      className="cd-sheet-primary"
      aria-label={`Map ${film.title}`}
      onClick={onRemap}
    >
      <span className="cd-sheet-primary-text">
        {named ? `Map ${film.title}` : 'Map this movie'}
      </span>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </button>
  );
}
