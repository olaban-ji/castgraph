import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AXIS_H,
  initialsFor,
  layoutGrid,
  markersFor,
  type GridLayout,
  type GridPayload,
  type GridPerson,
  type GridSettings,
  type Placed,
} from './grid';
import { toneOf } from './PeopleChips';

interface Props {
  payload: GridPayload;
  settings: GridSettings;
  /** People the reader has selected; empty means everyone. */
  selected: Set<number>;
  /** A person being previewed by a pointer resting on their chip. */
  hovered: number | null;
  /** Called with the people on the card under the pointer, to light chips. */
  onCardHover: (people: number[]) => void;
  onOpen: (filmId: number) => void;
}

/** How opaque a card that does not match the selection is. */
const DIM_SELECTED = 0.12;
const DIM_PREVIEW = 0.22;

/** The grid: one card per film, year down, rating across.
 *
 *  Selecting people changes opacity and nothing else — the layout is
 *  computed from the payload and the width alone, so a card never moves
 *  because of who is selected. */
export function GridMap({
  payload,
  settings,
  selected,
  hovered,
  onCardHover,
  onOpen,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The layout follows the scroller's width, not the window's: the panel
  // and the scrollbar both take from it.
  //
  // A first measurement of zero is real: a page loaded in a background
  // tab is never laid out, so the element and the document both measure
  // nothing and a ResizeObserver does not fire either. `window.innerWidth`
  // is known regardless, so the grid is drawn at roughly the right size
  // rather than left blank until the reader looks at it; the observer
  // corrects it the moment there is true layout to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth || window.innerWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    window.addEventListener('resize', read);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', read);
    };
  }, []);

  const layout = useMemo(
    () => (width > 0 ? layoutGrid(payload, width, settings) : null),
    [payload, width, settings],
  );
  const codes = useMemo(() => initialsFor(payload.people), [payload.people]);
  const byId = useMemo(
    () => new Map(payload.people.map((p) => [p.id, p])),
    [payload.people],
  );

  const recentre = useCallback(
    (smooth: boolean) => {
      const el = scroller.current;
      const card = layout?.anchor;
      if (!el || !card) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({
        left: Math.max(0, card.left + layout.metrics.cardW / 2 - el.clientWidth / 2),
        top: Math.max(0, card.top + AXIS_H + layout.metrics.cardH / 2 - el.clientHeight / 2),
        behavior: smooth && !reduced ? 'smooth' : 'auto',
      });
    },
    [layout],
  );

  // Every new grid opens centred on the film that was searched for. A
  // resize is not a new grid, so it keeps the reader where they were.
  const centredFor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!layout || centredFor.current === payload.anchor.id) return;
    centredFor.current = payload.anchor.id;
    recentre(false);
  }, [layout, payload.anchor.id, recentre]);

  return (
    <>
      <div className="cd-scroller" ref={scroller} id="cd-grid" role="region" aria-label="Films by year and rating">
        {layout && (
          <div className="cd-plot-wrap" style={{ width: layout.plotW }}>
            <div className="cd-plot" style={{ height: layout.plotH }}>
              {layout.rows.map((r) => (
                <div
                  key={r.year}
                  className={`cd-band${r.index % 2 === 1 ? ' cd-band-odd' : ''}${r.anchorYear ? ' cd-band-anchor' : ''}${r.decade ? ' cd-band-decade' : ''}`}
                  style={{ top: r.top, height: r.height }}
                />
              ))}
              {settings.showUnrated && (
                <div className="cd-unrated-edge" style={{ left: layout.unratedEdge }} />
              )}
              {layout.lines.map((l) => (
                <div key={l.rating} className="cd-gridline" style={{ left: l.x }} />
              ))}
              {layout.cards.map((c) => (
                <Card
                  key={c.film.id}
                  card={c}
                  layout={layout}
                  people={byId}
                  codes={codes}
                  opacity={opacityOf(c, selected, hovered)}
                  onOpen={onOpen}
                  onHover={onCardHover}
                />
              ))}
              <div className="cd-rail-layer" style={{ height: layout.plotH, width: layout.plotW }}>
                <div className="cd-rail" style={{ width: layout.metrics.railW, height: layout.plotH }}>
                  {layout.rows.map((r) => (
                    <span
                      key={r.year}
                      className={`cd-rail-year${r.decade ? ' cd-rail-decade' : ''}${r.anchorYear ? ' cd-rail-anchor' : ''}`}
                      style={{ top: r.top + 10 }}
                    >
                      {r.year}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <button
        type="button"
        className="cd-recentre"
        aria-label={`Recenter on ${payload.anchor.title}`}
        onClick={() => recentre(true)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
        Recenter
      </button>
    </>
  );
}

function Card({
  card,
  layout,
  people,
  codes,
  opacity,
  onOpen,
  onHover,
}: {
  card: Placed;
  layout: GridLayout;
  people: Map<number, GridPerson>;
  codes: Map<number, string>;
  opacity: number;
  onOpen: (filmId: number) => void;
  onHover: (people: number[]) => void;
}) {
  const { film } = card;
  const { cardW, cardH, titleLines } = layout.metrics;
  const shared = film.people.length > 1;
  // The searched film is everyone's, so saying so on the card says nothing.
  const markers = film.isAnchor
    ? { show: [], extra: 0, initials: false }
    : markersFor(film.people, layout.metrics, film.rating);
  return (
    <button
      type="button"
      className={`cd-card${film.isAnchor ? ' cd-card-anchor' : ''}${shared ? ' cd-card-shared' : ''}`}
      style={{
        left: card.left,
        top: card.top,
        width: cardW,
        height: cardH,
        opacity,
        ['--lines' as string]: titleLines,
      }}
      aria-label={`${film.title}, ${film.year}, rated ${film.rating == null ? 'not yet' : film.rating.toFixed(1)}`}
      onClick={() => onOpen(film.id)}
      onMouseEnter={() => onHover(film.people)}
      onMouseLeave={() => onHover([])}
    >
      <span className="cd-card-title">{film.title}</span>
      <span className="cd-card-foot">
        <span className={`cd-card-rating${film.rating == null ? ' cd-card-unrated' : ''}`}>
          {film.rating == null ? 'No rating' : film.rating.toFixed(1)}
        </span>
        <span className="cd-card-spacer" />
        {markers.initials
          ? markers.show.map((id) => (
              <span
                key={id}
                className="cd-badge"
                style={{ ['--tone' as string]: toneOf(people.get(id)?.role ?? 'cast') }}
              >
                {codes.get(id) ?? '?'}
              </span>
            ))
          : markers.show.map((id) => (
              <span
                key={id}
                className="cd-dot"
                style={{ ['--tone' as string]: toneOf(people.get(id)?.role ?? 'cast') }}
              />
            ))}
        {markers.extra > 0 && <span className="cd-more">+{markers.extra}</span>}
      </span>
    </button>
  );
}

/** A card is full strength when nothing is narrowing the grid, or when it
 *  holds someone being previewed or selected. A hovered chip previews just
 *  that person and overrides the selection while the pointer is on it. */
export function opacityOf(card: Placed, selected: Set<number>, hovered: number | null): number {
  if (hovered != null) {
    return card.film.people.includes(hovered) ? 1 : DIM_PREVIEW;
  }
  if (selected.size === 0) return 1;
  return card.film.people.some((id) => selected.has(id)) ? 1 : DIM_SELECTED;
}
