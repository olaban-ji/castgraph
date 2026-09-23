import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { fetchGrid, searchMovies, type SearchHit } from './api';
import { capture } from './analytics';
import { coldColumns, coldScreenCount, firstRunFilms, tileReveal, tilesFrom, type FirstRunFilm } from './firstRun';
import { fetchFirstRun } from './api';
import {
  DEFAULT_SETTINGS,
  RATING_STOPS,
  edgesOf,
  mergeGrid,
  type GridFilm,
  type GridPayload,
  type GridSettings,
  warmSide,
} from './grid';
import { GridMap } from './GridMap';
import { GridSheet } from './GridSheet';
import { filmCounts, PeopleChips } from './PeopleChips';
import { filmPath, movieIdFromPath } from './movieParam';

/** Where the reader's settings live between visits. */
const SETTINGS_KEY = 'cinedikt.grid';

/** Debounce before a keystroke becomes a request. */
const SEARCH_DEBOUNCE_MS = 250;

/** The rating grid, end to end: a film's people, every film they made,
 *  and nothing that has to be grown. */
export function GridApp() {
  const [movieId, setMovieId, canGoBack, goBack, goHome] = useFilmRoute();
  const [settings, setSettings] = useSettings();
  const [payload, setPayload] = useState<GridPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hovered, setHovered] = useState<number | null>(null);
  const [lit, setLit] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const session = useRef<AbortController | null>(null);
  const inflight = useRef(new Set<'before' | 'after'>());
  // First screens already asked for, so "Map this film instead" can open
  // on a payload that arrived while the panel was still up.
  const grids = useRef(new Map<string, { payload?: GridPayload; pending?: Promise<GridPayload> }>());

  const density = settings.density;

  const gridKey = useCallback(
    (id: number) => `${id}:${settings.showUnrated ? 1 : 0}:${density}`,
    [settings.showUnrated, density],
  );

  const loadGrid = useCallback(
    (id: number, signal?: AbortSignal) => {
      const key = gridKey(id);
      const have = grids.current.get(key);
      if (have?.payload) return Promise.resolve(have.payload);
      if (have?.pending) return have.pending;
      const pending = fetchGrid(id, {
        showUnrated: settings.showUnrated,
        signal,
      }).then((p) => {
        if (grids.current.size > 8) {
          const oldest = grids.current.keys().next().value;
          if (oldest) grids.current.delete(oldest);
        }
        grids.current.set(key, { payload: p });
        return p;
      }).catch((e: Error) => {
        if (grids.current.get(key)?.pending === pending) grids.current.delete(key);
        throw e;
      });
      grids.current.set(key, { pending });
      return pending;
    },
    [gridKey, settings.showUnrated],
  );

  useEffect(() => {
    session.current?.abort();
    inflight.current.clear();
    // A chip preview belongs to the grid it was taken on. Leaving it set
    // while the chips unmount (no mouseleave) paints the next film's
    // cards dim until the pointer happens to cross a chip again.
    setHovered(null);
    setLit(new Set());
    setSelected(new Set());
    setOpenId(null);
    if (movieId === null) {
      setPayload(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    session.current = ctrl;
    const cached = grids.current.get(gridKey(movieId))?.payload;
    if (cached) {
      setPayload(cached);
      setLoading(false);
      setError(null);
      capture('grid_loaded', { movie_id: movieId, films: cached.films.length });
      return () => ctrl.abort();
    }
    setLoading(true);
    setError(null);
    loadGrid(movieId, ctrl.signal)
      .then((p) => {
        if (ctrl.signal.aborted) return;
        setPayload(p);
        capture('grid_loaded', { movie_id: movieId, films: p.films.length });
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
          setPayload(null);
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [movieId, settings.showUnrated, gridKey, loadGrid]);

  const prefetch = useCallback(
    (id: number) => {
      if (id === movieId) return;
      loadGrid(id).catch(() => {});
    },
    [movieId, loadGrid],
  );

  const openFilm = useCallback(
    (id: number) => {
      setOpenId(id);
      prefetch(id);
    },
    [prefetch],
  );

  const extend = useCallback(
    (edge: 'above' | 'below') => {
      if (movieId === null || !payload) return;
      const side = warmSide(settings.yearOrder, edge);
      const edges = edgesOf(payload.films);
      const cursor = side === 'before' ? edges.before : edges.after;
      if (side === 'before' ? !payload.moreBefore || !cursor : !payload.moreAfter || !cursor) return;
      if (inflight.current.has(side)) return;
      const ctrl = session.current;
      if (!ctrl) return;
      inflight.current.add(side);
      fetchGrid(movieId, {
        before: side === 'before' ? cursor : undefined,
        after: side === 'after' ? cursor : undefined,
        showUnrated: settings.showUnrated,
        signal: ctrl.signal,
      })
        .then((page) => {
          setPayload((have) => {
            if (!have) return page;
            const next = mergeGrid(have, page);
            if (side === 'before') next.moreBefore = page.moreBefore;
            else next.moreAfter = page.moreAfter;
            return next;
          });
        })
        .catch(() => {})
        .finally(() => {
          if (session.current === ctrl) inflight.current.delete(side);
        });
    },
    [movieId, payload, settings.yearOrder, settings.showUnrated],
  );

  const counts = useMemo(() => {
    if (!payload) return new Map<number, number>();
    if (payload.people.some((p) => typeof p.count === 'number')) {
      return new Map(payload.people.map((p) => [p.id, p.count ?? 0]));
    }
    return filmCounts(payload.films);
  }, [payload]);

  const onToggle = useCallback((id: number) => {
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onCardHover = useCallback((people: number[]) => {
    setLit(new Set(people));
  }, []);

  const onRemap = useCallback(
    (film: GridFilm) => {
      setOpenId(null);
      setMovieId(film.id, film.title);
    },
    [setMovieId],
  );

  const open = payload?.films.find((f) => f.id === openId) ?? null;

  return (
    <div className="cd-app">
      <header className="cd-header">
        <div className="cd-header-row">
          <button type="button" className="cd-back" aria-label="Back to the previous film" disabled={!canGoBack} onClick={goBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <a className="cd-wordmark" href={homeHref()} onClick={goHome}>
            Cinedikt
          </a>
          <SearchField title={payload?.anchor.title ?? ''} onPick={setMovieId} />
          {payload && (
            <RatingFilter
              value={settings.minRating}
              onChange={(minRating) => setSettings({ ...settings, minRating })}
            />
          )}
        </div>
        {payload && (
          <PeopleChips
            people={payload.people}
            counts={counts}
            selected={selected}
            hovered={hovered}
            lit={lit}
            onToggle={onToggle}
            onHover={setHovered}
            onClear={() => setSelected(new Set())}
          />
        )}
      </header>

      {payload ? (
        <GridMap
          payload={payload}
          settings={settings}
          selected={selected}
          hovered={hovered}
          onCardHover={onCardHover}
          onOpen={openFilm}
          moreAbove={
            payload.moreBefore != null && warmSide(settings.yearOrder, 'above') === 'before'
              ? payload.moreBefore
              : !!payload.moreAfter
          }
          moreBelow={
            payload.moreBefore != null && warmSide(settings.yearOrder, 'below') === 'before'
              ? payload.moreBefore
              : !!payload.moreAfter
          }
          onMore={extend}
        />
      ) : (
        <ColdStart loading={loading} error={error} onPick={setMovieId} />
      )}

      {open && payload && (
        <GridSheet
          film={open}
          payload={payload}
          onOnly={(id) => {
            setSelected(new Set([id]));
            setOpenId(null);
          }}
          onRemap={onRemap}
          onClose={() => setOpenId(null)}
        />
      )}

      <p className="mc-sr-live" aria-live="polite">
        {payload ? `${payload.films.length} films` : ''}
      </p>
      <Settings settings={settings} onChange={setSettings} />
    </div>
  );
}

/** The cold start, keeping whatever query the page was opened with. */
function homeHref(): string {
  return `/${location.search}${location.hash}`;
}

/** Every map has an address, so it can be shared and reloaded. */
function historyDepth(state: unknown): number {
  if (!state || typeof state !== 'object' || !('depth' in state)) return 0;
  const d = (state as { depth: unknown }).depth;
  return typeof d === 'number' && d > 0 ? d : 0;
}

function useFilmRoute(): [
  number | null,
  (id: number, title?: string) => void,
  boolean,
  () => void,
  (e: MouseEvent<HTMLAnchorElement>) => void,
] {
  const [movieId, setId] = useState<number | null>(() => movieIdFromPath(location.pathname));
  const [depth, setDepth] = useState(() => historyDepth(history.state));
  useEffect(() => {
    if (history.state == null) {
      const id = movieIdFromPath(location.pathname);
      history.replaceState(id === null ? { depth: 0 } : { movie: id, depth: 0 }, '');
      setDepth(0);
    }
    const onPop = () => {
      setId(movieIdFromPath(location.pathname));
      setDepth(historyDepth(history.state));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((id: number, title?: string) => {
    const next = historyDepth(history.state) + 1;
    history.pushState({ movie: id, depth: next }, '', filmPath(id, title));
    setId(id);
    setDepth(next);
  }, []);
  const back = useCallback(() => {
    if (historyDepth(history.state) === 0) return;
    history.back();
  }, []);
  const home = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (movieIdFromPath(location.pathname) === null) {
      setId(null);
      return;
    }
    const next = historyDepth(history.state) + 1;
    history.pushState({ depth: next }, '', homeHref());
    setId(null);
    setDepth(next);
  }, []);
  return [movieId, go, depth > 0, back, home];
}

function useSettings(): [GridSettings, (s: GridSettings) => void] {
  const [settings, setSettings] = useState<GridSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const save = useCallback((s: GridSettings) => {
    setSettings(s);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      // A reader with storage blocked still gets the session's settings.
    }
  }, []);
  return [settings, save];
}

function SearchField({
  title,
  onPick,
}: {
  title: string;
  onPick: (id: number, title?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const typed = query.trim();

  useEffect(() => {
    if (typed.length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const timer = window.setTimeout(() => {
      searchMovies(typed, ctrl.signal)
        .then((r) => {
          setHits(r);
          setAt(0);
        })
        .catch(() => {})
        .finally(() => setBusy(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [typed]);

  const choose = (hit: SearchHit) => {
    setQuery('');
    setHits([]);
    onPick(hit.id, hit.title);
  };

  return (
    <div className="cd-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
      <input
        type="search"
        value={query}
        placeholder={title || 'Search a film'}
        aria-label="Search for a film"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setAt((i) => Math.min(i + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setAt((i) => Math.max(i - 1, 0));
          else if (e.key === 'Enter' && hits[at]) choose(hits[at]);
        }}
      />
      {typed.length >= 2 && (
        <ul className="cd-results" role="listbox">
          {busy && hits.length === 0 && <li className="cd-result-note">Searching…</li>}
          {!busy && hits.length === 0 && <li className="cd-result-note">No films match</li>}
          {hits.map((h, i) => (
            <li key={h.id}>
              <button
                type="button"
                className={`cd-result${i === at ? ' cd-result-at' : ''}`}
                onClick={() => choose(h)}
              >
                {h.poster ? <img src={h.poster} alt="" width={28} height={42} loading="lazy" /> : <span className="cd-result-blank" />}
                <span>{h.title}</span>
                <span className="cd-result-year">{h.release_date?.slice(0, 4)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A floor, not a window: a reader asks for "at least a seven", and the
 *  grid's own x axis already shows them how far above it everything sits. */
function RatingFilter({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="cd-rating-filter" role="group" aria-label="Filter by rating">
      <button
        type="button"
        className={`cd-rung${value == null ? ' cd-rung-on' : ''}`}
        aria-pressed={value == null}
        onClick={() => onChange(null)}
      >
        Any
      </button>
      {RATING_STOPS.map((r) => (
        <button
          key={r}
          type="button"
          className={`cd-rung${value === r ? ' cd-rung-on' : ''}`}
          aria-pressed={value === r}
          aria-label={`At least ${r.toFixed(1)}`}
          onClick={() => onChange(value === r ? null : r)}
        >
          {r.toFixed(1)}
        </button>
      ))}
    </div>
  );
}

function ColdStart({
  loading,
  error,
  onPick,
}: {
  loading: boolean;
  error: string | null;
  onPick: (id: number, title?: string) => void;
}) {
  // The set waits until it is known, then glides out once. A late answer
  // does not swap a new eight in under one the reader is already watching.
  const [tiles, setTiles] = useState<FirstRunFilm[] | null>(null);
  const [box, setBox] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  useEffect(() => {
    const onResize = () => setBox({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (loading) return;
    let settled = false;
    const settle = (films: FirstRunFilm[]) => {
      if (settled) return;
      settled = true;
      setTiles(films);
    };
    const fallback = window.setTimeout(() => settle(firstRunFilms()), 400);
    const ctrl = new AbortController();
    fetchFirstRun(ctrl.signal)
      .then((hits) => {
        const fresh = tilesFrom(hits);
        settle(fresh.length > 0 ? fresh : firstRunFilms());
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        settle(firstRunFilms());
      });
    return () => {
      ctrl.abort();
      window.clearTimeout(fallback);
    };
  }, [loading]);

  if (loading) return <div className="cd-cold"><p>Finding the cast…</p></div>;
  const shown = tiles ? tiles.slice(0, coldScreenCount(box.w, box.h)) : [];
  const columns = coldColumns(box.w);
  return (
    <div className="cd-cold">
      {error && <p className="cd-cold-error">{error}</p>}
      <strong>Every film is one step from the people who made it</strong>
      <p>Pick one, and see everything its cast and directors have done.</p>
      {shown.length > 0 && (
        <div className="cd-tiles">
          {shown.map((f, i) => {
            const reveal = tileReveal(i, columns, shown.length);
            return (
              <button
                key={f.id}
                type="button"
                className="cd-tile"
                style={{
                  ['--rx' as string]: reveal.x,
                  ['--ry' as string]: reveal.y,
                  ['--reveal-delay' as string]: `${reveal.delay}ms`,
                }}
                onClick={() => onPick(f.id, f.title)}
              >
                <img src={f.poster} alt="" width={104} height={156} decoding="async" />
                <span className="cd-tile-title">{f.title}</span>
                <span className="cd-tile-year">{f.year}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Settings({
  settings,
  onChange,
}: {
  settings: GridSettings;
  onChange: (s: GridSettings) => void;
}) {
  return (
    <details className="cd-settings">
      <summary>Settings</summary>
      <label>
        <input
          type="checkbox"
          checked={settings.density === 'compact'}
          onChange={(e) => onChange({ ...settings, density: e.target.checked ? 'compact' : 'comfortable' })}
        />
        Compact rows
      </label>
      <label>
        <input
          type="checkbox"
          checked={settings.yearOrder === 'newest'}
          onChange={(e) => onChange({ ...settings, yearOrder: e.target.checked ? 'newest' : 'oldest' })}
        />
        Newest first
      </label>
      <label>
        <input
          type="checkbox"
          checked={settings.showUnrated}
          onChange={(e) => onChange({ ...settings, showUnrated: e.target.checked })}
        />
        Show unrated
      </label>
      <label>
        <input
          type="checkbox"
          checked={settings.highlightYear}
          onChange={(e) => onChange({ ...settings, highlightYear: e.target.checked })}
        />
        Highlight searched year
      </label>
    </details>
  );
}
