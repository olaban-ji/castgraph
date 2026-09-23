import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AXIS_H,
  inWarmSpan,
  initialsFor,
  layoutGrid,
  markersFor,
  passesFloor,
  type GridFilm,
  warmSpan,
  type GridLayout,
  type GridPayload,
  type GridPerson,
  type GridSettings,
  type Placed,
} from './grid';
import { colourFor, sizedTmdbUrl } from './Node';
import { toneOf } from './PeopleChips';

interface Props {
  /** What each visible card says, by film id. A card with nothing here
   *  is drawn as its own empty box until its detail arrives. */
  detail: Map<number, GridFilm>;
  /** Cards in view whose detail we do not have yet. */
  onNeedDetail: (ids: number[]) => void;
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

/** How far the reader can scroll before a new band of cards is mounted.
 *  Well inside the screen that is already warm, so the mount happens
 *  before those cards reach the glass. */
const WARM_STEP = 64;

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
  detail,
  onNeedDetail,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  // Known before the scroller is measured, so the first paint already has
  // a screen of cards rather than a blank plot. The observer corrects it.
  const [width, setWidth] = useState(() => window.innerWidth);
  // Height 0 means the scroller has not been measured yet. Until then the
  // grid opens on the searched film rather than on the top of the plot.
  const [view, setView] = useState({ scrollTop: 0, height: 0, anchorId: payload.anchor.id });
  if (view.anchorId !== payload.anchor.id) {
    setView({ scrollTop: 0, height: 0, anchorId: payload.anchor.id });
  }

  const anchorIdRef = useRef(payload.anchor.id);
  anchorIdRef.current = payload.anchor.id;

  const readView = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const height = el.clientHeight || window.innerHeight;
    const scrollTop = Math.floor(el.scrollTop / WARM_STEP) * WARM_STEP;
    const anchorId = anchorIdRef.current;
    setWidth(el.clientWidth || window.innerWidth);
    setView((prev) =>
      prev.scrollTop === scrollTop && prev.height === height && prev.anchorId === anchorId
        ? prev
        : { scrollTop, height, anchorId },
    );
  }, []);

  // The layout follows the scroller's width, not the window's: the panel
  // and the scrollbar both take from it.
  //
  // A first measurement of zero is real: a page loaded in a background
  // tab is never laid out, so the element and the document both measure
  // nothing and a ResizeObserver does not fire either. `window.innerWidth`
  // is known regardless, so the grid is drawn at roughly the right size
  // rather than left blank until the reader looks at it; the observer
  // corrects it the moment there is true layout to read.
  //
  // Scroll keeps the warm band with the reader. One screen above and one
  // below stay mounted, so a flick in either direction meets cards that
  // are already there. The rest of the plot is only its height.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Scrolling is a flood, so it is throttled to a frame. Resizing is
    // not, and must not be: a page that has never been laid out — one
    // opened in a background tab — measures 0 everywhere, and a frame
    // never comes while it is hidden. Deferring the recovery to one
    // would leave that reader looking at an empty plot for good.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        readView();
      });
    };
    readView();
    // And if there was nothing to measure yet, look again off a timer,
    // which does run while hidden.
    const retry = window.setTimeout(readView, 0);
    const ro = new ResizeObserver(readView);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', readView);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(retry);
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', readView);
    };
  }, [readView]);

  // Cards the reader already has keep their seat when a later page
  // arrives. A new map, or a width that changes the axis, starts again.
  // The spine is the whole grid, so this runs once per grid and width.
  // There is no earlier layout to carry forward: every card's place was
  // already final the first time.
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
  // Until that scroll has landed, the cards drawn are the ones around the
  // film — not the top of the plot, which is where the scroller still is.
  const [placedFor, setPlacedFor] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!layout || !el || placedFor === payload.anchor.id) return;
    // The layout has to be the one for the width on screen. The first
    // guess is the window, and recentring on it would miss once the
    // scroller reports its own width.
    if (width !== (el.clientWidth || window.innerWidth)) return;
    recentre(false);
    readView();
    setPlacedFor(payload.anchor.id);
  }, [layout, width, payload.anchor.id, placedFor, recentre, readView]);

  // Rows added above the screen would shove the cards the reader is
  // looking at down the page. Pin a card that is on the glass — not
  // only the searched film, which they may have already scrolled past.
  const pin = useRef<{ id: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!layout || !el) return;
    const prev = pin.current;
    if (prev) {
      const card = layout.cards.find((c) => c.film.id === prev.id);
      if (card) {
        const delta = card.top - prev.top;
        if (delta !== 0) {
          el.scrollTop += delta;
          readView();
        }
      }
    }
    pin.current = cardOnGlass(layout, el.scrollTop, el.clientHeight);
  }, [layout, readView]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!layout || !el) return;
    const remember = () => {
      pin.current = cardOnGlass(layout, el.scrollTop, el.clientHeight);
    };
    el.addEventListener('scroll', remember, { passive: true });
    return () => el.removeEventListener('scroll', remember);
  }, [layout]);

  const viewH = view.height > 0 ? view.height : window.innerHeight;
  const scrollTop =
    placedFor === payload.anchor.id && view.height > 0
      ? view.scrollTop
      : layout
        ? openedAt(layout, viewH)
        : 0;
  const span = warmSpan(scrollTop, viewH);
  const screen = { top: scrollTop, bottom: scrollTop + viewH };
  const cards = layout
    ? layout.cards.filter((c) => inWarmSpan(c.top, layout.metrics.cardH, span))
    : [];

  // Every card's place is already known, so scrolling never moves one.
  // What it does ask for is what the cards in reach actually say.
  const wantedKey = cards.map((c) => c.film.id).join(',');
  useEffect(() => {
    if (cards.length === 0) return;
    const missing = cards.map((c) => c.film.id).filter((id) => !detail.has(id));
    if (missing.length > 0) onNeedDetail(missing);
    // wantedKey stands for the set of cards in reach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, detail, onNeedDetail]);

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
              {cards.map((c) => (
                <Card
                  key={c.film.id}
                  card={c}
                  said={detail.get(c.film.id)}
                  layout={layout}
                  people={byId}
                  codes={codes}
                  opacity={opacityOf(c, detail.get(c.film.id)?.people, selected, hovered, settings.minRating)}
                  eager={inWarmSpan(c.top, layout.metrics.cardH, screen)}
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

/** Where a new grid should open: the searched film in the middle of the
 *  screen, in the same steps the scroll listener uses, so the first paint
 *  and the paint after measuring ask for the same cards. */
/** A card the reader can see, so a later layout can keep that spot still. */
function cardOnGlass(
  layout: GridLayout,
  scrollTop: number,
  viewH: number,
): { id: number; top: number } | null {
  const h = layout.metrics.cardH;
  const bottom = scrollTop + Math.max(viewH, 1);
  const seen = layout.cards.find((c) => c.top + h > scrollTop && c.top < bottom);
  if (seen) return { id: seen.film.id, top: seen.top };
  return layout.anchor ? { id: layout.anchor.film.id, top: layout.anchor.top } : null;
}

function openedAt(layout: GridLayout, viewH: number): number {
  const card = layout.anchor;
  if (!card || viewH <= 0) return 0;
  const raw = Math.max(0, card.top + layout.metrics.cardH / 2 - viewH / 2);
  return Math.floor(raw / WARM_STEP) * WARM_STEP;
}

const Card = memo(function Card({
  card,
  layout,
  people,
  codes,
  said,
  opacity,
  eager,
  onOpen,
  onHover,
}: {
  card: Placed;
  /** What this card says, once it has arrived. Its place is already
   *  settled either way, so nothing moves when it does. */
  said: GridFilm | undefined;
  layout: GridLayout;
  people: Map<number, GridPerson>;
  codes: Map<number, string>;
  opacity: number;
  /** On the glass, so its poster loads ahead of the ones waiting above and below. */
  eager: boolean;
  onOpen: (filmId: number) => void;
  onHover: (people: number[]) => void;
}) {
  const { film } = card;
  const { cardW, cardH, titleLines, posterW, posterH } = layout.metrics;
  const on = said?.people ?? [];
  const shared = on.length > 1;
  // The searched film is everyone's, so saying so on the card says nothing.
  const markers = film.isAnchor
    ? { show: [], extra: 0, initials: false }
    : markersFor(on, layout.metrics, film.rating);
  const poster = said?.poster ? sizedTmdbUrl(said.poster, posterW) : undefined;
  const tone = { ['--poster-colour' as string]: colourFor(said?.title ?? String(film.id)) };
  return (
    <button
      type="button"
      className={`cd-card${film.isAnchor ? ' cd-card-anchor' : ''}${shared ? ' cd-card-shared' : ''}${said ? '' : ' cd-card-waiting'}`}
      style={{
        left: card.left,
        top: card.top,
        width: cardW,
        height: cardH,
        opacity,
        ['--lines' as string]: titleLines,
        ['--poster-w' as string]: `${posterW}px`,
      }}
      aria-label={`${said?.title ?? 'Loading'}, ${film.year}, rated ${film.rating == null ? 'not yet' : film.rating.toFixed(1)}`}
      onClick={() => onOpen(film.id)}
      onMouseEnter={() => onHover(on)}
      onMouseLeave={() => onHover([])}
    >
      {poster ? (
        <img
          className="cd-card-poster"
          src={poster}
          alt=""
          width={posterW}
          height={posterH}
          decoding="async"
          fetchPriority={eager ? 'high' : 'low'}
          style={tone}
        />
      ) : (
        <span className="cd-card-poster" style={tone} aria-hidden="true" />
      )}
      <span className="cd-card-body">
        <span className="cd-card-title">{said?.title ?? ''}</span>
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
      </span>
    </button>
  );
});

/** A card is full strength when nothing is narrowing the grid, or when it
 *  holds someone being previewed or selected and clears the rating floor.
 *  A hovered chip previews just that person and overrides the selection
 *  while the pointer is on it.
 *
 *  Narrowing only ever changes opacity. The searched film is the one
 *  exception: it is the centre of its own map and stays lit. */
export function opacityOf(
  card: Placed,
  /** Who is on this card. Undefined while its detail is still coming;
   *  a card is given the benefit of the doubt until it can be judged. */
  people: number[] | undefined,
  selected: Set<number>,
  hovered: number | null,
  minRating: number | null = null,
): number {
  if (card.film.isAnchor) return 1;
  const rated = passesFloor(card.film.rating, minRating);
  const on = people ?? [];
  const unknown = people === undefined;
  if (hovered != null) {
    return rated && (unknown || on.includes(hovered)) ? 1 : DIM_PREVIEW;
  }
  if (!rated) return DIM_SELECTED;
  if (selected.size === 0) return 1;
  return unknown || on.some((id) => selected.has(id)) ? 1 : DIM_SELECTED;
}
