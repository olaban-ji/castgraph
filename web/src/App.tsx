import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchPathways } from './api';
import { easeInOutCubic, GLIDE_SETTLE_MS, glideDurationMs } from './glide';
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
import { movieIdFrom, movieIdFromState, urlWithoutMovie } from './movieParam';
import { capture } from './analytics';
import {
  buildTree,
  canDeepen,
  deepenTree,
  extendTree,
  PATHWAY_FILTER,
  filmsRequested,
  peopleFor,
  RULES,
  type MapFilm,
  type MapTree,
} from './tree';
import { isDragPanChrome, isDragPanStart, useDragPan } from './pan';
import { useViewport } from './useViewport';
import { YearRail } from './YearRail';
import { clampZoom, fitZoom, wheelDeltaPx, zoomAfterWheel, ZOOM_STEP } from './zoom';

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
  const [movieId, setMovieId] = useMovieParam();
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
  const [openingAs, setOpeningAs] = useState('');
  const [deepeningId, setDeepeningId] = useState<string | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Load the searched film's pathways and blow it out as the first seed.
  useEffect(() => {
    treeRef.current = null;
    setError(null);
    setDeepeningId(null);
    deepeningRef.current.clear();
    if (!movieId) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetchPathways(
      movieId,
      RULES.seedPeople,
      RULES.seedFilms + RULES.candidateSlack,
      PATHWAY_FILTER,
      ctrl.signal,
    )
      .then((pw) => {
        treeRef.current = buildTree(pw);
        bump();
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [movieId, bump]);

  const tree = treeRef.current;

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
        PATHWAY_FILTER,
      )
        .then((pw) => {
          const live = treeRef.current;
          if (!live) return;
          deepenTree(live, filmId, pw);
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
  useExpansion(tree, layout, viewport, odometer, bump, device, deepeningRef);
  const { glideToAnchor, shiftGlide } = useGlideToAnchor(layout, movieId, zoom);
  const onCompensate = useCallback(
    (dx: number, dy: number) => {
      odometer.compensate(dx, dy);
      shiftGlide(dx, dy);
    },
    [odometer.compensate, shiftGlide],
  );
  useCentreAnchor(layout, movieId, zoom);
  useDragPan();

  const onPick = useCallback(
    (id: number, label?: string) => {
      capture('movie_selected', { movie_id: id, title: label });
      if (label) setOpeningAs(label);
      if (id === movieId) glideToAnchor();
      else setMovieId(id);
    },
    [movieId, glideToAnchor, setMovieId],
  );

  const anchor = tree?.films.get(tree.anchorId);
  const shownTitle = anchor?.movie.label || openingAs;

  return (
    <>
      <Header title={shownTitle} onPick={onPick} />
      {layout && tree ? (
        <>
          <MapCanvas
            layout={layout}
            viewport={viewport}
            zoom={zoom}
            background="funky"
            onCompensate={onCompensate}
            onDeepen={onDeepen}
            deepeningId={deepeningId}
            deepened={tree.deepened}
          />
          <YearRail
            layout={layout}
            zoom={zoom}
            scrollTop={page.sy}
            viewHeight={page.vh}
            headerHeight={HEADER_H}
          />
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
                  {openingAs ? `Opening ${openingAs}` : 'Opening the map'}
                </strong>
                Just a moment.
              </div>
            ) : (
              <>
                <strong>Cinedikt</strong>
                Search for a film above, or{' '}
                <a
                  href="/"
                  onClick={(e) => {
                    e.preventDefault();
                    setOpeningAs('The Matrix');
                    capture('movie_selected', { movie_id: 603, title: 'The Matrix' });
                    setMovieId(603);
                  }}
                >
                  start from The Matrix
                </a>
                .
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The anchor lives in history.state so the back button walks through
 *  maps without putting ?movie= in the address bar. A ?movie= on first
 *  load is still honoured, then stripped. */
function useMovieParam(): [number | null, (id: number) => void] {
  const read = () =>
    movieIdFrom(new URLSearchParams(location.search).get('movie')) ??
    movieIdFromState(history.state);
  const [id, setId] = useState<number | null>(read);
  useLayoutEffect(() => hideMovieParam(id), [id]);
  useEffect(() => {
    const onPop = () => {
      const next = read();
      hideMovieParam(next);
      setId(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const set = useCallback((next: number) => {
    history.pushState({ movie: next }, '', urlWithoutMovie(location.href));
    setId(next);
  }, []);
  return [id, set];
}

function hideMovieParam(id: number | null) {
  if (!new URLSearchParams(location.search).has('movie')) return;
  history.replaceState({ movie: id }, '', urlWithoutMovie(location.href));
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
    const opts: AddEventListenerOptions = { passive: false, capture: true };
    window.addEventListener('wheel', onWheel, opts);
    window.addEventListener('gesturestart', onGestureStart, opts);
    window.addEventListener('gesturechange', onGestureChange, opts);
    window.addEventListener('gestureend', onGestureEnd, opts);
    return () => {
      window.removeEventListener('wheel', onWheel, opts);
      window.removeEventListener('gesturestart', onGestureStart, opts);
      window.removeEventListener('gesturechange', onGestureChange, opts);
      window.removeEventListener('gestureend', onGestureEnd, opts);
    };
  }, []);
  return [zoom, set, reset];
}

interface Odometer {
  /** Total distance the reader has scrolled, in page px, excluding the
   *  scrolls the canvas makes itself to compensate for layout shifts. */
  distance: number;
  compensate: (dx: number, dy: number) => void;
}

function useScrollOdometer(page: Viewport): Odometer {
  const last = useRef<{ sx: number; sy: number } | null>(null);
  const pending = useRef(0); // compensation not yet seen as a scroll
  const total = useRef(0);
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
  return { distance: total.current, compensate };
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
    if (!tree || !layout) return;
    for (const f of tree.films.values()) {
      if (!born.current.has(f.id)) born.current.set(f.id, odometer.distance);
    }
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
        PATHWAY_FILTER,
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
  }, [tree, layout, viewport, odometer, bump, device]);
}

/** Glides the window to the original film. Native smooth-scroll is cancelled
 *  by the canvas's keep-steady jumps and by leftover trackpad inertia, so
 *  this drives scroll itself, eats wheel events while it runs, and, if the
 *  map shifts mid-flight, carries the path with it. */
function useGlideToAnchor(
  layout: Layout | null,
  movieId: number | null,
  zoom: number,
): { glideToAnchor: () => void; shiftGlide: (dx: number, dy: number) => void } {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const movieIdRef = useRef(movieId);
  movieIdRef.current = movieId;

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
    const id = movieIdRef.current;
    if (!l || id === null) return null;
    return anchorScrollPos(l, id, zoomRef.current);
  };

  const glideToAnchor = useCallback(() => {
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

  return { glideToAnchor, shiftGlide };
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
