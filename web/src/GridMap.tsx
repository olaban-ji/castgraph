import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  inWarmSpan,
  initialsFor,
  isLit,
  layoutGrid,
  markersFor,
  passesFloor,
  railLabelTop,
  revealDelay,
  searchedTagAt,
  type GridFilm,
  warmSpan,
  type GridLayout,
  type GridPayload,
  type GridPerson,
  type GridSettings,
  type Placed,
} from './grid';
import { PosterImage } from './PosterImage';
import { posterFallback, sheetPosterURL } from './poster';
import { personVars } from './personColour';
import { canHover, useOffScreen, useTapGuard } from './tap';
import { useResolvedTheme, type Theme } from './theme';
import { markAppScroll, type AppScroll } from './overHeader';

interface Props {
  /** What each visible card says, by film id. A card with nothing here
   *  is drawn as its own empty box until its detail arrives. */
  detail: Map<string, GridFilm>;
  /** Cards in view whose detail we do not have yet. */
  onNeedDetail: (ids: string[]) => void;
  payload: GridPayload;
  settings: GridSettings;
  /** People the reader has selected, as places in the chip row, which is
   *  how the spine names them; empty means everyone. Both the dimming and
   *  the hiding of empty years are judged on the spine, because a card
   *  nobody has scrolled to has no detail to judge. */
  selectedIdx: Set<number>;
  /** A person being previewed by a pointer resting on their chip. */
  hovered: string | null;
  /** Called with the people on the card under the pointer, to light chips. */
  onCardHover: (people: string[]) => void;
  onOpen: (filmId: string) => void;
  /** The moment the cards start appearing, so the loading toast can go. */
  onRevealed?: () => void;
  /** A sheet or popover is up: the floating buttons get out of its way. */
  covered?: boolean;
  /** Bumped when a setting has rearranged the plot underneath. */
  recentreKey?: number;
  /** The scrolling element, held by the app so the header can watch it. */
  scroller: RefObject<HTMLDivElement | null>;
  /** How much of the top of the scroller the header is lying over. The
   *  plot starts that far down, and centring only ever uses what is
   *  below it. Zero when the header sits above the map instead. */
  overlayH?: number;
  /** The small card, for a phone or a landscape phone. A screen-class
   *  call rather than a width: a landscape phone is as wide as a small
   *  tablet and still has a phone's height to fit rows into. */
  compact?: boolean;
  /** Marked before every scroll the map makes by itself, so the header
   *  lying over it can tell those from the reader's own. */
  appScroll?: RefObject<AppScroll>;
}

/** How opaque a card that does not match the selection is. */
const DIM_SELECTED = 0.12;
const DIM_PREVIEW = 0.22;

/** The map is laid out first and flipped to visible a moment later, so
 *  every card has a state to travel out of. */
const REVEAL_FLIP_MS = 30;

/** How long the opening stays open after that. Once it closes a card
 *  that dims for a filter does so at once, with no ripple behind it. */
const REVEAL_WINDOW_MS = 1000;

/** Roughly how long the smooth scroll takes, after which the searched
 *  card is ringed so the reader can see where they were put. */
const GLIDE_MS = 420;
const RING_MS = 900;

/** The reflow when years are hidden or shown again. Cards that stay
 *  glide to their new row; cards that leave fade where they were; cards
 *  that arrive fade in a moment behind them. */
const REFLOW_MS = 260;
const GHOST_MS = 140;
const ARRIVE_DELAY_MS = 60;
/** One painted frame: long enough for a mounted "from" state to be on
 *  screen, which is what a transition needs to travel out of. */
const FLIP_MS = 30;

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
  selectedIdx,
  hovered,
  onCardHover,
  onOpen,
  detail,
  onNeedDetail,
  onRevealed,
  covered = false,
  recentreKey = 0,
  scroller,
  overlayH = 0,
  compact,
  appScroll,
}: Props) {
  const tap = useTapGuard();
  // The poster fallback is painted in JavaScript, not CSS, so it is the
  // one colour that has to be read rather than inherited.
  const theme = useResolvedTheme();
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
  // Read inside listeners that outlive a render, so they never centre
  // on a header height that has since changed.
  const lift = useRef(overlayH);
  lift.current = overlayH;

  const readView = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const height = el.clientHeight || window.innerHeight;
    const scrollTop = Math.floor(Math.max(0, el.scrollTop - lift.current) / WARM_STEP) * WARM_STEP;
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
      tap.onScroll();
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
  }, [readView, tap, scroller]);

  // Cards the reader already has keep their seat when a later page
  // arrives. A new map, or a width that changes the axis, starts again.
  // The spine is the whole grid, so this runs once per grid and width.
  // There is no earlier layout to carry forward: every card's place was
  // already final the first time. A change of card size — a window
  // resized across the landscape-phone line — is a new layout too, not
  // a reflow: nothing is where it was to glide from.
  const layout = useMemo(
    () =>
      width > 0
        ? layoutGrid(
            payload,
            width,
            settings,
            (f) => isLit(f, selectedIdx, settings.minRating),
            compact,
          )
        : null,
    [payload, width, settings, selectedIdx, compact],
  );
  // What the rows are laid out against, so a reflow can tell a change
  // of filter from a change of map or of width.
  const filterSig = `${settings.hideEmptyYears}|${settings.minRating}|${[...selectedIdx].sort((a, b) => a - b).join(',')}`;
  const reflow = useReflow(layout, filterSig, scroller, settings.hideEmptyYears, appScroll);
  const codes = useMemo(() => initialsFor(payload.people), [payload.people]);
  const byId = useMemo(
    () => new Map(payload.people.map((p) => [p.id, p])),
    [payload.people],
  );
  // The chip under the pointer, in the spine's own terms. -1 for an id
  // this row does not hold, which no card carries.
  const hoveredIdx = useMemo(
    () => (hovered == null ? null : payload.people.findIndex((p) => p.id === hovered)),
    [hovered, payload.people],
  );

  const reveal = useReveal(payload.anchor.id, onRevealed);
  // Set the moment the glide lands, so the reader's eye is told where it
  // was taken rather than being left to find the film again.
  const [confirming, setConfirming] = useState(false);
  const ring = useRef(0);
  useEffect(() => () => window.clearTimeout(ring.current), []);

  const recentre = useCallback(
    (smooth: boolean) => {
      const el = scroller.current;
      const card = layout?.anchor;
      if (!el || !card) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      markAppScroll(appScroll, smooth && !reduced);
      el.scrollTo({
        left: Math.max(0, card.left + layout.metrics.cardW / 2 - el.clientWidth / 2),
        top: Math.max(
          0,
          card.top + overlayH + layout.metrics.cardH / 2 - (el.clientHeight + overlayH) / 2,
        ),
        behavior: smooth && !reduced ? 'smooth' : 'auto',
      });
      if (!smooth) return;
      window.clearTimeout(ring.current);
      ring.current = window.setTimeout(() => {
        setConfirming(true);
        ring.current = window.setTimeout(() => setConfirming(false), RING_MS);
      }, GLIDE_MS);
    },
    [layout, overlayH, scroller, appScroll],
  );

  // A setting that reorders the years or adds a column pulls the plot
  // out from under the reader. The searched film goes back to the middle
  // at once, without a glide: nothing is where it was to glide from.
  const laidOut = useRef(recentreKey);
  useEffect(() => {
    if (recentreKey === laidOut.current) return;
    laidOut.current = recentreKey;
    recentre(false);
    readView();
  }, [recentreKey, recentre, readView]);

  // Every new grid opens centred on the film that was searched for. A
  // resize is not a new grid, so it keeps the reader where they were.
  // Until that scroll has landed, the cards drawn are the ones around the
  // film — not the top of the plot, which is where the scroller still is.
  const [placedFor, setPlacedFor] = useState<string | null>(null);
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
  }, [layout, width, payload.anchor.id, placedFor, recentre, readView, scroller]);

  // Rows added above the screen would shove the cards the reader is
  // looking at down the page. Pin a card that is on the glass — not
  // only the searched film, which they may have already scrolled past.
  const pin = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!layout || !el) return;
    const prev = pin.current;
    // A reflow pins the searched film itself and has already moved the
    // scroller for it. Pinning a second card on top of that would move
    // the map twice for one change.
    if (reflow.handled.current) {
      reflow.handled.current = false;
      readView();
    } else if (prev) {
      const card = layout.cards.find((c) => c.film.id === prev.id);
      if (card) {
        const delta = card.top - prev.top;
        if (delta !== 0) {
          markAppScroll(appScroll, false);
          el.scrollTop += delta;
          readView();
        }
      }
    }
    pin.current = cardOnGlass(layout, el.scrollTop - overlayH, el.clientHeight);
  }, [layout, readView, overlayH, scroller, reflow, appScroll]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!layout || !el) return;
    const remember = () => {
      pin.current = cardOnGlass(layout, el.scrollTop - overlayH, el.clientHeight);
    };
    el.addEventListener('scroll', remember, { passive: true });
    return () => el.removeEventListener('scroll', remember);
  }, [layout, overlayH, scroller]);

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
  // A flick that ends on a card was a flick. Only a press that stayed
  // put, on a map that had already stopped, opens anything.
  const openIfMeant = useCallback(
    (id: string) => {
      if (tap.allows()) onOpen(id);
    },
    [tap, onOpen],
  );

  // A finger cannot rest on a card, so on a touch screen a "hover" is
  // the tap itself, and lighting the chips from it says nothing.
  const lightIfHovering = useCallback(
    (people: string[]) => {
      if (canHover()) onCardHover(people);
    },
    [onCardHover],
  );

  // Recenter is only worth offering when the film it would go to is not
  // already in front of the reader.
  const anchorAt = useCallback(() => {
    const card = layout?.anchor;
    if (!card || !layout) return null;
    return {
      x: card.left + layout.metrics.cardW / 2,
      y: card.top + overlayH + layout.metrics.cardH / 2,
    };
  }, [layout, overlayH]);
  const away = useOffScreen(scroller, anchorAt, [anchorAt]);

  const wantedKey = cards.map((c) => c.film.id).join(',');
  useEffect(() => {
    if (cards.length === 0) return;
    const missing = cards.map((c) => c.film.id).filter((id) => !detail.has(id));
    if (missing.length > 0) onNeedDetail(missing);
    // wantedKey stands for the set of cards in reach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, detail, onNeedDetail]);

  // The panel draws a larger poster than the card. For the cards on the
  // glass, that file is fetched now, quietly, so opening one does not
  // wait on the network.
  const glassKey = layout
    ? cards
        .filter((c) => inWarmSpan(c.top, layout.metrics.cardH, screen))
        .map((c) => c.film.id)
        .join(',')
    : '';
  const warmed = useRef(new Set<string>());
  useEffect(() => {
    if (!glassKey) return;
    for (const id of glassKey.split(',')) {
      const src = sheetPosterURL(detail.get(id)?.poster);
      if (!src || warmed.current.has(src)) continue;
      warmed.current.add(src);
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.src = src;
    }
  }, [glassKey, detail]);

  return (
    <>
      <div
        className="cd-scroller"
        ref={scroller}
        id="cd-grid"
        role="region"
        aria-label="Movies by year and rating"
        onPointerDown={tap.onPointerDown}
        onPointerMove={tap.onPointerMove}
      >
        {layout && (
          <div
            className="cd-plot-wrap"
            style={{ width: layout.plotW, ['--rail-w' as string]: `${layout.metrics.railW}px` }}
          >
            {overlayH > 0 && <div style={{ height: overlayH }} aria-hidden="true" />}
            {/* The rating scale, said in words. It is inside the plot, so
                it pans sideways with the gridlines it labels, and after
                the overlay spacer, so on a phone it starts under the
                over-header and appears as that header goes up. */}
            <div className="cd-axis" aria-hidden="true">
              {settings.showUnrated && (
                <span className="cd-axis-label cd-axis-unrated">Unrated</span>
              )}
              {/* What the columns are, said once where the scale starts.
                  It is there with the unrated column off too, when it
                  takes the place "Unrated" had. */}
              <span className="cd-axis-label cd-axis-title" style={{ left: layout.axisTitleLeft }}>
                IMDb rating →
              </span>
              {layout.lines.map((l) => (
                <span key={l.rating} className="cd-axis-label" style={{ left: l.labelLeft }}>
                  {l.label}
                </span>
              ))}
            </div>
            <div className="cd-plot" style={{ height: layout.plotH }}>
              {layout.rows.map((r) =>
                r.isBreak ? (
                  <div
                    key="break"
                    className="cd-band cd-band-break"
                    style={{ top: r.top, height: r.height }}
                    aria-hidden="true"
                  />
                ) : (
                  <div
                    key={r.year}
                    className={`cd-band${r.index % 2 === 1 ? ' cd-band-odd' : ''}${r.anchorYear ? ' cd-band-anchor' : ''}${r.decade ? ' cd-band-decade' : ''}`}
                    style={{ top: r.top, height: r.height }}
                  />
                ),
              )}
              {settings.showUnrated && (
                <div className="cd-unrated-edge" style={{ left: layout.unratedEdge }} />
              )}
              {layout.lines.map((l) => (
                <div key={l.rating} className="cd-gridline" style={{ left: l.x }} />
              ))}
              {reflow.ghosts.map((c) => (
                <Card
                  key={`ghost:${c.film.id}`}
                  card={c}
                  said={detail.get(c.film.id)}
                  layout={layout}
                  people={byId}
                  codes={codes}
                  opacity={reflow.ghostsOut ? 0 : 1}
                  eager={false}
                  enter={null}
                  ringed={false}
                  theme={theme}
                  ghost
                  onOpen={openIfMeant}
                  onHover={lightIfHovering}
                />
              ))}
              {cards.map((c) => (
                <Card
                  key={c.film.id}
                  card={c}
                  said={detail.get(c.film.id)}
                  layout={layout}
                  people={byId}
                  codes={codes}
                  opacity={opacityOf(c, selectedIdx, hoveredIdx, settings.minRating)}
                  eager={inWarmSpan(c.top, layout.metrics.cardH, screen)}
                  enter={
                    reveal.entering
                      ? {
                          hidden: !reveal.shown && !c.film.isAnchor,
                          delay: revealDelay(c, layout.anchor),
                        }
                      : null
                  }
                  ringed={confirming && c.film.isAnchor}
                  theme={theme}
                  arriving={reflow.arriving.has(c.film.id)}
                  onOpen={openIfMeant}
                  onHover={lightIfHovering}
                />
              ))}
              <div className="cd-rail-layer" style={{ height: layout.plotH, width: layout.plotW }}>
                <div className="cd-rail" style={{ width: layout.metrics.railW, height: layout.plotH }}>
                  {layout.rows.map((r) =>
                    r.isBreak ? (
                      <span
                        key="break"
                        className="cd-rail-year cd-rail-break"
                        style={{ top: railLabelTop(r) }}
                        aria-hidden="true"
                      >
                        · · ·
                      </span>
                    ) : (
                      <span
                        key={r.year}
                        className={`cd-rail-year${r.decade ? ' cd-rail-decade' : ''}${r.anchorYear ? ' cd-rail-anchor' : ''}`}
                        style={{ top: railLabelTop(r) }}
                      >
                        {r.year}
                      </span>
                    ),
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <button
        type="button"
        className={`cd-float cd-recentre${away && !covered ? ' cd-float-up' : ''}`}
        aria-label={`Recenter on ${payload.anchor.title}`}
        aria-hidden={away && !covered ? undefined : true}
        inert={away && !covered ? undefined : true}
        onClick={() => recentre(true)}
      >
        <span className="cd-float-pill">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="7" />
            <circle cx="12" cy="12" r="2" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
          Recenter
        </span>
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
): { id: string; top: number } | null {
  const h = layout.metrics.cardH;
  const bottom = scrollTop + Math.max(viewH, 1);
  const seen = layout.cards.find((c) => c.top + h > scrollTop && c.top < bottom);
  if (seen) return { id: seen.film.id, top: seen.top };
  return layout.anchor ? { id: layout.anchor.film.id, top: layout.anchor.top } : null;
}

/** The opening ripple. A new map mounts with everything but the searched
 *  film hidden; a moment later they are all let go at once, each waiting
 *  for its own distance from that film before it arrives.
 *
 *  Timers, not frames: a page that is not being painted — one opened in a
 *  background tab — never gets a frame, and a map hung off one would
 *  still be invisible when the reader finally looked at it. */
function useReveal(
  anchorId: string,
  onRevealed: (() => void) | undefined,
): { entering: boolean; shown: boolean } {
  // A reader who has asked for nothing to move gets the map whole, with
  // no hidden state to come out of.
  const still = useRef(false);
  const fresh = () => {
    still.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return { id: anchorId, entering: !still.current, shown: still.current };
  };
  const [state, setState] = useState(fresh);
  if (state.id !== anchorId) setState(fresh());
  const landed = useRef(onRevealed);
  landed.current = onRevealed;
  useEffect(() => {
    if (still.current) {
      landed.current?.();
      return;
    }
    const flip = window.setTimeout(() => {
      setState((was) => (was.id === anchorId ? { ...was, shown: true } : was));
      landed.current?.();
    }, REVEAL_FLIP_MS);
    const settle = window.setTimeout(
      () => setState((was) => (was.id === anchorId ? { ...was, entering: false } : was)),
      REVEAL_FLIP_MS + REVEAL_WINDOW_MS,
    );
    return () => {
      window.clearTimeout(flip);
      window.clearTimeout(settle);
    };
  }, [anchorId]);
  return { entering: state.entering, shown: state.shown };
}

function openedAt(layout: GridLayout, viewH: number): number {
  const card = layout.anchor;
  if (!card || viewH <= 0) return 0;
  const raw = Math.max(0, card.top + layout.metrics.cardH / 2 - viewH / 2);
  return Math.floor(raw / WARM_STEP) * WARM_STEP;
}

/** The FLIP reflow for hiding and showing the empty years.
 *
 *  Rows leaving above the reader would carry the whole map up the
 *  screen, so the searched film is pinned — not a card that happens to
 *  be on the glass, which is what an ordinary relayout pins. This is
 *  the one movement the reader asked for, and it should look like the
 *  map closing up around the film it is of.
 *
 *  Cards are moved by writing to their style directly. React has just
 *  committed their new positions; what is wanted is the old one for a
 *  single frame, and a state round trip for that would be a frame late.
 */
function useReflow(
  layout: GridLayout | null,
  sig: string,
  scroller: RefObject<HTMLDivElement | null>,
  hiding: boolean,
  appScroll: RefObject<AppScroll> | undefined,
): {
  ghosts: Placed[];
  ghostsOut: boolean;
  arriving: Set<string>;
  /** Set for the one layout this hook moved the scroller for, so the
   *  ordinary pin does not move it a second time. */
  handled: RefObject<boolean>;
} {
  const handled = useRef(false);
  const last = useRef<{ sig: string; hiding: boolean; cards: Placed[] } | null>(null);
  const [ghosts, setGhosts] = useState<Placed[]>([]);
  // A ghost mounts where it was, at the opacity it had, and is let go a
  // frame later. Mounted already faded, it would simply vanish.
  const [ghostsOut, setGhostsOut] = useState(false);
  const [arriving, setArriving] = useState<Set<string>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!layout || !el) return;
    const before = last.current;
    last.current = { sig, hiding, cards: layout.cards };
    // Only a change of filter reflows. A new map, a resize or a year
    // range each put the reader somewhere else entirely, and gliding
    // three hundred cards across that would be motion about nothing.
    if (!before || before.sig === sig || (!hiding && !before.hiding)) return;

    const was = new Map(before.cards.map((c) => [c.film.id, c]));
    const now = new Map(layout.cards.map((c) => [c.film.id, c]));
    const anchorId = layout.anchor?.film.id;
    const anchorWas = anchorId ? was.get(anchorId) : undefined;
    const anchorNow = anchorId ? now.get(anchorId) : undefined;
    const shift = anchorWas && anchorNow ? anchorNow.top - anchorWas.top : 0;
    if (shift !== 0) {
      markAppScroll(appScroll, false);
      el.scrollTop += shift;
    }
    handled.current = true;

    const left = before.cards.filter((c) => !now.has(c.film.id));
    const came = new Set([...now.keys()].filter((id) => !was.has(id)));

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setGhosts([]);
      setArriving(new Set());
      return;
    }

    setGhosts(left);
    setGhostsOut(false);
    setArriving(came);
    timers.current.push(window.setTimeout(() => setGhostsOut(true), FLIP_MS));
    timers.current.push(
      window.setTimeout(() => {
        setGhosts([]);
        setGhostsOut(false);
      }, FLIP_MS + GHOST_MS),
    );
    // Held back a moment, so the cards that only moved are where they
    // are going before anything new appears among them.
    timers.current.push(
      window.setTimeout(() => setArriving(new Set()), ARRIVE_DELAY_MS + FLIP_MS),
    );

    // Put every card that stayed back where it was on screen, then let
    // it go on the next frame.
    const moved: HTMLElement[] = [];
    for (const [id, card] of now) {
      const old = was.get(id);
      if (!old) continue;
      const dx = old.left - card.left;
      const dy = old.top - card.top + shift;
      if (dx === 0 && dy === 0) continue;
      // The searched card's tag sits beside it, not in it, so it is
      // moved with it.
      const key = CSS.escape(id);
      for (const node of el.querySelectorAll<HTMLElement>(
        `[data-card="${key}"], [data-card-tag="${key}"]`,
      )) {
        node.style.transition = 'none';
        node.style.transform = `translate(${dx}px, ${dy}px)`;
        moved.push(node);
      }
    }
    if (moved.length === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const node of moved) {
        node.style.transition = `transform ${REFLOW_MS}ms var(--ease-glide)`;
        node.style.transform = '';
      }
      timers.current.push(
        window.setTimeout(() => {
          for (const node of moved) {
            node.style.transition = '';
            node.style.transform = '';
          }
        }, REFLOW_MS),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, sig, hiding, scroller, appScroll]);

  return { ghosts, ghostsOut, arriving, handled };
}

const Card = memo(function Card({
  card,
  layout,
  people,
  codes,
  said,
  opacity,
  eager,
  enter,
  ringed,
  theme,
  arriving = false,
  ghost = false,
  onOpen,
  onHover,
}: {
  card: Placed;
  /** What this card says, once it has arrived. Its place is already
   *  settled either way, so nothing moves when it does. */
  said: GridFilm | undefined;
  layout: GridLayout;
  people: Map<string, GridPerson>;
  codes: Map<string, string>;
  opacity: number;
  /** On the glass, so its poster loads ahead of the ones waiting above and below. */
  eager: boolean;
  /** Set while the map is opening: whether this card is still waiting to
   *  appear, and how long it waits once they are all let go. */
  enter: { hidden: boolean; delay: number } | null;
  /** Just been scrolled back to, and saying so for a moment. */
  ringed: boolean;
  /** Which theme the poster fallback and the people's colours are
   *  mixed for. */
  theme: Theme;
  /** Just placed by a reflow, so it fades in a moment behind the cards
   *  that only moved. */
  arriving?: boolean;
  /** A card that has just left, held at its old place for long enough
   *  to fade rather than vanish. */
  ghost?: boolean;
  onOpen: (filmId: string) => void;
  onHover: (people: string[]) => void;
}) {
  const { film } = card;
  const { cardW, cardH, titleLines, posterW, posterH } = layout.metrics;
  const on = said?.people ?? [];
  // The searched film is everyone's, so saying so on the card says nothing.
  const markers = film.isAnchor
    ? { show: [], extra: 0, initials: false }
    : markersFor(on, layout.metrics, film.rating, codes);
  const fill = {
    ['--poster-fill' as string]: posterFallback(said?.title ?? String(film.id), theme),
  };
  const waiting = enter?.hidden ?? false;
  const shownAt = waiting || arriving ? 0 : opacity;
  // The searched card says so in its label, so the tag beside it is
  // drawn and not read.
  const label = `${said?.title ?? 'Loading'}, ${film.year}, rated ${film.rating == null ? 'not yet' : film.rating.toFixed(1)}${film.isAnchor ? ', the searched movie' : ''}`;
  const tag = film.isAnchor && !ghost ? searchedTagAt(card) : null;
  return (
    <>
      <button
        type="button"
        data-card={ghost ? undefined : film.id}
        aria-hidden={ghost || undefined}
        inert={ghost || undefined}
        className={`cd-card${film.isAnchor ? ' cd-card-anchor' : ''}${said ? '' : ' cd-card-waiting'}${enter ? ' cd-card-entering' : ''}${ringed ? ' cd-card-ringed' : ''}${ghost ? ' cd-card-ghost' : ''}`}
        style={{
          left: card.left,
          top: card.top,
          width: cardW,
          height: cardH,
          opacity: shownAt,
          transform: waiting ? 'translateY(8px) scale(0.98)' : undefined,
          transitionDelay: enter && !waiting ? `${enter.delay}ms` : undefined,
          pointerEvents: waiting || ghost ? 'none' : undefined,
          ['--lines' as string]: titleLines,
          ['--poster-w' as string]: `${posterW}px`,
        }}
        tabIndex={waiting ? -1 : undefined}
        aria-label={label}
        onClick={() => onOpen(film.id)}
        onMouseEnter={() => onHover(on)}
        onMouseLeave={() => onHover([])}
      >
        <PosterImage
          id={film.id}
          url={said?.poster}
          cssPx={posterW}
          className="cd-card-poster"
          width={posterW}
          height={posterH}
          eager={eager}
          style={fill}
        />
        <span className="cd-card-body">
          <span className="cd-card-title">{said?.title ?? ''}</span>
          <span className="cd-card-foot">
            <span className={`cd-card-rating${film.rating == null ? ' cd-card-unrated' : ''}`}>
              {film.rating == null ? 'No rating' : film.rating.toFixed(1)}
            </span>
            <span className="cd-card-spacer" />
            {/* For the eye only: the card's own label is what is read
                out, and the sheet names everyone by name. */}
            {markers.show.map((id) => (
              <span
                key={id}
                className="cd-card-mark"
                style={personVars({ id, role: people.get(id)?.role ?? 'cast' }, theme)}
                aria-hidden="true"
              >
                <span className="cd-card-swatch" />
                {markers.initials && (codes.get(id) ?? '?')}
              </span>
            ))}
            {markers.extra > 0 && (
              <span className="cd-more" aria-hidden="true">
                +{markers.extra}
              </span>
            )}
          </span>
        </span>
      </button>
      {tag && (
        // Beside the card rather than in it, because the card clips what
        // overflows it. It comes and goes with the card, and a reflow
        // carries it along by the same id.
        <span
          className="cd-searched-tag"
          data-card-tag={film.id}
          aria-hidden="true"
          style={{ left: tag.left, top: tag.top, opacity: shownAt }}
        >
          Searched
        </span>
      )}
    </>
  );
});

/** A card is full strength when nothing is narrowing the grid, or when it
 *  holds someone being previewed or selected and clears the rating floor.
 *  A hovered chip previews just that person and overrides the selection
 *  while the pointer is on it.
 *
 *  Judged on the spine, which says who is on every card from the first
 *  paint. The detail is not needed, and waiting for it would light a card
 *  scrolled into view under a selection and then dim it when its words
 *  arrived.
 *
 *  Narrowing only ever changes opacity. The searched film is the one
 *  exception: it is the centre of its own map and stays lit. */
export function opacityOf(
  card: Placed,
  /** The selection, as places in the chip row. */
  selected: Set<number>,
  /** The chip being previewed, as a place in the chip row. A person
   *  the row does not hold — a hover left over from the film just
   *  left — is any index no card carries, and dims them all. */
  hovered: number | null,
  minRating: number | null = null,
): number {
  if (card.film.isAnchor) return 1;
  if (hovered != null) {
    return passesFloor(card.film.rating, minRating) && card.film.people.includes(hovered)
      ? 1
      : DIM_PREVIEW;
  }
  return isLit(card.film, selected, minRating) ? 1 : DIM_SELECTED;
}
