import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchPathways } from './api';
import { Header } from './Header';
import {
  deviceFor,
  distanceToCentre,
  filmsWithin,
  GEOMETRY,
  LayoutCache,
  layoutTree,
  type Layout,
  type Viewport,
} from './layout';
import { LIVE_AT, MapCanvas } from './MapCanvas';
import { buildTree, costarsFor, extendTree, PATHWAY_FILTER, RULES, type MapFilm, type MapTree } from './tree';
import { useViewport } from './useViewport';
import { YearRail } from './YearRail';

const HEADER_H = 64;

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

/** Hard ceiling on films in one map; a memory guard, not a design rule. */
const MAX_FILMS = 1500;

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.6;

export function App() {
  const [movieId, setMovieId] = useMovieParam();
  const page = useViewport();
  // ?device=phone|tablet|desktop pins a geometry for review, as in the handoff.
  const device = useMemo(() => {
    const pin = new URLSearchParams(location.search).get('device');
    return pin === 'phone' || pin === 'tablet' || pin === 'desktop' ? pin : deviceFor(page.vw);
  }, [page.vw]);
  const [zoom, setZoom] = useZoom();
  // The reader's window in canvas coordinates.
  const viewport = useMemo<Viewport>(
    () => ({ sx: page.sx / zoom, sy: page.sy / zoom, vw: page.vw / zoom, vh: page.vh / zoom }),
    [page, zoom],
  );

  const treeRef = useRef<MapTree | null>(null);
  const loadedFor = useRef<number | null | undefined>(undefined);
  if (loadedFor.current !== movieId) {
    loadedFor.current = movieId;
    treeRef.current = null;
  }
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Load the anchor's pathways and build the initial tree. The lead needs
  // enough films for the whole trunk.
  useEffect(() => {
    treeRef.current = null;
    setError(null);
    if (!movieId) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetchPathways(movieId, RULES.anchorCostars + 2, RULES.trunkMax + 2, PATHWAY_FILTER, ctrl.signal)
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
  // Positions are cached per anchor and device; a new one starts fresh.
  const cache = useMemo(() => new LayoutCache(GEOMETRY[device]), [device, movieId]);
  // `version` is bumped whenever the tree (a mutable ref) grows.
  const layout = useMemo(() => (tree ? layoutTree(tree, cache) : null), [tree, cache, version]);

  const odometer = useScrollOdometer(page);
  useExpansion(tree, layout, viewport, odometer, bump);
  const scrollToAnchor = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      if (!layout || movieId === null) return;
      const anchor = layout.byId.get(`m:${movieId}`);
      if (!anchor) return;
      const cx = anchor.x * zoom;
      const cy = (anchor.y - layout.geometry.stem - anchor.h / 2) * zoom;
      window.scrollTo({
        left: cx - window.innerWidth / 2,
        top: cy - (window.innerHeight + HEADER_H) / 2,
        behavior,
      });
    },
    [layout, movieId, zoom],
  );
  useCentreAnchor(layout, movieId, zoom);

  const onPick = useCallback(
    (id: number) => {
      if (id === movieId) scrollToAnchor('smooth');
      else setMovieId(id);
    },
    [movieId, scrollToAnchor, setMovieId],
  );

  const bands = useRef({ live: 0, loading: 0 });
  const onBands = useCallback((live: number, loading: number) => {
    bands.current = { live, loading };
  }, []);

  const anchor = tree?.films.get(tree.anchorId);
  const centreYear = layout
    ? Math.round(layout.minYear + (viewport.sy + viewport.vh / 2 - layout.yOf(layout.minYear)) / layout.geometry.ppy)
    : null;
  const hud = layout
    ? `${centreYear} · ${bands.current.live} live · ${bands.current.loading} loading · ${tree!.films.size} films · ⌘-scroll to zoom`
    : loading
      ? 'crawling…'
      : undefined;

  return (
    <>
      <Header title={anchor?.movie.label ?? ''} hud={hud} onPick={onPick} />
      {layout && tree ? (
        <>
          <MapCanvas
            layout={layout}
            viewport={viewport}
            zoom={zoom}
            background="funky"
            onCompensate={odometer.compensate}
            onBands={onBands}
          />
          <YearRail layout={layout} zoom={zoom} scrollTop={page.sy} headerHeight={HEADER_H} />
          <div className="mc-zoom">
            <button aria-label="Recenter on original film" title="Recenter on original film" onClick={() => scrollToAnchor('smooth')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
            </button>
            <button aria-label="Zoom in" onClick={() => setZoom(zoom * 1.15)}>+</button>
            <button aria-label="Zoom out" onClick={() => setZoom(zoom / 1.15)}>−</button>
            <button aria-label="Reset zoom" className="mc-zoom-reset" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
          </div>
        </>
      ) : (
        <div className="mc-notice">
          <div>
            {error ? (
              <>
                <strong>Couldn’t load that film</strong>
                {error}
              </>
            ) : loading ? (
              <>
                <strong>Mapping the cast…</strong>
                First visit to a film crawls TMDb; this takes a few seconds.
              </>
            ) : (
              <>
                <strong>Cast Network Map</strong>
                Search for a film above, or{' '}
                <a href="?movie=603" onClick={(e) => { e.preventDefault(); setMovieId(603); }}>
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

/** The anchor lives in the URL (?movie=603) so a map can be shared and the
 *  back button walks through anchors. */
function useMovieParam(): [number | null, (id: number) => void] {
  const read = () => {
    const raw = new URLSearchParams(location.search).get('movie');
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const [id, setId] = useState<number | null>(read);
  useEffect(() => {
    const onPop = () => setId(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const set = useCallback((next: number) => {
    history.pushState(null, '', `?movie=${next}`);
    setId(next);
  }, []);
  return [id, set];
}

/** Zoom is clamped and driven by the buttons or ⌘/ctrl + wheel; plain
 *  scrolling stays scrolling. Zooming keeps the point under the centre of
 *  the screen where it is. */
function useZoom(): [number, (z: number) => void] {
  const [zoom, setZoomState] = useState(1);
  const set = useCallback((next: number) => {
    setZoomState((cur) => {
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      if (z === cur) return cur;
      const el = document.scrollingElement ?? document.documentElement;
      const cx = (el.scrollLeft + window.innerWidth / 2) / cur;
      const cy = (el.scrollTop + window.innerHeight / 2) / cur;
      requestAnimationFrame(() => {
        window.scrollTo({ left: cx * z - window.innerWidth / 2, top: cy * z - window.innerHeight / 2, behavior: 'instant' });
      });
      return z;
    });
  }, []);
  useEffect(() => {
    const onWheel = (ev: WheelEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      setZoomState((cur) => {
        const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur * (ev.deltaY > 0 ? 0.94 : 1.064)));
        return z;
      });
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);
  return [zoom, set];
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
    const moved = Math.abs(page.sx - last.current.sx) + Math.abs(page.sy - last.current.sy);
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
) {
  const inflight = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const born = useRef(new Map<string, number>()); // film id -> odometer at birth
  useEffect(() => {
    if (!tree || !layout) return;
    for (const f of tree.films.values()) {
      if (!born.current.has(f.id)) born.current.set(f.id, odometer.distance);
    }
    if (tree.films.size >= MAX_FILMS) return;

    // A full screen stops growing, except for the one stop nearest the
    // centre: what the reader has scrolled to always opens up.
    const lit = filmsWithin(layout, viewport, 0).length;
    const capacity = Math.max(6, Math.round((viewport.vw * viewport.vh) / PX_PER_CARD));
    const full = lit >= capacity;
    const slots = full ? 1 : EXPAND_CONCURRENCY;

    const paidFor = (f: MapFilm) =>
      f.trunk ||
      f.parent === tree.anchorId ||
      odometer.distance - (born.current.get(f.id) ?? 0) >= SCROLL_PER_GENERATION * window.innerHeight;

    const candidates = filmsWithin(layout, viewport, EXPAND_MARGIN)
      .filter((f) => !tree.expanded.has(f.id) && !inflight.current.has(f.id) && !failed.current.has(f.id))
      .filter(paidFor)
      .filter((f) => !full || distanceToCentre(f, viewport) < SPOTLIGHT_RADIUS)
      .sort((a, b) => distanceToCentre(a, viewport) - distanceToCentre(b, viewport));
    for (const f of candidates) {
      if (inflight.current.size >= slots) break;
      inflight.current.add(f.id);
      // Ask for a few more co-stars than the rules use: the lead and the
      // connecting actor are skipped client-side.
      fetchPathways(f.movie.tmdb_id, costarsFor(f) + 2, RULES.candidateFilms, PATHWAY_FILTER)
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
  }, [tree, layout, viewport, odometer, bump]);
}

/** On a fresh anchor, open the map with the anchor card at the centre of
 *  the screen rather than at the earliest year. */
function useCentreAnchor(layout: Layout | null, movieId: number | null, zoom: number) {
  const centred = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!layout || movieId === null || centred.current === movieId) return;
    const anchor = layout.byId.get(`m:${movieId}`);
    if (!anchor) return;
    centred.current = movieId;
    const cx = anchor.x * zoom;
    const cy = (anchor.y - layout.geometry.stem - anchor.h / 2) * zoom;
    window.scrollTo({ left: cx - window.innerWidth / 2, top: cy - (window.innerHeight + HEADER_H) / 2, behavior: 'instant' });
  }, [layout, movieId, zoom]);
}
