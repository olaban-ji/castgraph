import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useHeaderAway, useHeaderHeight } from './overHeader';
import { fetchGrid, fetchGridFilms, searchMovies, type SearchHit } from './api';
import { capture } from './analytics';
import { coldScreenCount, firstRunFilms, tileDelay, tilesFrom, type FirstRunFilm } from './firstRun';
import { fetchFirstRun } from './api';
import {
  DEFAULT_SETTINGS,
  RATING_STOPS,
  nothingLit,
  type GridFilm,
  type GridPayload,
  type GridSettings,
} from './grid';
import { GridMap } from './GridMap';
import { GridSheet } from './GridSheet';
import { PeopleChips } from './PeopleChips';
import { Wordmark } from './Wordmark';
import { ViewPanel } from './ViewPanel';
import { useEscape } from './sheet';
import { useScreen } from './screen';
import { Progress, useProgress } from './Progress';
import { Toast, useToast } from './Toast';
import { filmPath, movieIdFromPath, routeFrom, usePageTitle } from './movieParam';

/** Where the reader's settings live between visits. */
const SETTINGS_KEY = 'cinedikt.grid';

/** Debounce before a keystroke becomes a request. */
const SEARCH_DEBOUNCE_MS = 250;

/** The rating grid, end to end: a film's people, every film they made,
 *  and nothing that has to be grown. */
export function GridApp() {
  const [movieId, openMovie, canGoBack, goBack, goHome] = useFilmRoute();
  const screen = useScreen();
  // The header sits over the map on a phone or a landscape phone; only a
  // phone drops "inedikt" and sends the rating rungs to the View panel.
  const compactHeader = screen.phone;
  // Neither a phone nor a landscape phone has a header row to spare, so
  // the rungs go into the View panel on both.
  const rungsInView = screen.phone || screen.short;
  const [settings, setSettings] = useSettings();
  const [payload, setPayload] = useState<GridPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hovered, setHovered] = useState<number | null>(null);
  const [lit, setLit] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Bumped when a setting rearranges the plot, so the map can put the
  // searched film back in the middle of it.
  const [relaid, setRelaid] = useState(0);
  const session = useRef<AbortController | null>(null);
  const toast = useToast();
  const progress = useProgress(loading);
  // The title of the film being fetched, for the busy toast: the payload
  // is not here yet, so the name comes from whatever started the load —
  // the search hit, the card that was remapped, or the film already open.
  const titleRef = useRef('');
  const setMovieId = useCallback(
    (id: number, title?: string) => {
      if (title) titleRef.current = title;
      openMovie(id, title);
    },
    [openMovie],
  );
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
    // The map being left is not a stand-in for the one being fetched:
    // its chips and its cards would both be answering for the wrong film.
    setPayload(null);
    setLoading(true);
    setError(null);
    toast.show({ text: `Finding everyone who made ${titleRef.current || 'this movie'}…`, busy: true });
    loadGrid(movieId, ctrl.signal)
      .then((p) => {
        if (ctrl.signal.aborted) return;
        toast.show({ text: 'Laying out their movies…', busy: true });
        setPayload(p);
        capture('grid_loaded', { movie_id: movieId });
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') {
          // Never the raw message: it is written for us, not the reader.
          setError('failed');
          setPayload(null);
          toast.hide();
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

  // The spine says where every card goes; this is what they say. The
  // view asks for the ids it can see, and each one is asked for once.
  const [detail, setDetail] = useState<Map<number, GridFilm>>(new Map());
  const asked = useRef(new Set<number>());
  useEffect(() => {
    asked.current = new Set();
    setDetail(new Map());
  }, [movieId]);

  const onNeedDetail = useCallback(
    (ids: number[]) => {
      if (movieId === null) return;
      const fresh = ids.filter((id) => !asked.current.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) asked.current.add(id);
      const ctrl = session.current;
      fetchGridFilms(movieId, fresh, ctrl?.signal)
        .then((films) => {
          setDetail((have) => {
            const next = new Map(have);
            for (const f of films) next.set(f.id, f);
            return next;
          });
        })
        .catch(() => {
          // Asking again is better than a card that never fills in.
          for (const id of fresh) asked.current.delete(id);
        });
    },
    [movieId],
  );


  // Setting a floor dims most of the map at once, which on a narrowed
  // map can leave nothing lit at all. The toast says which it was, and
  // offers the way back.
  const onFloor = useCallback(
    (minRating: number | null) => {
      setSettings((was) => ({ ...was, minRating }));
      if (minRating === null) {
        toast.hide();
        return;
      }
      const clear = {
        label: 'Clear',
        run: () => {
          setSettings((was) => ({ ...was, minRating: null }));
          toast.hide();
        },
      };
      const only = selected.size === 1 ? [...selected][0] : null;
      const alone = only === null ? undefined : payload?.people.find((p) => p.id === only);
      const text =
        alone && nothingLit(detail.values(), alone.id, minRating)
          ? `Nothing of ${alone.name}’s is rated ${minRating.toFixed(1)} or higher`
          : `Lighting movies rated ${minRating.toFixed(1)} and up`;
      toast.show({ text, action: clear });
    },
    // The toaster's own functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSettings, selected, payload, detail],
  );

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
    (film: GridFilm) => setMovieId(film.id, film.title),
    [setMovieId],
  );

  // Narrowing to one person is easy to do by accident on a phone, where
  // the row is the size of a thumb, so it comes with its way back.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onOnly = useCallback(
    (id: number) => {
      const person = payload?.people.find((p) => p.id === id);
      const before = selectedRef.current;
      setSelected(new Set([id]));
      toast.show({
        text: `Showing only ${person?.name ?? 'them'}`,
        action: {
          label: 'Undo',
          run: () => {
            setSelected(before);
            toast.hide();
          },
        },
      });
    },
    // The toaster's own functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payload],
  );

  // The panel wants the whole film, which is detail. Opening a card the
  // reader can see means its detail is already here.
  usePageTitle(payload?.anchor.title);

  const open = openId == null ? null : (detail.get(openId) ?? null);
  // A sheet or popover is up, and the floating buttons belong to the map
  // underneath it.
  const covered = open != null || viewOpen;
  // On a phone, and on a landscape phone, the header lies over the map
  // and goes up out of the way as the reader travels down the years —
  // but never while they are waiting, reading a panel, or typing.
  const overlay = screen.phone || screen.short;
  const headerH = useHeaderHeight(
    headerRef,
    overlay,
    payload ? 'chips' : loading ? 'skeletons' : 'bare',
  );
  const headerAway = useHeaderAway(
    scrollerRef,
    overlay && !loading && !covered && !searching,
    headerH,
  );

  return (
    <div className="cd-app">
      <header
        className={`cd-header${overlay ? ' cd-header-over' : ''}${headerAway ? ' cd-header-away' : ''}`}
        ref={headerRef}
      >
        <div className="cd-header-row">
          {(canGoBack || !compactHeader) && (
            <button
              type="button"
              className="cd-back"
              aria-label="Back to the previous movie"
              disabled={!canGoBack}
              onClick={goBack}
            >
              <span className="cd-back-circle">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </span>
            </button>
          )}
          <Wordmark markOnly={compactHeader} href={homeHref()} onClick={goHome} />
          <SearchField
            title={payload?.anchor.title ?? ''}
            onPick={setMovieId}
            onFocusChange={setSearching}
          />
          {(payload || loading) && !rungsInView && (
            <RatingFilter idle={!payload} value={settings.minRating} onChange={onFloor} />
          )}
        </div>
        {payload ? (
          <PeopleChips
            people={payload.people}
            selected={selected}
            lit={lit}
            onToggle={onToggle}
            onHover={setHovered}
            onClear={() => setSelected(new Set())}
          />
        ) : loading ? (
          <ChipSkeletons />
        ) : null}
        <Progress width={progress.width} showing={progress.showing} />
      </header>

      {payload ? (
        <GridMap
          payload={payload}
          settings={settings}
          selected={selected}
          hovered={hovered}
          onCardHover={onCardHover}
          onOpen={openFilm}
          detail={detail}
          onNeedDetail={onNeedDetail}
          onRevealed={toast.hide}
          covered={covered}
          recentreKey={relaid}
          scroller={scrollerRef}
          overlayH={headerH}
        />
      ) : error ? (
        <MapError
          onRetry={() => movieId != null && setMovieId(movieId, titleRef.current)}
          onPickAnother={goHome}
        />
      ) : loading ? (
        // The waiting is said by the progress line and the toast. The
        // plot stays empty rather than holding a message the reader
        // would have to read and then watch disappear.
        <div className="cd-scroller" ref={scrollerRef} aria-hidden="true" />
      ) : (
        <ColdStart onPick={setMovieId} />
      )}

      {open && payload && (
        <GridSheet
          film={open}
          payload={payload}
          onOnly={onOnly}
          onRemap={onRemap}
          onClose={() => setOpenId(null)}
        />
      )}

      {payload && (
        <button
          type="button"
          className={`cd-float cd-view-button${covered ? '' : ' cd-float-up'}`}
          aria-label="How the map is drawn"
          aria-hidden={covered || undefined}
          inert={covered || undefined}
          onClick={() => setViewOpen(true)}
        >
          <span className="cd-float-pill">View</span>
        </button>
      )}

      {viewOpen && (
        <ViewPanel
          settings={settings}
          onChange={setSettings}
          onRelaid={() => setRelaid((n) => n + 1)}
          rungs={rungsInView}
          onFloor={onFloor}
          onClose={() => setViewOpen(false)}
        />
      )}

      <Toast spec={toast.spec} visible={toast.visible} />
      <p className="mc-sr-live" aria-live="polite">
        {payload ? 'Map ready' : ''}
      </p>
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
  (e?: MouseEvent<HTMLAnchorElement>) => void,
] {
  const [movieId, setId] = useState<number | null>(() => movieIdFromPath(location.pathname));
  const [depth, setDepth] = useState(() => historyDepth(history.state));
  useEffect(() => {
    // An old /film/ link still opens the map; from here on the address
    // bar shows the one address a map has.
    const { movieId: here, path } = routeFrom(location.href);
    const at = location.pathname + location.search + location.hash;
    if (history.state == null) {
      history.replaceState(here === null ? { depth: 0 } : { movie: here, depth: 0 }, '', path);
      setDepth(0);
    } else if (path !== at) {
      history.replaceState(history.state, '', path);
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
  // Also called without an event, by "Pick another movie" on the error.
  const home = useCallback((e?: MouseEvent<HTMLAnchorElement>) => {
    if (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
    }
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

type SetSettings = (s: GridSettings | ((was: GridSettings) => GridSettings)) => void;

function useSettings(): [GridSettings, SetSettings] {
  const [settings, setSettings] = useState<GridSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const save = useCallback<SetSettings>((s) => {
    setSettings((was) => {
      const next = typeof s === 'function' ? s(was) : s;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // A reader with storage blocked still gets the session's settings.
      }
      return next;
    });
  }, []);
  return [settings, save];
}

function SearchField({
  title,
  onPick,
  onFocusChange,
}: {
  title: string;
  onPick: (id: number, title?: string) => void;
  /** The header must not slide away from under a reader who is typing. */
  onFocusChange: (on: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
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
    // The field is not in a form, so the phone's Search key leaves it
    // focused and the keyboard stays up unless we dismiss it.
    inputRef.current?.blur();
    onPick(hit.id, hit.title);
  };

  // Escape gives the field back before it gives up the map behind it.
  useEscape(() => {
    if (typed.length > 0) setQuery('');
  });

  return (
    <div
      className="cd-search"
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        value={query}
        placeholder={title || 'Search a movie'}
        aria-label="Search for a movie"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setAt((i) => Math.min(i + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setAt((i) => Math.max(i - 1, 0));
          else if (e.key === 'Enter') {
            e.preventDefault();
            if (hits[at]) choose(hits[at]);
            else inputRef.current?.blur();
          }
        }}
      />
      {typed.length >= 2 && (
        <ul className="cd-results" role="listbox">
          {busy && hits.length === 0 && <li className="cd-result-note">Searching…</li>}
          {!busy && hits.length === 0 && (
            <li className="cd-result-note">No movies match “{typed}”</li>
          )}
          {hits.map((h, i) => (
            <li key={h.id}>
              <button
                type="button"
                className={`cd-result${i === at ? ' cd-result-at' : ''}`}
                // On pointerdown, not click: the input blurs first and
                // would take the list down before the tap ever landed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(h);
                }}
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
  idle,
  value,
  onChange,
}: {
  /** The map is still being fetched: the rungs show where they will be,
   *  but there is nothing yet for them to filter. */
  idle: boolean;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div
      className={`cd-rating-filter${idle ? ' cd-rating-filter-idle' : ''}`}
      role="group"
      aria-label="Light movies by rating"
      inert={idle || undefined}
    >
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
          aria-label={`Light movies rated at least ${r.toFixed(1)}`}
          onClick={() => onChange(value === r ? null : r)}
        >
          {r.toFixed(1)}
        </button>
      ))}
    </div>
  );
}

/** Eight inert pills where the chips will be. The widths are uneven on
 *  purpose: a row of identical bars reads as a loading bar, not as names
 *  that are about to arrive. */
function ChipSkeletons() {
  const widths = [96, 132, 164, 150, 124, 132, 134, 128];
  return (
    <div className="cd-chips cd-chips-loading" aria-hidden="true">
      {widths.map((w, i) => (
        <span key={i} className="cd-chip-skeleton" style={{ width: w }} />
      ))}
    </div>
  );
}

/** What went wrong is never the reader's problem to parse, so the raw
 *  message stays out of it. Both ways forward are offered. */
function MapError({ onRetry, onPickAnother }: { onRetry: () => void; onPickAnother: () => void }) {
  return (
    <div className="cd-error" role="alert">
      <h2 className="cd-error-title">We couldn’t open this map</h2>
      <p className="cd-error-body">
        The movie database didn’t answer. Check your connection, then try again.
      </p>
      <button type="button" className="cd-error-primary" onClick={onRetry}>
        Try again
      </button>
      <button type="button" className="cd-error-secondary" onClick={onPickAnother}>
        Pick another movie
      </button>
    </div>
  );
}

function ColdStart({ onPick }: { onPick: (id: number, title?: string) => void }) {
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
  }, []);

  const shown = tiles ? tiles.slice(0, coldScreenCount(box.w, box.h)) : [];
  return (
    <div className="cd-cold">
      <strong className="cd-cold-head">Start with a movie you love</strong>
      <p className="cd-cold-sub">
        See every movie its cast and directors made, arranged by year and rating.
      </p>
      {shown.length > 0 && (
        <div className="cd-tiles">
          {shown.map((f, i) => (
            <button
              key={f.id}
              type="button"
              className="cd-tile"
              style={{ ['--reveal-delay' as string]: `${tileDelay(i)}ms` }}
              onClick={() => onPick(f.id, f.title)}
            >
              <img src={f.poster} alt="" width={104} height={156} decoding="async" />
              <span className="cd-tile-title">{f.title}</span>
              <span className="cd-tile-year">{f.year}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
