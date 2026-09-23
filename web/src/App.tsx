import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchFirstRun, fetchPathways, type SearchHit } from './api';
import { FilmColumn } from './FilmColumn';
import { FilmSheet } from './FilmSheet';
import { firstRunFilms, tilesFrom } from './firstRun';
import { easeInOutCubic, GLIDE_SETTLE_MS, glideDurationMs } from './glide';
import {
  filterSummary,
  NO_FILTERS,
  peopleOnMap,
  visibleFilms as filteredFilms,
  yearBounds,
  type MapFilters,
} from './filters';
import { Header } from './Header';
import {
  deviceFor,
  distanceToCentre,
  filmsWithin,
  GEOMETRY,
  HEADER_H,
  LayoutCache,
  layoutTree,
  scrollPosForFilm,
  type Device,
  type Layout,
  type Viewport,
} from './layout';
import { LIVE_AT, MapCanvas } from './MapCanvas';
import { TraceBar } from './TraceBar';
import { traceRoute } from './trace';
import { filmHref, filmPath, movieIdFromState, routeFrom } from './movieParam';
import { capture } from './analytics';
import {
  buildTree,
  canDeepen,
  deepenTree,
  extendTree,
  filterPathways,
  filmsRequested,
  peopleFor,
  personIdByName,
  provisionalPathways,
  RULES,
  seedsOfPerson,
  widenPerson,
  type MapFilm,
  type MapTree,
} from './tree';
import { isDragPanChrome, isDragPanStart, useDragPan } from './pan';
import { useScrollIdle, useViewport } from './useViewport';
import { YearRail } from './YearRail';
import {
  clampZoom,
  fitZoom,
  pinchScale,
  pointerDistance,
  wheelDeltaPx,
  zoomAfterWheel,
  ZOOM_STEP,
} from './zoom';

/** Pathway requests in flight at once. Warm ones answer in milliseconds;
 *  a cold one is a crawl, and the API warms the next hop behind each. */
const EXPAND_CONCURRENCY = 4;

/** How far beyond the lit screen a stop is expanded, in screens. */
const EXPAND_MARGIN = LIVE_AT;

/** Growth is paid for in scrolling: a stop born from an expansion is not
 *  expanded itself until the reader has scrolled this many screens since
 *  it appeared. Without this a stop's children land in the same viewport,
 *  get expanded, and the map grows forever while nobody moves. */
const SCROLL_PER_GENERATION = 0.5;

/** Cards per screen of area the map may fill before expansion pauses
 *  there (one card per this many canvas px²). Scrolling to a sparser
 *  region resumes it. Keeps any one screen readable. */
const PX_PER_CARD = 420 * 260;

/** How close to the centre of the screen a stop must be to expand on a
 *  screen that is already full. */
const SPOTLIGHT_RADIUS = 180;

/** Hard ceiling on films in one map; a memory guard, not a design rule.
 *  Phones keep a tighter cap so the JS heap and decoded-image cache
 *  cannot grow without bound while the reader scrolls. */
const MAX_FILMS: Record<Device, number> = {
  phone: 400,
  tablet: 900,
  desktop: 1500,
};

export function App() {
  const [movieId, setMovieId, canGoBack, goBack] = useFilmRoute();
  const page = useViewport();
  // ?device=phone|tablet|desktop pins a geometry for review, as in the handoff.
  const device = useMemo(() => {
    const pin = new URLSearchParams(location.search).get('device');
    return pin === 'phone' || pin === 'tablet' || pin === 'desktop'
      ? pin
      : deviceFor(page.vw);
  }, [page.vw]);
  const fit = useMemo(
    () => fitZoom(page.vw, page.vh, GEOMETRY[device]),
    [page.vw, page.vh, device],
  );
  const [zoom, setZoom, resetZoom] = useZoom(fit, movieId, device);
  // The reader's window in canvas coordinates.
  const viewport = useMemo<Viewport>(
    () => ({
      sx: page.sx / zoom,
      sy: page.sy / zoom,
      vw: page.vw / zoom,
      vh: page.vh / zoom,
    }),
    [page, zoom],
  );

  const treeRef = useRef<MapTree | null>(null);
  const deepeningRef = useRef(new Set<string>());
  const loadedFor = useRef<number | null | undefined>(undefined);
  if (loadedFor.current !== movieId) {
    loadedFor.current = movieId;
    treeRef.current = null;
    deepeningRef.current.clear();
  }
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<SearchHit | null>(null);
  // The cold screen's eight. The built-in shelves render at once so the
  // screen is never empty or shifting, and the graph's own eight — drawn
  // from thousands rather than forty-eight — replace them when they
  // arrive. A failed or thin answer leaves the shelves in place.
  const [firstRun, setFirstRun] = useState(firstRunFilms);
  useEffect(() => {
    if (movieId !== null) return;
    const ctrl = new AbortController();
    fetchFirstRun(ctrl.signal)
      .then((hits) => {
        const tiles = tilesFrom(hits);
        if (tiles.length > 0) setFirstRun(tiles);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [movieId]);
  const [deepeningId, setDeepeningId] = useState<string | null>(null);
  const [filters, setFilters] = useState<MapFilters>(NO_FILTERS);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [tracing, setTracing] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  // Under the phone breakpoint the map becomes one chronological column.
  const column = device === 'phone';

  // Load the searched film's pathways and blow it out as the first seed.
  useEffect(() => {
    treeRef.current = null;
    setError(null);
    setDeepeningId(null);
    deepeningRef.current.clear();
    if (!movieId) return;
    // Draw what the search result already told us — the card and the rail
    // — and grow the map around it rather than holding a blank screen.
    const hint = opening?.id === movieId ? opening : null;
    if (hint) {
      treeRef.current = buildTree(
        provisionalPathways({
          id: `m:${hint.id}`,
          type: 'movie',
          label: hint.title,
          tmdb_id: hint.id,
          year: Number(hint.release_date?.slice(0, 4)) || undefined,
          poster: hint.poster,
        }),
      );
      bump();
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetchPathways(
      movieId,
      RULES.seedPeople,
      RULES.seedFilms + RULES.candidateSlack,
      { signal: ctrl.signal },
    )
      .then((pw) => {
        treeRef.current = buildTree(filterPathways(pw, filtersRef.current));
        bump();
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [movieId, bump]);

  const tree = treeRef.current;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const onDeepen = useCallback(
    (filmId: string) => {
      const t = treeRef.current;
      if (!t || !canDeepen(t, filmId) || deepeningRef.current.has(filmId)) return;
      if (t.films.size >= MAX_FILMS[device]) return;
      const film = t.films.get(filmId);
      if (!film) return;
      deepeningRef.current.add(filmId);
      setDeepeningId(filmId);
      capture('movie_deepened', { movie_id: film.movie.tmdb_id, title: film.movie.label });
      fetchPathways(
        film.movie.tmdb_id,
        RULES.seedPeople,
        RULES.seedFilms + RULES.candidateSlack,
      )
        .then((pw) => {
          const live = treeRef.current;
          if (!live) return;
          deepenTree(live, filmId, filterPathways(pw, filtersRef.current));
          bump();
        })
        .catch((e: Error) => {
          console.warn(`deepen ${filmId} failed: ${e.message}`);
          deepeningRef.current.delete(filmId);
        })
        .finally(() => {
          setDeepeningId((id) => (id === filmId ? null : id));
        });
    },
    [bump, device],
  );
  // Positions are cached per anchor and device; a new one starts fresh.
  const cache = useMemo(
    () => new LayoutCache(GEOMETRY[device]),
    [device, movieId],
  );
  // `version` is bumped whenever the tree (a mutable ref) grows.
  const layout = useMemo(
    () => (tree ? layoutTree(tree, cache) : null),
    [tree, cache, version],
  );

  const odometer = useScrollOdometer(page);
  // The column is its own scroll world: canvas coordinates mean nothing
  // there, so the camera and the viewport-driven growth stand down and
  // the reader grows the map from the sheet instead.
  useExpansion(tree, layout, viewport, odometer, bump, device, deepeningRef, !column);
  useWidenPerson(tree, filters.person, bump);
  const { glideToAnchor, glideToFilm, shiftGlide } = useGlideToAnchor(
    column ? null : layout,
    movieId,
    zoom,
  );
  const onCompensate = useCallback(
    (dx: number, dy: number) => {
      odometer.compensate(dx, dy);
      shiftGlide(dx, dy);
    },
    [odometer.compensate, shiftGlide],
  );
  useCentreAnchor(column ? null : layout, movieId, zoom);
  useDragPan();

  const onPick = useCallback(
    (id: number, label?: string, hit?: SearchHit) => {
      capture('movie_selected', { movie_id: id, title: label });
      setOpening(hit ?? (label ? { id, title: label, release_date: '' } : null));
      if (id === movieId) glideToAnchor();
      else setMovieId(id, label);
    },
    [movieId, glideToAnchor, setMovieId],
  );

  const onReanchor = useCallback(
    (filmId: string) => {
      const film = treeRef.current?.films.get(filmId);
      if (!film) return;
      setSheetId(null);
      onPick(film.movie.tmdb_id, film.movie.label, {
        id: film.movie.tmdb_id,
        title: film.movie.label,
        release_date: String(film.year),
        poster: film.movie.poster,
      });
    },
    [onPick],
  );

  const onOpenSheet = useCallback((filmId: string) => setSheetId(filmId), []);

  // What the filters leave on the map, and what the header needs to offer
  // as filter options. Recomputed with the layout, which is memoised.
  const visible = useMemo(
    () => (layout ? filteredFilms(layout, filters) : null),
    [layout, filters],
  );
  const people = useMemo(() => (layout ? peopleOnMap(layout.edges) : []), [layout]);
  // The route from the searched film through the traced person and
  // onward. Recomputed as the map grows, so it keeps up with it.
  const trace = useMemo(
    () => (layout && tracing ? traceRoute(layout, tracing) : null),
    [layout, tracing],
  );
  const onTrace = useCallback((person: string) => {
    setSheetId(null);
    setTracing(person);
    setStopId(null);
    capture('person_traced', { person });
  }, []);
  const clearTrace = useCallback(() => {
    setTracing(null);
    setStopId(null);
    setFilters((f) => (f.person ? { ...f, person: null } : f));
  }, []);
  // A lit route off the edge of the screen is not a route anyone can
  // follow, so the camera travels to the stop being shown. The stop is
  // held as a film, not a position: the map keeps growing underneath it,
  // and the reader should stay on the film they are looking at.
  const stops = trace?.stops ?? EMPTY_STOPS;
  const stopAt = stopId ? Math.max(0, stops.indexOf(stopId)) : 0;
  const stopFilm = stops[stopAt];
  useEffect(() => {
    if (stopFilm) glideToFilm(stopFilm);
  }, [stopFilm, glideToFilm]);

  // A new search is a new map; a trace through the old one means nothing.
  useEffect(() => {
    setTracing(null);
    setStopId(null);
    setFilters((f) => (f.person ? { ...f, person: null } : f));
  }, [movieId]);
  const bounds = useMemo(
    () => (layout ? yearBounds(layout.placed) : { min: 0, max: 0 }),
    [layout],
  );
  const summary = layout
    ? filterSummary(filters, visible ? visible.size : layout.placed.length, layout.placed.length)
    : '';

  const anchor = tree?.films.get(tree.anchorId);
  const shownTitle = anchor?.movie.label || opening?.title || '';
  useSlugInAddressBar(movieId, anchor?.movie.label);
  const shownYear = anchor?.year;
  const sheetFilm = sheetId && layout ? layout.byId.get(sheetId) ?? null : null;

  return (
    <>
      <a className="mc-skip" href="#mc-search-input">Skip to search</a>
      <Header
        title={shownTitle}
        year={shownYear}
        filters={filters}
        onFilters={setFilters}
        people={people}
        bounds={bounds}
        summary={summary}
        canGoBack={canGoBack}
        onBack={goBack}
        onPick={onPick}
      />
      {layout && tree ? (
        column ? (
          <FilmColumn
            layout={layout}
            visible={visible}
            trace={trace}
            onOpen={onOpenSheet}
            deepeningId={deepeningId}
          />
        ) : (
          <>
          <MapCanvas
            layout={layout}
            viewport={viewport}
            zoom={zoom}
            onCompensate={onCompensate}
            onDeepen={onDeepen}
            onReanchor={onReanchor}
            onOpen={onOpenSheet}
            deepeningId={deepeningId}
            deepened={tree.deepened}
            filters={filters}
            visible={visible}
            trace={trace}
          />
          <YearRail layout={layout} zoom={zoom} headerHeight={HEADER_H} />
          <div className="mc-zoom">
            <button
              aria-label="Recenter on original film"
              title="Recenter on original film"
              onClick={() => glideToAnchor()}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
            </button>
            <button aria-label="Zoom in" onClick={() => setZoom(zoom * ZOOM_STEP)}>
              +
            </button>
            <button aria-label="Zoom out" onClick={() => setZoom(zoom / ZOOM_STEP)}>
              −
            </button>
            <button
              aria-label="Reset zoom"
              className="mc-zoom-reset"
              onClick={() => resetZoom()}
            >
              {Math.round(zoom * 100)}%
            </button>
          </div>
          </>
        )
      ) : (
        <div className="mc-notice">
          <div>
            {error ? (
              <>
                <strong>Couldn’t open that film</strong>
                Try another title in the search bar.
              </>
            ) : loading ? (
              <div className="mc-loader">
                <div className="mc-loader-strip" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <strong>
                  {opening?.title ? `Opening ${opening.title}` : 'Opening the map'}
                </strong>
                Finding co-stars…
              </div>
            ) : (
              <div className="mc-firstrun">
                <strong>Every film is two films away from another</strong>
                Pick one and follow who made it.
                <div className="mc-tiles">
                  {firstRun.map((f) => (
                    <a
                      key={f.id}
                      className="mc-tile"
                      href={filmPath(f.id, f.title)}
                      onClick={(e) => {
                        e.preventDefault();
                        onPick(f.id, f.title, f);
                      }}
                    >
                      <img src={f.poster} alt="" width={104} height={156} loading="lazy" decoding="async" />
                      <span className="mc-tile-title">{f.title}</span>
                      <span className="mc-tile-year">{f.year}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {sheetFilm && layout && tree && (
        <FilmSheet
          film={sheetFilm}
          layout={layout}
          onDeepen={
            !sheetFilm.anchor && !tree.deepened.has(sheetFilm.id)
              ? (id) => {
                  onDeepen(id);
                  setSheetId(null);
                }
              : undefined
          }
          onReanchor={!sheetFilm.anchor ? onReanchor : undefined}
          onTrace={onTrace}
          onClose={() => setSheetId(null)}
          deepening={deepeningId === sheetFilm.id}
        />
      )}
      {trace && (
        <TraceBar
          trace={trace}
          stopAt={stopAt}
          canStep={!column}
          onStop={(i) => setStopId(stops[((i % stops.length) + stops.length) % stops.length])}
          onlyThis={filters.person === trace.person}
          onOnlyThis={(only) =>
            setFilters((f) => ({ ...f, person: only ? trace.person : null }))
          }
          onClear={clearTrace}
        />
      )}
    </>
  );
}

/** Nothing traced, so no stops; a constant keeps the hooks below stable. */
const EMPTY_STOPS: string[] = [];

/** Every map has an address: /film/603-the-matrix. A legacy ?movie= link
 *  is upgraded in place, and the back button walks through the maps this
 *  session opened — disabled when there are none. */
function useFilmRoute(): [number | null, (id: number, title?: string) => void, boolean, () => void] {
  const [id, setId] = useState<number | null>(() => {
    const { movieId, path } = routeFrom(location.href);
    if (path !== location.pathname + location.search + location.hash) {
      history.replaceState({ movie: movieId, depth: 0 }, '', path);
    }
    return movieId;
  });
  const [depth, setDepth] = useState<number>(() => historyDepth(history.state));

  useEffect(() => {
    const onPop = () => {
      setId(routeFrom(location.href).movieId ?? movieIdFromState(history.state));
      setDepth(historyDepth(history.state));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const set = useCallback((next: number, title?: string) => {
    const nextDepth = historyDepth(history.state) + 1;
    history.pushState({ movie: next, depth: nextDepth }, '', filmHref(next, title, location.href));
    setId(next);
    setDepth(nextDepth);
  }, []);

  const goBack = useCallback(() => history.back(), []);
  return [id, set, depth > 0, goBack];
}

/** A map opened by id alone gets its slug as soon as the title arrives,
 *  so what is copied out of the address bar says what it opens. */
function useSlugInAddressBar(movieId: number | null, title: string | undefined) {
  useEffect(() => {
    if (movieId === null || !title) return;
    const want = filmPath(movieId, title);
    if (location.pathname === want) return;
    if (!location.pathname.startsWith(`/film/${movieId}`)) return;
    history.replaceState(history.state, '', want + location.search + location.hash);
  }, [movieId, title]);
}

function historyDepth(state: unknown): number {
  if (!state || typeof state !== 'object' || !('depth' in state)) return 0;
  const d = (state as { depth: unknown }).depth;
  return typeof d === 'number' && d > 0 ? d : 0;
}

/** Zoom is clamped and driven by the buttons, a trackpad pinch, or
 *  ⌘/ctrl + wheel. Plain scrolling stays scrolling. Zooming keeps the
 *  point under the centre of the screen where it is. A new search snaps
 *  to the screen's fitted zoom without dragging the camera. */
function useZoom(
  fit: number,
  movieId: number | null,
  device: string,
): [number, (z: number) => void, () => void] {
  const [zoom, setZoomState] = useState(() => clampZoom(fit));
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const resetKey = `${movieId}:${device}`;
  const keyRef = useRef(resetKey);
  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey;
    const next = clampZoom(fit);
    if (next !== zoom) setZoomState(next);
  }

  const apply = (cur: number, next: number) => {
    const z = clampZoom(next);
    if (z === cur) return cur;
    const el = document.scrollingElement ?? document.documentElement;
    const cx = (el.scrollLeft + window.innerWidth / 2) / cur;
    const cy = (el.scrollTop + (window.innerHeight + HEADER_H) / 2) / cur;
    requestAnimationFrame(() => {
      window.scrollTo({
        left: cx * z - window.innerWidth / 2,
        top: cy * z - (window.innerHeight + HEADER_H) / 2,
        behavior: 'instant',
      });
    });
    return z;
  };

  const set = useCallback((next: number) => {
    setZoomState((cur) => apply(cur, next));
  }, []);

  const reset = useCallback(() => {
    setZoomState((cur) => apply(cur, fitRef.current));
  }, []);

  useEffect(() => {
    let gesturing = false;
    const onWheel = (ev: WheelEvent) => {
      if (gesturing) {
        ev.preventDefault();
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const dy = wheelDeltaPx(ev.deltaY, ev.deltaMode);
      setZoomState((cur) => apply(cur, zoomAfterWheel(cur, dy)));
    };
    let gestureAt = 1;
    const onGestureStart = (ev: Event) => {
      ev.preventDefault();
      gesturing = true;
      gestureAt = zoomRef.current;
    };
    const onGestureChange = (ev: Event) => {
      ev.preventDefault();
      const scale = (ev as Event & { scale?: number }).scale;
      if (!scale) return;
      setZoomState((cur) => apply(cur, gestureAt * scale));
    };
    const onGestureEnd = (ev: Event) => {
      ev.preventDefault();
      gesturing = false;
    };
    // `gesturestart` is WebKit-only, so every other touch browser needs
    // the pinch computed from two pointers by hand.
    const points = new Map<number, { x: number; y: number }>();
    let pinchFrom = 0;
    let pinchAt = 1;
    const onPointerDown = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      points.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (points.size === 2) {
        const [a, b] = [...points.values()];
        pinchFrom = pointerDistance(a, b);
        pinchAt = zoomRef.current;
      }
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch' || !points.has(ev.pointerId)) return;
      points.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (points.size !== 2 || pinchFrom === 0) return;
      ev.preventDefault();
      const [a, b] = [...points.values()];
      const scale = pinchScale(pinchFrom, pointerDistance(a, b));
      setZoomState((cur) => apply(cur, pinchAt * scale));
    };
    const onPointerUp = (ev: PointerEvent) => {
      points.delete(ev.pointerId);
      if (points.size < 2) pinchFrom = 0;
    };

    const opts: AddEventListenerOptions = { passive: false, capture: true };
    window.addEventListener('wheel', onWheel, opts);
    window.addEventListener('gesturestart', onGestureStart, opts);
    window.addEventListener('gesturechange', onGestureChange, opts);
    window.addEventListener('gestureend', onGestureEnd, opts);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('wheel', onWheel, opts);
      window.removeEventListener('gesturestart', onGestureStart, opts);
      window.removeEventListener('gesturechange', onGestureChange, opts);
      window.removeEventListener('gestureend', onGestureEnd, opts);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);
  return [zoom, set, reset];
}

interface Odometer {
  /** Total distance the reader has scrolled, in page px, excluding the
   *  scrolls the canvas makes itself to compensate for layout shifts. */
  distance: number;
  /** False while the camera is moving; expansion waits for stillness. */
  idle: boolean;
  compensate: (dx: number, dy: number) => void;
}

function useScrollOdometer(page: Viewport): Odometer {
  const last = useRef<{ sx: number; sy: number } | null>(null);
  const pending = useRef(0); // compensation not yet seen as a scroll
  const total = useRef(0);
  const idle = useScrollIdle();
  if (last.current) {
    const moved =
      Math.abs(page.sx - last.current.sx) + Math.abs(page.sy - last.current.sy);
    const own = Math.min(moved, pending.current);
    pending.current -= own;
    total.current += moved - own;
  }
  last.current = { sx: page.sx, sy: page.sy };
  const compensate = useCallback((dx: number, dy: number) => {
    pending.current += Math.abs(dx) + Math.abs(dy);
  }, []);
  return { distance: total.current, idle, compensate };
}

/** Fetches the pathways of stops as they approach the lit screen, nearest
 *  first, and grows the tree with what comes back — but only as far as the
 *  reader's scrolling pays for, and never past a readable density. */
function useExpansion(
  tree: MapTree | null,
  layout: Layout | null,
  viewport: Viewport,
  odometer: Odometer,
  bump: () => void,
  device: Device,
  deepening: { current: Set<string> },
  enabled: boolean,
) {
  const inflight = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const born = useRef(new Map<string, number>()); // film id -> odometer at birth
  const anchorId = tree?.anchorId;
  useEffect(() => {
    inflight.current.clear();
    failed.current.clear();
    born.current.clear();
  }, [anchorId]);
  useEffect(() => {
    if (!tree || !layout || !enabled) return;
    for (const f of tree.films.values()) {
      if (!born.current.has(f.id)) born.current.set(f.id, odometer.distance);
    }
    if (!odometer.idle) return;
    if (tree.films.size >= MAX_FILMS[device]) return;

    // A full screen stops growing, except for the one stop nearest the
    // centre: what the reader has scrolled to always opens up.
    const lit = filmsWithin(layout, viewport, 0).length;
    const capacity = Math.max(
      6,
      Math.round((viewport.vw * viewport.vh) / PX_PER_CARD),
    );
    const full = lit >= capacity;
    const slots = full ? 1 : EXPAND_CONCURRENCY;

    const paidFor = (f: MapFilm) =>
      f.depth <= 1 ||
      odometer.distance - (born.current.get(f.id) ?? 0) >=
        SCROLL_PER_GENERATION * window.innerHeight;

    const candidates = filmsWithin(layout, viewport, EXPAND_MARGIN)
      .filter(
        (f) =>
          !tree.expanded.has(f.id) &&
          !inflight.current.has(f.id) &&
          !failed.current.has(f.id) &&
          !deepening.current.has(f.id),
      )
      .filter(paidFor)
      .filter((f) => !full || distanceToCentre(f, viewport) < SPOTLIGHT_RADIUS)
      .sort(
        (a, b) => distanceToCentre(a, viewport) - distanceToCentre(b, viewport),
      );
    for (const f of candidates) {
      if (inflight.current.size >= slots) break;
      inflight.current.add(f.id);
      // Ask for a few more people than the pool we rank: the connecting
      // person is skipped client-side.
      fetchPathways(
        f.movie.tmdb_id,
        peopleFor(f) + 2,
        filmsRequested(f),
      )
        .then((pw) => {
          extendTree(tree, f.id, pw);
          bump(); // the expanded set changed even if no film was added
        })
        .catch((e: Error) => {
          failed.current.add(f.id);
          console.warn(`expand ${f.id} failed: ${e.message}`);
          bump();
        })
        .finally(() => inflight.current.delete(f.id));
    }
  }, [tree, layout, viewport, odometer.distance, odometer.idle, bump, device, enabled]);
}

/** How much of a career to ask for when a reader filters to one person.
 *  The endpoint's own ceiling; a director's whole filmography fits. */
const WIDEN_FILMS = 20;

/** How many seeds to widen a person out of. Someone who already stands on
 *  more of the map than this is not the one being hunted for. */
const WIDEN_SEEDS = 4;

/** Filtering to a person is a request to see their work, but the filter
 *  can only hide what the map already grew — and the map grows a handful
 *  of films per person, so Nolan's Tenet is never there to be shown. This
 *  fetches that career and hangs the rest of it off the seeds they stand
 *  on. Each pair is asked for once. */
function useWidenPerson(tree: MapTree | null, person: string | null, bump: () => void) {
  const done = useRef(new Set<string>());
  const anchorId = tree?.anchorId;
  useEffect(() => {
    done.current.clear();
  }, [anchorId]);
  useEffect(() => {
    if (!tree || !person) return;
    const personId = personIdByName(tree, person);
    if (!personId) return;
    const tmdbId = Number(personId.replace(/^p:/, ''));
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) return;
    for (const seedId of seedsOfPerson(tree, personId).slice(0, WIDEN_SEEDS)) {
      const key = `${personId}@${seedId}`;
      if (done.current.has(key)) continue;
      const seed = tree.films.get(seedId);
      if (!seed) continue;
      done.current.add(key);
      fetchPathways(seed.movie.tmdb_id, 1, WIDEN_FILMS, { person: tmdbId })
        .then((pw) => {
          if (widenPerson(tree, seedId, pw)) bump();
        })
        .catch((e: Error) => {
          done.current.delete(key);
          console.warn(`widen ${person} at ${seedId} failed: ${e.message}`);
        });
    }
  }, [tree, person, bump]);
}

/** Glides the window to the original film. Native smooth-scroll is cancelled
 *  by the canvas's keep-steady jumps and by leftover trackpad inertia, so
 *  this drives scroll itself, eats wheel events while it runs, and, if the
 *  map shifts mid-flight, carries the path with it. */
function useGlideToAnchor(
  layout: Layout | null,
  movieId: number | null,
  zoom: number,
): {
  glideToAnchor: () => void;
  glideToFilm: (filmId: string) => void;
  shiftGlide: (dx: number, dy: number) => void;
} {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const movieIdRef = useRef(movieId);
  movieIdRef.current = movieId;
  // A film to travel to instead of the searched one, while walking a route.
  const targetId = useRef<string | null>(null);

  const glide = useRef<{
    startLeft: number;
    startTop: number;
    t0: number;
    duration: number;
    raf: number;
  } | null>(null);

  const stop = useCallback(() => {
    const g = glide.current;
    if (g) cancelAnimationFrame(g.raf);
    glide.current = null;
  }, []);

  const shiftGlide = useCallback((dx: number, dy: number) => {
    const g = glide.current;
    if (!g) return;
    g.startLeft += dx;
    g.startTop += dy;
  }, []);

  const targetOf = () => {
    const l = layoutRef.current;
    if (!l) return null;
    const onRoute = targetId.current;
    if (onRoute) {
      const film = l.byId.get(onRoute);
      if (film) {
        return scrollPosForFilm(film, l.geometry.stem, zoomRef.current, window.innerWidth, window.innerHeight);
      }
    }
    const id = movieIdRef.current;
    if (id === null) return null;
    return anchorScrollPos(l, id, zoomRef.current);
  };

  const run = useCallback(() => {
    stop();
    const dest = targetOf();
    if (!dest) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo({ left: dest.left, top: dest.top, behavior: 'instant' });
      return;
    }
    // Kill leftover trackpad momentum so it cannot steal the first frames.
    window.scrollTo({ left: window.scrollX, top: window.scrollY, behavior: 'instant' });
    const g = {
      startLeft: window.scrollX,
      startTop: window.scrollY,
      t0: performance.now(),
      duration: glideDurationMs(dest.left - window.scrollX, dest.top - window.scrollY),
      raf: 0,
    };
    glide.current = g;
    const frame = (now: number) => {
      if (glide.current !== g) return;
      const live = targetOf();
      if (!live) {
        stop();
        return;
      }
      const elapsed = now - g.t0;
      const t = Math.min(1, elapsed / g.duration);
      const e = easeInOutCubic(t);
      window.scrollTo({
        left: g.startLeft + (live.left - g.startLeft) * e,
        top: g.startTop + (live.top - g.startTop) * e,
        behavior: 'instant',
      });
      if (elapsed < g.duration + GLIDE_SETTLE_MS) g.raf = requestAnimationFrame(frame);
      else glide.current = null;
    };
    g.raf = requestAnimationFrame(frame);
  }, [stop]);

  const glideToAnchor = useCallback(() => {
    targetId.current = null;
    run();
  }, [run]);

  const glideToFilm = useCallback(
    (filmId: string) => {
      targetId.current = filmId;
      run();
    },
    [run],
  );

  useEffect(() => {
    const eat = (ev: Event) => {
      if (!glide.current) return;
      if (ev instanceof WheelEvent && (ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!glide.current) return;
      if (
        ev.key === 'ArrowUp' ||
        ev.key === 'ArrowDown' ||
        ev.key === 'ArrowLeft' ||
        ev.key === 'ArrowRight' ||
        ev.key === 'PageUp' ||
        ev.key === 'PageDown' ||
        ev.key === 'Home' ||
        ev.key === 'End' ||
        ev.key === ' '
      ) {
        ev.preventDefault();
      }
    };
    const onPointerDown = (ev: PointerEvent) => {
      if (!glide.current) return;
      if (!isDragPanStart(ev) || isDragPanChrome(ev.target)) return;
      stop();
    };
    window.addEventListener('wheel', eat, { passive: false });
    window.addEventListener('touchmove', eat, { passive: false });
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      stop();
      window.removeEventListener('wheel', eat);
      window.removeEventListener('touchmove', eat);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [stop]);

  return { glideToAnchor, glideToFilm, shiftGlide };
}

/** Same camera target as the recenter button. */
function anchorScrollPos(
  layout: Layout,
  movieId: number,
  zoom: number,
): { left: number; top: number } | null {
  const film =
    layout.byId.get(`m:${movieId}`) ??
    layout.placed.find((p) => p.movie.tmdb_id === movieId);
  if (!film) return null;
  return scrollPosForFilm(
    film,
    layout.geometry.stem,
    zoom,
    window.innerWidth,
    window.innerHeight,
  );
}

/** After a search, keep the camera on that film (the recenter target)
 *  through layout growth, until the reader pans or scrolls themselves. */
function useCentreAnchor(
  layout: Layout | null,
  movieId: number | null,
  zoom: number,
) {
  const hold = useRef(true);
  const prevMovie = useRef(movieId);
  if (prevMovie.current !== movieId) {
    prevMovie.current = movieId;
    hold.current = true;
  }
  useLayoutEffect(() => {
    if (!hold.current || !layout || movieId === null) return;
    const dest = anchorScrollPos(layout, movieId, zoom);
    if (!dest) return;
    window.scrollTo({ left: dest.left, top: dest.top, behavior: 'instant' });
  }, [layout, movieId, zoom]);
  useEffect(() => {
    const unlock = (ev: Event) => {
      if (ev instanceof WheelEvent && (ev.ctrlKey || ev.metaKey)) return;
      const t = ev.target;
      if (t instanceof Element && t.closest('.mc-header, .mc-zoom')) return;
      hold.current = false;
    };
    window.addEventListener('wheel', unlock, { passive: true });
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchmove', unlock, { passive: true });
    return () => {
      window.removeEventListener('wheel', unlock);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchmove', unlock);
    };
  }, []);
}
