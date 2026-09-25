import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useHeaderAway, useHeaderHeight } from './overHeader';
import { fetchGrid, fetchGridFilms, searchMovies, type SearchHit } from './api';
import { capture } from './analytics';
import { coldScreenCount, tileDelay, tilesFrom, type FirstRunFilm } from './firstRun';
import { fetchFirstRun } from './api';
import {
  DEFAULT_SETTINGS,
  RATING_STOPS,
  activeFilters,
  changedCount,
  isLit,
  nothingLit,
  settingsFrom,
  spineOf,
  yearBounds,
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
import { PosterImage } from './PosterImage';
import { posterURL } from './poster';
import { Progress, useProgress } from './Progress';
import { Toast, useToast } from './Toast';
import { filmPath, movieIdFromPath, routeFrom, usePageTitle } from './movieParam';
import { ThemePicker } from './ThemePicker';
import { resolved, useTheme, type ThemePref } from './theme';

/** The width a first-run poster is drawn at, and the longest the screen
 *  waits for those posters before showing the tiles anyway. */
const TILE_W = 104;
const PosterWait = 700;

/** The gap between mounting something in its "from" state and letting
 *  it go. One frame would do; this is two, and is the difference
 *  between a transition and a jump. */
const RevealFlip = 30;

/** Share images already asked for this session. Once per movie: the
 *  point is that the picture exists, and asking twice does not make it
 *  exist harder. */
const warmedCards = new Set<string>();

/** Asks the server to have this movie's share card ready.
 *
 *  Slack, iMessage and X each cache the first thing they are given for
 *  an address, so a link pasted before the image has ever been rendered
 *  can show the generic card for as long as that cache lives. Rendering
 *  it while the reader is still looking at the map costs them nothing
 *  and settles it.
 *
 *  Not on a metered connection: a reader who has asked their phone to
 *  save data has not asked for a picture they will never see. */
function warmShareCard(id: string, version: string | undefined) {
  if (!version || warmedCards.has(id)) return;
  const link = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (link?.saveData) return;
  warmedCards.add(id);
  fetch(`/og/movie/${id}.png?v=${version}`, {
    priority: 'low',
    credentials: 'omit',
  } as RequestInit).catch(() => {});
}

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
  // Anything narrower than 1024 px sends the rating rungs to the View
  // panel. A phone and a landscape phone have no header row to spare;
  // between 641 and 860 px the rungs wrapped onto a second row, so the
  // header changed height the moment a map arrived.
  const rungsInView = screen.phone || screen.short || screen.narrow;
  const [settings, setSettings] = useSettings();
  const [theme, setTheme] = useTheme();
  const onTheme = useCallback(
    (pref: ThemePref) => {
      setTheme(pref);
      capture('theme_set', { pref, resolved: resolved(pref) });
    },
    [setTheme],
  );
  const [payload, setPayload] = useState<GridPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [lit, setLit] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
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
    (id: string, title?: string) => {
      if (title) titleRef.current = title;
      openMovie(id, title);
    },
    [openMovie],
  );
  const inflight = useRef(new Set<'before' | 'after'>());
  // First screens already asked for, so "Map this film instead" can open
  // on a payload that arrived while the panel was still up.
  const grids = useRef(new Map<string, { payload?: GridPayload; pending?: Promise<GridPayload> }>());

  const gridKey = useCallback(
    (id: string) => `${id}:${settings.showUnrated ? 1 : 0}`,
    [settings.showUnrated],
  );

  const loadGrid = useCallback(
    (id: string, signal?: AbortSignal) => {
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
      warmShareCard(movieId, cached.og_v);
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
        warmShareCard(movieId, p.og_v);
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
    (id: string) => {
      if (id === movieId) return;
      loadGrid(id).catch(() => {});
    },
    [movieId, loadGrid],
  );

  const openFilm = useCallback(
    (id: string) => {
      setOpenId(id);
      prefetch(id);
    },
    [prefetch],
  );

  // The spine says where every card goes; this is what they say. The
  // view asks for the ids it can see, and each one is asked for once.
  const [detail, setDetail] = useState<Map<string, GridFilm>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    asked.current = new Set();
    setDetail(new Map());
  }, [movieId]);

  const onNeedDetail = useCallback(
    (ids: string[]) => {
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

  // The chips hold people by id; the spine names them by their place in
  // that row. The map from one to the other is per payload, so it is
  // made once rather than inside every card's judgement.
  const selectedIdx = useMemo(() => {
    if (!payload) return new Set<number>();
    const out = new Set<number>();
    payload.people.forEach((p, i) => {
      if (selected.has(p.id)) out.add(i);
    });
    return out;
  }, [payload, selected]);

  const bounds = useMemo(
    () => (payload ? yearBounds(payload) : { lo: 1900, hi: 2100 }),
    [payload],
  );

  const pillText = activeFilters(settings, rungsInView);
  const changed = changedCount(settings, rungsInView);
  const pillRef = useRef<HTMLButtonElement>(null);
  const everyoneRef = useRef<HTMLButtonElement>(null);
  const openedFromPill = useRef(false);

  const clearYears = useCallback(() => {
    setSettings((was) => ({
      ...was,
      yearFrom: null,
      yearTo: null,
      hideEmptyYears: false,
    }));
    setRelaid((n) => n + 1);
    capture('filter_pill_cleared', {});
    // The pill is about to unmount, so the focus has to go somewhere it
    // can be seen: the first chip, which is where the row starts.
    everyoneRef.current?.focus();
  }, [setSettings]);

  // Hiding the empty years can leave the searched film alone on the
  // page. That is a real answer, but only if it is said.
  const aloneOnTheMap =
    payload != null &&
    settings.hideEmptyYears &&
    !spineOf(payload).some((f) => !f.isAnchor && isLit(f, selectedIdx, settings.minRating));
  // How many rows the map is down to, for the reader who cannot see it
  // collapse. Counted off the spine, which holds every year whether or
  // not anybody has scrolled to it.
  const yearsShowing = useMemo(() => {
    if (!payload) return 0;
    const years = new Set<number>([payload.anchor.year]);
    for (const f of spineOf(payload)) {
      if (isLit(f, selectedIdx, settings.minRating)) years.add(f.year);
    }
    return years.size;
  }, [payload, selectedIdx, settings.minRating]);

  const wasAlone = useRef(false);
  useEffect(() => {
    if (!aloneOnTheMap) {
      wasAlone.current = false;
      return;
    }
    if (wasAlone.current) return;
    wasAlone.current = true;
    toast.show({
      text: `Nothing else matches. Showing only ${payload?.anchor.title ?? 'this movie'}.`,
      action: {
        label: 'Show all years',
        run: () => {
          setSettings((was) => ({ ...was, hideEmptyYears: false }));
          toast.hide();
        },
      },
    });
    // The toaster's own functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aloneOnTheMap, payload, setSettings]);

  const onToggle = useCallback((id: string) => {
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onCardHover = useCallback((people: string[]) => {
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
    (id: string) => {
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
          {/* Only when there is somewhere to go. A permanently disabled
              button at 35% opacity is a dead control taking up the
              corner of every first visit. */}
          {canGoBack && (
            <button
              type="button"
              className="cd-back"
              aria-label="Back to the previous movie"
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
            allRef={everyoneRef}
            lead={
              pillText ? (
                <>
                  <span className="cd-filter-pill">
                    <button
                      type="button"
                      ref={pillRef}
                      className="cd-filter-pill-body"
                      aria-label={`Filters: ${pillText}. Open View`}
                      onClick={() => {
                        openedFromPill.current = true;
                        setViewOpen(true);
                      }}
                    >
                      {pillText}
                    </button>
                    <button
                      type="button"
                      className="cd-filter-pill-x"
                      aria-label="Clear year filters"
                      onClick={clearYears}
                    >
                      ✕
                    </button>
                  </span>
                  <span className="cd-chips-sep" aria-hidden="true" />
                </>
              ) : undefined
            }
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
          selectedIdx={selectedIdx}
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
        <ColdStart onPick={setMovieId} theme={theme} onTheme={onTheme} />
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
          aria-label={`How the map is drawn, ${changed} changed`}
          aria-hidden={covered || undefined}
          inert={covered || undefined}
          onClick={() => setViewOpen(true)}
        >
          <span className="cd-float-pill">
            View
            {changed > 0 && (
              <>
                <span className="cd-view-count" aria-hidden="true">
                  ·
                </span>
                <span aria-hidden="true">{changed}</span>
              </>
            )}
          </span>
        </button>
      )}

      {viewOpen && (
        <ViewPanel
          settings={settings}
          onChange={setSettings}
          onRelaid={() => setRelaid((n) => n + 1)}
          rungs={rungsInView}
          bounds={bounds}
          anchorYear={payload?.anchor.year ?? 0}
          onFloor={onFloor}
          theme={theme}
          onTheme={onTheme}
          onClose={() => {
            setViewOpen(false);
            // A panel opened from the pill gives the focus back to it,
            // rather than dropping it on the document.
            if (openedFromPill.current) {
              openedFromPill.current = false;
              pillRef.current?.focus();
            }
          }}
        />
      )}

      <Toast spec={toast.spec} visible={toast.visible} />
      <p className="cd-sr-live" aria-live="polite">
        {!payload ? '' : settings.hideEmptyYears ? `Showing ${yearsShowing} years` : 'Map ready'}
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
  string | null,
  (id: string, title?: string) => void,
  boolean,
  () => void,
  (e?: MouseEvent<HTMLAnchorElement>) => void,
] {
  const [movieId, setId] = useState<string | null>(() => movieIdFromPath(location.pathname));
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
  const go = useCallback((id: string, title?: string) => {
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
      return settingsFrom(localStorage.getItem(SETTINGS_KEY));
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
  onPick: (id: string, title?: string) => void;
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
                <PosterImage url={h.poster} blankClassName="cd-result-blank" width={28} height={42} loading="lazy" />
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

function ColdStart({
  onPick,
  theme,
  onTheme,
}: {
  onPick: (id: string, title?: string) => void;
  theme: ThemePref;
  onTheme: (p: ThemePref) => void;
}) {
  // The set waits until it is known, then glides out once. A late answer
  // does not swap a new eight in under one the reader is already watching.
  const [tiles, setTiles] = useState<FirstRunFilm[] | null>(null);
  // Set when every poster has decoded. The tiles are held back until
  // then so each one rises complete: revealing them on mount means they
  // arrive as empty boxes and the artwork pops in afterwards, in
  // whatever order the image host answered.
  const [ready, setReady] = useState(false);
  // The text and the tiles each mount in their "from" state and are let
  // go a frame later. Two separate flips, because a transition needs a
  // committed state to travel out of: set the opacity in the same
  // render that mounts the element and the browser has nothing to
  // animate between.
  const [textIn, setTextIn] = useState(false);
  const [tilesIn, setTilesIn] = useState(false);
  const [box, setBox] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  // The headline does not wait for the pictures; it is the first thing
  // there is to read. Two painted frames, not a timeout: the from-state
  // has to be on screen or the fade is skipped and the line just appears.
  useEffect(() => {
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setTextIn(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => setTilesIn(true), RevealFlip);
    return () => window.clearTimeout(t);
  }, [ready]);

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

    const ctrl = new AbortController();
    fetchFirstRun(ctrl.signal)
      .then((hits) => {
        const fresh = tilesFrom(hits);
        settle(fresh);
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        // The catalog is the only source now. Nothing to fall back to,
        // and an empty screen says so more honestly than eight films
        // the reader cannot open.
        settle([]);
      });
    return () => ctrl.abort();
  }, []);

  const room = coldScreenCount(box.w, box.h);
  const shown = tiles ? tiles.slice(0, room) : [];

  const posters = shown.map((f) => posterURL(f.poster, TILE_W)).join(' ');
  useEffect(() => {
    if (shown.length === 0) return;
    let gone = false;
    const show = () => {
      if (!gone) setReady(true);
    };
    // A poster that will not load is not worth waiting for, and neither
    // is a slow one: the cap means one bad host cannot hold the screen,
    // and it is short enough that the wait is never what you notice.
    Promise.all(
      shown.map((f) => {
        const src = posterURL(f.poster, TILE_W);
        if (!src) return Promise.resolve(undefined);
        // `load`, not `decode()`: decoding needs the rendering pipeline,
        // so in a tab that is not being painted it never settles and the
        // screen waits out the cap for nothing. A loaded image is enough
        // to know the tile will not rise empty.
        return new Promise<void>((settle) => {
          const img = new Image();
          img.onload = () => settle();
          img.onerror = () => settle();
          img.src = src;
        });
      }),
    ).then(show);
    const cap = window.setTimeout(show, PosterWait);
    return () => {
      gone = true;
      window.clearTimeout(cap);
    };
    // `posters` stands for the set of images to wait on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posters]);

  return (
    <div className={`cd-cold${textIn ? ' cd-cold-in' : ''}${tilesIn ? ' cd-tiles-in' : ''}`}>
      <strong className="cd-cold-head">Start with a movie you love</strong>
      <p className="cd-cold-sub">
        See every movie its cast and directors made, arranged by year and rating.
      </p>
      {/* The grid holds its place from the first paint, filled with empty
          slots. Growing it as the tiles arrive would shove the headline
          up the screen, which is the one movement nobody asked for. */}
      <div className="cd-tiles">
        {Array.from({ length: room }, (_, i) => {
          const film = ready ? shown[i] : undefined;
          if (!film) {
            // The real markup, held invisible: anything else would
            // reserve a slightly different height and the grid would
            // still shift when the tiles landed.
            return (
              <button key={i} type="button" className="cd-tile cd-tile-slot" aria-hidden="true" tabIndex={-1}>
                <span className="cd-tile-poster-slot" />
                <span className="cd-tile-title">&nbsp;</span>
                <span className="cd-tile-year">&nbsp;</span>
              </button>
            );
          }
          return (
            <button
              key={film.id}
              type="button"
              className="cd-tile"
              style={{ ['--reveal-delay' as string]: `${tileDelay(i)}ms` }}
              onClick={() => onPick(film.id, film.title)}
            >
              <PosterImage
                url={film.poster}
                cssPx={TILE_W}
                blankClassName="cd-tile-poster"
                width={TILE_W}
                height={Math.round(TILE_W * 1.5)}
              />
              <span className="cd-tile-title">{film.title}</span>
              <span className="cd-tile-year">{film.year}</span>
            </button>
          );
        })}
      </div>
      {/* There is no View button on this screen, so the theme choice
          lives here. It fades in with the sub-line rather than with the
          tiles: it is not one of the eight movies. */}
      <ThemePicker value={theme} onChange={onTheme} />
    </div>
  );
}
