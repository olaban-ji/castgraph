import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react';
import { NO_APP_SCROLL, useHeaderAway, type AppScroll } from './overHeader';
import { fetchGrid, fetchGridFilms, searchMovies, type SearchHit } from './api';
import { gridCache } from './gridCache';
import { capture } from './analytics';
import { EAGER_TILES, coldScreenCount, tilesFrom, type FirstRunFilm } from './firstRun';
import { fetchFirstRun } from './api';
import {
  DEFAULT_SETTINGS,
  RATING_STOPS,
  activeFilters,
  rungLabel,
  withoutPill,
  changedCount,
  aloneAfterHiding,
  litOthers,
  nothingLit,
  onPlot,
  rangeHoldsNone,
  spineOf,
  yearBounds,
  yearCounts,
  type GridFilm,
  type GridPayload,
  type GridSettings,
} from './grid';
import { GridMap } from './GridMap';
import { GridSheet } from './GridSheet';
import { PeopleChips, filmCounts } from './PeopleChips';
import { NOTHING_SHOWN, assignHues, nextShown } from './personColour';
import { Wordmark } from './Wordmark';
import { ViewPanel } from './ViewPanel';
import { useEscape } from './sheet';
import { overOffset, useScreen } from './screen';
import { PosterImage, usePosterSrc } from './PosterImage';
import { posterFallback } from './poster';
import { Progress, useProgress } from './Progress';
import { isSearchShortcut, isTyping, searchPlaceholder } from './search';
import { Toast, useToast } from './Toast';
import { filmPath, movieIdFromPath, routeFrom, usePageTitle } from './movieParam';
import {
  applyFilters,
  filtersFromState,
  filtersOf,
  forwardEntry,
  freshFilters,
  preferencesFrom,
  stampFilters,
  viewPrefs,
  type MapFilters,
} from './trail';
import { ThemePicker } from './ThemePicker';
import {
  resolved,
  useReducedMotion,
  useResolvedTheme,
  useTheme,
  type Theme,
  type ThemePref,
} from './theme';

/** The width a first-run poster is drawn at. Nothing waits on the set
 *  of them any more: each tile shows its own the moment it decodes. */
const TILE_W = 104;

/** The opening load, in order.
 *
 *  The mark is drawn over the tiles and then flies into the header to
 *  become the C of the wordmark. It does not fade out where it was
 *  drawn: a mark that dissolves over the films is a spinner pretending
 *  to be a logo, and a C arriving in the header is what says the wait
 *  is over. */
const DRAW_MS = 350;
const GLIDE_MS = 520;
/** The fills start just after the mark lifts off, so the two are never
 *  drawn in the same pixels. */
const TILES_AFTER_LIFT_MS = 80;
/** "inedikt" arrives just before its C does. */
const WORD_BEFORE_LANDING_MS = 200;
/** A list already in hand. Below this there is nothing to wait for, so
 *  there is nothing to draw: the header is simply complete. */
const FAST_PATH_MS = 120;

/** How far the opening load has got. The header reads it: the mark's
 *  place is empty until the loader lands in it, and "inedikt" waits
 *  until the C is nearly there. */
export type Opening = 'draw' | 'word' | 'done';

/** The longest the headline waits for Young Serif before it is shown
 *  in whatever is available. */
const FONT_WAIT_MS = 400;

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

/** Where the reader's view preferences live between visits. Filters
 *  are not among them: those belong to the history entry. */
const SETTINGS_KEY = 'cinedikt.grid';

function readStoredPreferences(): GridSettings {
  try {
    return preferencesFrom(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function readInitialSettings(): GridSettings {
  return applyFilters(readStoredPreferences(), filtersFromState(history.state));
}

function readInitialPeople(): Set<string> {
  return new Set(filtersFromState(history.state).people);
}

function persistView(settings: GridSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(viewPrefs(settings)));
  } catch {
    // A reader with storage blocked still gets this visit's choices.
  }
}

/** Debounce before a keystroke becomes a request. */
const SEARCH_DEBOUNCE_MS = 250;

/** The rating grid, end to end: a film's people, every film they made,
 *  and nothing that has to be grown. */
export function GridApp() {
  const adopt = useRef<(filters: MapFilters) => void>(() => {});
  const [movieId, openMovie, canGoBack, goBack, goHome] = useFilmRoute(adopt);
  const screen = useScreen();
  // Only a phone drops "inedikt": a landscape phone has the width for it.
  const compactHeader = screen.phone;
  // Anything narrower than 1024 px sends the rating rungs to the View
  // panel: below that the header has no room for them beside the
  // wordmark and the search field. A wide window squashed short keeps
  // them — it has the width, and its header row has the height for a
  // 36px group.
  const rungsInView = screen.narrow;
  const [settings, setSettingsState] = useState(readInitialSettings);
  const [selected, setSelectedState] = useState(readInitialPeople);
  const settingsRef = useRef(settings);
  const selectedRef = useRef(selected);
  settingsRef.current = settings;
  selectedRef.current = selected;
  const commit = useCallback((next: GridSettings, people: Set<string>, store: boolean) => {
    settingsRef.current = next;
    selectedRef.current = people;
    setSettingsState(next);
    setSelectedState(people);
    if (store) persistView(next);
    try {
      history.replaceState(stampFilters(history.state, filtersOf(next, people)), '');
    } catch {
      // Back remembers the last stamp that succeeded. The map still moves.
    }
  }, []);
  const setSettings = useCallback<SetSettings>((s) => {
    const next = typeof s === 'function' ? s(settingsRef.current) : s;
    commit(next, selectedRef.current, true);
  }, [commit]);
  const setPeople = useCallback((people: Set<string>) => {
    commit(settingsRef.current, people, false);
  }, [commit]);
  // Filters used to be stored with the preferences, and a year range
  // followed the reader onto every map. Drop them from storage.
  useEffect(() => {
    persistView(settingsRef.current);
  }, []);
  const [theme, setTheme] = useTheme();
  // Where the opening load has got to. It drives the header, which is
  // why it lives here rather than in ColdStart: the mark ends up in
  // the wordmark, and only this component renders both.
  const [opening, setOpening] = useState<Opening>('draw');
  const markSlot = useRef<HTMLSpanElement>(null);
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
  const [hovered, setHovered] = useState<string | null>(null);
  const [lit, setLit] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Marked by the map before each scroll it makes by itself, so the
  // header lying over it can tell those from the reader's.
  const appScroll = useRef<AppScroll>(NO_APP_SCROLL);
  // Bumped when a setting rearranges the plot, so the map can put the
  // searched film back in the middle of it.
  const [relaid, setRelaid] = useState(0);
  // Bumped by Try again. The movie has not changed, so nothing else
  // would ask for it again: opening the same id is no change to React.
  const [attempt, setAttempt] = useState(0);
  const session = useRef<AbortController | null>(null);
  const movieSeen = useRef(movieId);
  const toast = useToast();
  // Forward navigation clears. Moving through history — the chevron,
  // the browser's back and forward buttons — restores the entry just
  // landed on. The write happens after the position has moved, so it
  // stamps that entry and leaves the one behind as it was. The toast
  // goes too: its Undo would otherwise put the previous visit's
  // selection onto this one.
  adopt.current = (filters) => {
    toast.hide();
    commit(applyFilters(settingsRef.current, filters), new Set(filters.people), false);
  };
  const progress = useProgress(loading);
  // The title of the film being fetched, for the busy toast: the payload
  // is not here yet, so the name comes from whatever started the load —
  // the search hit, or the card that was remapped. Kept with the id it
  // belongs to: Back and Forward change the movie without a title, and
  // a bare string would name whichever film was opened last instead.
  const titleRef = useRef<{ id: string; title: string } | null>(null);
  const setMovieId = useCallback(
    (id: string, title?: string) => {
      if (title) titleRef.current = { id, title };
      // The map on screen failed and the reader has picked the same
      // movie again — from search, most likely. That is Try again by
      // another way in: routing it would push a second entry for the
      // same address and, the id being unchanged, fetch nothing.
      if (id === movieId && error != null) {
        setAttempt((n) => n + 1);
        return;
      }
      openMovie(id, title);
    },
    [openMovie, movieId, error],
  );
  const inflight = useRef(new Set<'before' | 'after'>());
  // Maps already asked for, so "Map this film instead" can open on a
  // payload that arrived while the panel was still up. See gridCache.ts
  // for why its fetches take no caller's abort signal.
  const [grids] = useState(() => gridCache((id) => fetchGrid(id)));
  const loadGrid = grids.load;

  useEffect(() => {
    const movieChanged = movieSeen.current !== movieId;
    movieSeen.current = movieId;
    session.current?.abort();
    inflight.current.clear();
    // A chip preview belongs to the grid it was taken on. Leaving it set
    // while the chips unmount (no mouseleave) paints the next film's
    // cards dim until the pointer happens to cross a chip again.
    // The selection is not cleared here: forward already started clean,
    // and coming back has put the previous visit's filters in place.
    setHovered(null);
    setLit(new Set());
    setOpenId(null);
    if (movieChanged) toast.hide();
    if (movieId === null) {
      setPayload(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    session.current = ctrl;
    const cached = grids.peek(movieId);
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
    const named = titleRef.current?.id === movieId ? titleRef.current.title : 'this movie';
    toast.show({ text: `Finding everyone who made ${named}…`, busy: true });
    loadGrid(movieId)
      .then((p) => {
        if (ctrl.signal.aborted) return;
        toast.show({ text: 'Laying out their movies…', busy: true });
        setPayload(p);
        capture('grid_loaded', { movie_id: movieId });
        warmShareCard(movieId, p.og_v);
      })
      .catch(() => {
        // A failure that lands after the reader has moved on belongs to
        // a map nobody is waiting for. Reported, it would put an error
        // over whichever one they went to instead.
        if (ctrl.signal.aborted) return;
        // Never the raw message: it is written for us, not the reader.
        setError('failed');
        setPayload(null);
        toast.hide();
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
    // `attempt` is not read here: it is what makes Try again run this
    // again for a movie that has not changed.
  }, [movieId, attempt, loadGrid]);

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
      // Where they sit in the chip row, which is how the spine names them.
      const at = only === null || !payload ? -1 : payload.people.findIndex((p) => p.id === only);
      const alone = at < 0 ? undefined : payload?.people[at];
      // Judged over what the page holds, not the whole spine: a film the
      // year range has cropped away lights nothing, so counting it would
      // hide the one case this toast is here to explain. The ref already
      // has the floor just set, and the range it is being set against.
      const now = settingsRef.current;
      // With a range set, the claim is about these years only. Whatever
      // of theirs lies outside it is not on the page to be judged.
      const years = now.yearFrom != null || now.yearTo != null ? ' in these years' : '';
      const text =
        alone && payload && nothingLit(spineOf(payload).filter((f) => onPlot(f, now)), at, minRating)
          ? `Nothing of ${alone.name}’s${years} is rated ${minRating.toFixed(1)} or higher`
          : `Lighting movies rated ${minRating.toFixed(1)} and up`;
      toast.show({ text, action: clear });
    },
    // The toaster's own functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSettings, selected, payload],
  );

  // Everyone on the map being shown has a colour before anything draws
  // them. It changes nothing for anyone already coloured, so a second
  // render of the same map is harmless, and only a map on screen gets
  // here: one fetched ahead for an open sheet does not use up colours
  // out of the order the reader meets people in.
  if (payload) assignHues(payload.people);
  // Who of this map was also on the last one shown, for the chip row's
  // order. Settled while rendering, so the first paint of a new map
  // already has it (see nextShown for what counts as shown).
  const [shown, setShown] = useState(NOTHING_SHOWN);
  const nowShown = nextShown(shown, movieId, payload);
  if (nowShown !== shown) setShown(nowShown);

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

  // Each chip's count, off the spine. Per map: the filters do not change
  // how many of someone's films the map holds.
  const counts = useMemo(() => (payload ? filmCounts(payload) : new Map<string, number>()), [payload]);

  const bounds = useMemo(
    () => (payload ? yearBounds(payload, settings.showUnrated) : { lo: 1900, hi: 2100 }),
    [payload, settings.showUnrated],
  );
  // The histogram over the year slider, counted by the same rule as its
  // ends so that every bar has a year under it.
  const perYear = useMemo(
    () => (payload ? yearCounts(payload, settings.showUnrated) : new Map<number, number>()),
    [payload, settings.showUnrated],
  );

  const pillText = activeFilters(settings, rungsInView);
  const changed = changedCount(settings, rungsInView);
  const pillRef = useRef<HTMLButtonElement>(null);
  const everyoneRef = useRef<HTMLButtonElement>(null);
  const openedFromPill = useRef(false);

  // The pill's ✕ clears what the pill says: the floor, when the pill is
  // where the floor is shown, and the year window. Hiding the empty
  // years is a preference the pill does not speak for, so it is left.
  const clearPill = useCallback(() => {
    const was = settingsRef.current;
    const years = was.yearFrom != null || was.yearTo != null;
    const floor = rungsInView && was.minRating != null;
    setSettings(withoutPill(was, rungsInView));
    // The toast about the floor goes with the floor, the same as picking
    // Any would take it.
    if (floor) toast.hide();
    // Only the years move rows. A floor lights and dims in place, so
    // there is nothing to put back in the middle.
    if (years) setRelaid((n) => n + 1);
    capture('filter_pill_cleared', { years, floor });
    // The pill is about to unmount, so the focus has to go somewhere it
    // can be seen: the first chip, which is where the row starts.
    everyoneRef.current?.focus();
    // The toaster's own functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSettings, rungsInView]);

  // What else the page holds and lights. Counted off the spine, which
  // holds every year whether or not anybody has scrolled to it, and on
  // the layout's own terms: a film the unrated column or the year range
  // has taken off the plot is not on the page, so it lights nothing.
  const lighting = useMemo(
    () => (payload ? litOthers(payload, settings, selectedIdx) : []),
    [payload, settings, selectedIdx],
  );
  // Hiding the empty years can leave the searched film alone on the
  // page. When it is the hiding that did it, the toast below says so.
  // A range or the unrated column that left nothing else on the plot is
  // not the hiding's doing: the pill names the range, the View panel
  // shows the column, and says so outright when the range holds none of
  // the cast's films (see rangeHoldsNone).
  const aloneOnTheMap = useMemo(
    () => payload != null && aloneAfterHiding(payload, settings, selectedIdx),
    [payload, settings, selectedIdx],
  );
  // How many rows the map is down to, for the reader who cannot see it
  // collapse: the searched film's year, and every year something lit
  // is in.
  const yearsShowing = useMemo(
    () => (payload ? new Set([payload.anchor.year, ...lighting.map((f) => f.year)]).size : 0),
    [payload, lighting],
  );

  const wasAlone = useRef(false);
  useEffect(() => {
    if (!aloneOnTheMap || !payload) {
      wasAlone.current = false;
      return;
    }
    if (wasAlone.current) return;
    wasAlone.current = true;
    toast.show({
      text: `Nothing else matches. Showing only ${payload.anchor.title}.`,
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
    const next = new Set(selectedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPeople(next);
  }, [setPeople]);

  const onCardHover = useCallback((people: string[]) => {
    setLit(new Set(people));
  }, []);

  const onRemap = useCallback(
    (film: GridFilm) => setMovieId(film.id, film.title),
    [setMovieId],
  );

  // Narrowing to one person is easy to do by accident on a phone, where
  // the row is the size of a thumb, so it comes with its way back.
  const onOnly = useCallback(
    (id: string) => {
      const person = payload?.people.find((p) => p.id === id);
      const before = selectedRef.current;
      setPeople(new Set([id]));
      toast.show({
        text: `Showing only ${person?.name ?? 'them'}`,
        action: {
          label: 'Undo',
          run: () => {
            setPeople(new Set(before));
            toast.hide();
          },
        },
      });
    },
    // The toaster's own functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payload, setPeople],
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
  // but never while they are waiting, reading a panel, or typing. Only
  // over a map, or the empty plot one is loading into: the opening
  // screen and the error both keep the header in flow, on the ground,
  // with nothing underneath it to pass under the glass.
  const overlay = screen.overlay && (payload != null || loading);
  // Where the map starts under a header lying over it: the header row
  // and the chip row, which the stylesheet sets to fixed heights.
  const overlayH = overlay ? overOffset(screen) : 0;
  const headerAway = useHeaderAway(
    scrollerRef,
    overlay && !loading && !covered && !searching,
    // What the map scrolls itself for that the quiet window cannot see
    // coming: a recentre, any change to which rows are on the plot or
    // which of them close up, and a change of screen class, which lays
    // the map out again with a different card. Clearing the pill does
    // the first two, from a header the reader is looking at.
    [
      screen.cls,
      relaid,
      settings.yearOrder,
      settings.showUnrated,
      settings.yearFrom,
      settings.yearTo,
      settings.hideEmptyYears,
      settings.minRating,
      [...selectedIdx].join(','),
    ].join('|'),
    appScroll,
  );
  // A header over a map, or over the empty plot one is loading into,
  // which is when it holds the chip row. It is ruled off from the map
  // from the first paint: the rule is what says the chips belong to the
  // header and not to the plot. The opening screen and the error have
  // nothing under the header to divide it from.
  const holdsChips = payload != null || loading;
  // What the empty search field says. While a map loads, the film being
  // fetched — when the app was told which one (see titleRef).
  const loadingTitle = titleRef.current?.id === movieId ? titleRef.current.title : null;

  return (
    <div className="cd-app">
      <header
        className={`cd-header${holdsChips ? ' cd-header-map' : ''}${overlay ? ' cd-header-over' : ''}${headerAway ? ' cd-header-away' : ''}`}
      >
        <div className="cd-header-row">
          {/* On a map, and only when there is a map to go back to. The
              opening screen has its own way on — the tiles and the
              search — and a map opened from a link has nothing behind
              it; a permanently disabled button is a dead control in the
              corner of every first visit. */}
          {canGoBack && movieId !== null && (
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
          <Wordmark
            markOnly={compactHeader}
            href={homeHref()}
            onClick={goHome}
            slotRef={markSlot}
            // Only the opening screen borrows the header's mark. A map
            // has its wordmark whole from the first paint.
            hollow={movieId === null && opening !== 'done'}
            wordIn={movieId !== null || opening !== 'draw'}
          />
          <SearchField
            placeholder={searchPlaceholder(loading, loadingTitle, payload?.anchor.title)}
            onPick={setMovieId}
            onFocusChange={setSearching}
            // A film sheet or the View panel is a dialog with the focus
            // inside it. A key that pulled the focus out to the field
            // behind the scrim would leave the reader typing into a
            // page they cannot see.
            shortcuts={!covered}
          />
          {holdsChips && !rungsInView && (
            <RatingFilter idle={!payload} value={settings.minRating} onChange={onFloor} />
          )}
        </div>
        {payload ? (
          <PeopleChips
            // In the map's own order: the spine names people by their
            // place in it, so only the row's drawing reorders.
            people={payload.people}
            carried={nowShown.carried}
            selected={selected}
            lit={lit}
            hovered={hovered}
            counts={counts}
            onToggle={onToggle}
            onHover={setHovered}
            onClear={() => setPeople(new Set())}
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
                      aria-label={`Clear filters: ${pillText}`}
                      onClick={clearPill}
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
          overlayH={overlayH}
          compact={screen.overlay}
          appScroll={appScroll}
        />
      ) : error ? (
        <MapError
          // Asks again for the same map, in place. It used to reopen the
          // movie through the router, which pushed a duplicate history
          // entry and, the id being the same, fetched nothing.
          onRetry={() => setAttempt((n) => n + 1)}
          onPickAnother={goHome}
        />
      ) : loading ? (
        // The waiting is said by the progress line and the toast. The
        // plot stays empty rather than holding a message the reader
        // would have to read and then watch disappear.
        <div className="cd-scroller" ref={scrollerRef} aria-hidden="true" />
      ) : (
        <ColdStart
          onPick={setMovieId}
          theme={theme}
          onTheme={onTheme}
          markSlot={markSlot}
          onOpening={setOpening}
        />
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
          perYear={perYear}
          anchorYear={payload?.anchor.year ?? 0}
          rangeEmpty={payload != null && rangeHoldsNone(payload, settings)}
          onFloor={onFloor}
          theme={theme}
          onTheme={onTheme}
          onClose={() => {
            setViewOpen(false);
            // A panel opened from the pill gives the focus back to it,
            // rather than dropping it on the document. If what was set in
            // the panel took the pill away, the focus goes where the ✕
            // sends it: the first chip, where the row starts.
            if (openedFromPill.current) {
              openedFromPill.current = false;
              (pillRef.current ?? everyoneRef.current)?.focus();
            }
          }}
        />
      )}

      <Toast spec={toast.spec} visible={toast.visible} />
      <p className="cd-sr-live" aria-live="polite">
        {!payload
          ? ''
          : settings.hideEmptyYears
            ? `Showing ${yearsShowing} ${yearsShowing === 1 ? 'year' : 'years'}`
            : 'Map ready'}
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

function useFilmRoute(adopt: { current: (filters: MapFilters) => void }): [
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
      history.replaceState(forwardEntry(here, 0), '', path);
      setDepth(0);
    } else if (path !== at) {
      history.replaceState(history.state, '', path);
    }
    const onPop = () => {
      setId(movieIdFromPath(location.pathname));
      setDepth(historyDepth(history.state));
      adopt.current(filtersFromState(history.state));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [adopt]);
  const go = useCallback((id: string, title?: string) => {
    const next = historyDepth(history.state) + 1;
    const path = filmPath(id, title);
    // Opening the movie already on screen — picking it again from
    // search while its map is up — keeps this visit's filters. A map
    // that failed never gets here: Try again, or picking the same movie
    // after the failure, asks for the map again without moving. A different movie starts clear, and the clear
    // is stamped on the new entry so the one left behind stays as it was.
    if (movieIdFromPath(location.pathname) === id) {
      history.pushState({ movie: id, depth: next, filters: filtersFromState(history.state) }, '', path);
      setId(id);
      setDepth(next);
      return;
    }
    history.pushState(forwardEntry(id, next), '', path);
    setId(id);
    setDepth(next);
    adopt.current(freshFilters());
  }, [adopt]);
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
    history.pushState(forwardEntry(null, next), '', homeHref());
    setId(null);
    setDepth(next);
    adopt.current(freshFilters());
  }, [adopt]);
  return [movieId, go, depth > 0, back, home];
}

type SetSettings = (s: GridSettings | ((was: GridSettings) => GridSettings)) => void;

function SearchField({
  placeholder,
  onPick,
  onFocusChange,
  shortcuts,
}: {
  /** What the empty field says (see searchPlaceholder). */
  placeholder: string;
  onPick: (id: string, title?: string) => void;
  /** The header must not slide away from under a reader who is typing. */
  onFocusChange: (on: boolean) => void;
  /** Whether ⌘K, Ctrl+K and "/" may bring the reader here. */
  shortcuts: boolean;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const theme = useResolvedTheme();
  const typed = query.trim();
  // The list is up while there is a query worth asking about, whether
  // or not the field still has the focus: a reader who looks away from
  // the field has not withdrawn the question. It is a listbox only when
  // it holds films; otherwise it is a line saying why not.
  const open = typed.length >= 2;
  const listed = open && hits.length > 0;

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

  // ⌘K or Ctrl+K from anywhere, and "/" from anywhere that is not a
  // text field, put the reader in the search. The browser's own use of
  // the key is stopped: "/" is find-in-page in Firefox, and Ctrl+K is
  // the browser's search bar.
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isSearchShortcut(e, isTyping(document.activeElement))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts]);

  // The highlighted film stays in sight as the arrows move through a
  // list taller than its box.
  useEffect(() => {
    if (!listed) return;
    document.getElementById(optionId(listId, at))?.scrollIntoView({ block: 'nearest' });
  }, [listed, at, listId]);

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
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={query}
        placeholder={placeholder}
        aria-label="Search for a movie"
        aria-keyshortcuts="Meta+K Control+K /"
        // A combobox: the arrows move a highlight through the list while
        // the focus stays here, and the highlight is announced as if it
        // had the focus.
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={listed ? listId : undefined}
        aria-activedescendant={listed ? optionId(listId, at) : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // The arrows would otherwise move the caret to the ends of
          // the text as well as the highlight.
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAt((i) => Math.max(0, Math.min(i + 1, hits.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAt((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (listed && hits[at]) choose(hits[at]);
            else inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            // Clears and lets go, even when there was nothing to clear:
            // in the field, Escape is the way back out to the map.
            setQuery('');
            inputRef.current?.blur();
          }
        }}
      />
      {/* Hidden once the field has the focus, and on phones, which have
          no keyboard to press it on (see .cd-kbd). */}
      {query === '' && (
        <span className="cd-kbd" aria-hidden="true">
          ⌘K
        </span>
      )}
      {open && (
        <div className="cd-results">
          {listed ? (
            <ul className="cd-results-list" role="listbox" id={listId} aria-label="Movies">
              {hits.map((h, i) => (
                <li key={h.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    id={optionId(listId, i)}
                    aria-selected={i === at}
                    // Reached with the arrows from the field, not with Tab.
                    tabIndex={-1}
                    className={`cd-result${i === at ? ' cd-result-at' : ''}`}
                    // On pointerdown, not click: the input blurs first and
                    // would take the list down before the tap ever landed.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(h);
                    }}
                    // A screen reader's "activate" is a click with no
                    // press before it. After a press the list is gone, so
                    // this never picks twice.
                    onClick={() => choose(h)}
                  >
                    <PosterImage
                      id={h.id}
                      url={h.poster}
                      blankClassName="cd-result-blank"
                      width={28}
                      height={42}
                      loading="lazy"
                      // The film's own hue until the picture arrives, and
                      // instead of one when there is none.
                      style={{ background: posterFallback(h.title, theme) }}
                    />
                    <span className="cd-result-title">
                      {h.title}
                      {h.year ? <span className="cd-result-year"> ({h.year})</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cd-result-note">{busy ? 'Searching…' : `No movies match “${typed}”`}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The id of the result at `i`, for the field to point at. */
function optionId(listId: string, i: number): string {
  return `${listId}-${i}`;
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
      {/* The group's own name already says it. */}
      <span className="cd-rating-label" aria-hidden="true">
        Rating
      </span>
      <div className="cd-rungs">
        {[null, ...RATING_STOPS].map((r) => {
          const on = value === r;
          return (
            <button
              key={r ?? 'any'}
              type="button"
              className={`cd-rung${on ? ' cd-rung-on' : ''}`}
              aria-pressed={on}
              aria-label={r == null ? undefined : `Light movies rated at least ${r.toFixed(1)}`}
              // Pressing the lit rung again takes the floor away, the
              // same as Any.
              onClick={() => onChange(r == null || on ? null : r)}
            >
              {rungLabel(r)}
            </button>
          );
        })}
      </div>
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

/** The loader's drawn size, and where it sits while it draws. */
const LOADER_W = 46;
const LOADER_H = 70;

/** A point on the screen, in viewport coordinates. */
interface Spot {
  x: number;
  y: number;
}

/** The trip from the tiles to the header: how far, and how much
 *  smaller it has to become on the way. */
interface Flight {
  dx: number;
  dy: number;
  scale: number;
}

/** The mark, drawn while the opening screen waits for its films.
 *
 *  It is the one thing on the page that says "working" — and unlike a
 *  spinner it says what is working. The stroke draws itself in and the
 *  dot arrives near the end, which is the mark's own story: the C, then
 *  the film at the centre of it.
 *
 *  `pathLength="1"` makes the dash maths independent of the path's real
 *  length, so the drawing takes the same time whatever the geometry. */
function LoadingMark({ at, flight }: { at: Spot; flight: Flight | null }) {
  return (
    <svg
      className="cd-cold-mark"
      viewBox="15.5 9.5 29.5 45"
      width={LOADER_W}
      height={LOADER_H}
      style={{
        left: at.x,
        top: at.y,
        // Centred on its spot, then carried to the header. Both
        // transforms are on the same element so the browser
        // interpolates one thing, and the scale is about the centre,
        // which is what keeps the landing on the slot rather than
        // beside it.
        transform: flight
          ? `translate(-50%, -50%) translate(${flight.dx}px, ${flight.dy}px) scale(${flight.scale})`
          : 'translate(-50%, -50%)',
        transition: flight ? `transform ${GLIDE_MS}ms var(--ease-glide)` : undefined,
      }}
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="cd-cold-mark-path"
        d="M42.7 47 A14 14 0 1 1 42.7 29 C38 23.5 31 19 29 13 C33 11.8 37.5 11.6 41.5 12.4"
        pathLength="1"
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="cd-cold-mark-dot" cx="32" cy="38" r="5" />
    </svg>
  );
}

/** One tile on the opening screen.
 *
 *  The frame is on screen from the first paint, before there is a film
 *  to put in it. Then the film's colour and its name arrive, and the
 *  poster fades in over a fill it was already the colour of — so the
 *  picture landing is a sharpening rather than an appearance.
 *
 *  Each tile waits only for its own poster. The screen used to hold all
 *  eight back until the slowest had decoded, which meant one bad image
 *  host decided when anybody saw anything. */
function ColdTile({
  film,
  index,
  shown: letIn,
  theme,
  onPick,
}: {
  film: FirstRunFilm | undefined;
  index: number;
  /** Set once the mark has lifted off. The fills wait for that rather
   *  than for the list, so nothing starts underneath the loader. */
  shown: boolean;
  theme: Theme;
  onPick: (id: string, title?: string) => void;
}) {
  const { src, onError } = usePosterSrc(film?.poster, TILE_W, film?.id);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
  }, [src]);

  return (
    <button
      type="button"
      className={`cd-cold-tile${film && letIn ? ' cd-cold-tile-in' : ''}`}
      style={{ ['--i' as string]: index }}
      aria-hidden={film ? undefined : true}
      tabIndex={film ? undefined : -1}
      onClick={() => film && onPick(film.id, film.title)}
    >
      <span className="cd-cold-frame">
        {film && (
          <span
            className="cd-cold-fill"
            style={{ background: film.c ?? posterFallback(film.title, theme) }}
          />
        )}
        {src && (
          <img
            src={src}
            alt=""
            decoding="async"
            fetchPriority={index < EAGER_TILES ? 'high' : 'low'}
            data-in={shown || undefined}
            onLoad={(e) => {
              // decode() rather than load alone, so the fade is over a
              // frame the browser can already paint. Either outcome
              // shows it: a picture that will not decode is one the
              // browser will draw badly, not one to hide.
              e.currentTarget.decode().then(
                () => setShown(true),
                () => setShown(true),
              );
            }}
            onError={onError}
          />
        )}
      </span>
      <span className="cd-cold-meta">
        <span className="cd-cold-title">{film?.title ?? ''}</span>
        <span className="cd-cold-year">{film?.year ?? ''}</span>
      </span>
    </button>
  );
}

function ColdStart({
  onPick,
  theme,
  onTheme,
  markSlot,
  onOpening,
}: {
  onPick: (id: string, title?: string) => void;
  theme: ThemePref;
  onTheme: (p: ThemePref) => void;
  /** The header's empty mark slot, which is where the loader is going. */
  markSlot: RefObject<HTMLSpanElement | null>;
  onOpening: (phase: Opening) => void;
}) {
  // The films, once they are known. A late answer does not swap a new
  // eight in under one the reader is already looking at.
  const [tiles, setTiles] = useState<FirstRunFilm[] | null>(null);
  // Set when the list could not be fetched at all. Eight empty frames
  // that never fill is the screen saying nothing, forever.
  const [failed, setFailed] = useState(false);
  // The headline mounts in its "from" state and is let go a frame
  // later: a transition needs a committed state to travel out of, so
  // setting the opacity in the same render that mounts the element
  // leaves the browser nothing to animate between.
  const [textIn, setTextIn] = useState(false);
  const [box, setBox] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const drawn = useResolvedTheme();
  // Where the grid actually starts. The row count needs it, and the
  // alternative is keeping a copy of the stylesheet's paddings in
  // JavaScript and remembering to change both.
  const grid = useRef<HTMLDivElement>(null);
  const [gridTop, setGridTop] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const read = () => {
      const top = el.getBoundingClientRect().top;
      // A page that has never been laid out — one opened in a
      // background tab — measures zero everywhere. The stand-in
      // numbers are better than a grid of one row.
      setGridTop(top > 0 ? top : undefined);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);

  // The headline is Young Serif, balanced across two lines. Let it
  // fade in before the font arrives and the swap rewraps it under the
  // reader — the one movement on this screen nobody asked for. The
  // cap is there because a font that never loads must not hold the
  // first thing there is to read.
  useEffect(() => {
    let live = true;
    let frame = 0;
    const ready = document.fonts?.load('400 32px "Young Serif"') ?? Promise.resolve();
    const cap = new Promise((r) => window.setTimeout(r, FONT_WAIT_MS));
    void Promise.race([ready, cap]).then(() => {
      if (!live) return;
      frame = window.requestAnimationFrame(() => setTextIn(true));
    });
    return () => {
      live = false;
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const onResize = () => setBox({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchFirstRun(ctrl.signal)
      .then((hits) => setTiles(tilesFrom(hits)))
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        // The catalog is the only source, so there is nothing to fall
        // back to — but silence is not an answer. The search field is
        // the way on, which is why there is no retry button here.
        setTiles([]);
        setFailed(true);
      });
    return () => ctrl.abort();
  }, []);

  const room = coldScreenCount(box.w, box.h, gridTop);
  const shown = tiles ? tiles.slice(0, room) : [];
  const waiting = tiles === null;

  // Where the loader sits while it draws, and where it is headed.
  // Null once it has landed and the header owns the mark again.
  const [spot, setSpot] = useState<Spot | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  // The tiles wait for the mark to lift off rather than for the list,
  // so the fills never start underneath it.
  const [tilesIn, setTilesIn] = useState(false);

  const opening = useRef(onOpening);
  opening.current = onOpening;
  const slot = useRef(markSlot);
  slot.current = markSlot;

  // The whole opening, in one place: draw, lift, land.
  //
  // A list already in hand skips all of it — there is nothing to wait
  // for, so there is nothing to say — and so does a reader who has
  // asked for no movement.
  const still = useReducedMotion();
  const started = useRef(performance.now());

  // Claim the header's mark on the way in. The phase lives in GridApp
  // so it outlives this component, and coming back to the opening
  // screen from a map would otherwise find it still set to `done` —
  // the header would draw its own mark and the loader would fly into
  // one already there.
  useEffect(() => {
    opening.current(still ? 'done' : 'draw');
    // Handing it back is the phase machinery's job, not unmount's: a
    // map renders its wordmark whole regardless.
  }, [still]);

  useEffect(() => {
    if (waiting) return;
    const quick = performance.now() - started.current < FAST_PATH_MS;
    if (still || quick) {
      setTilesIn(true);
      opening.current('done');
      return;
    }
    const timers: number[] = [];
    // The glide waits for the drawing to finish. Cutting a half-drawn
    // C loose is worse than the thirty milliseconds it costs to let it
    // close.
    const after = Math.max(0, DRAW_MS - (performance.now() - started.current));
    timers.push(
      window.setTimeout(() => {
        const target = slot.current.current?.getBoundingClientRect();
        const here = spotRef.current;
        if (!target || !here) {
          // Nowhere to fly to. Better a complete header than a mark
          // stranded over the films.
          setTilesIn(true);
          opening.current('done');
          return;
        }
        setFlight({
          dx: target.left + target.width / 2 - here.x,
          dy: target.top + target.height / 2 - here.y,
          scale: target.width / LOADER_W,
        });
        timers.push(window.setTimeout(() => setTilesIn(true), TILES_AFTER_LIFT_MS));
        timers.push(
          window.setTimeout(() => opening.current('word'), GLIDE_MS - WORD_BEFORE_LANDING_MS),
        );
        // The loader goes and the real mark appears in the same frame.
        timers.push(
          window.setTimeout(() => {
            opening.current('done');
            setSpot(null);
          }, GLIDE_MS),
        );
      }, after),
    );
    return () => timers.forEach(window.clearTimeout);
    // `waiting` is the one thing that starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, still]);

  // The loader is drawn over the middle of the top row, in viewport
  // coordinates: it has to leave `.cd-cold`, which scrolls, and arrive
  // in the header, which is not inside it.
  const spotRef = useRef<Spot | null>(null);
  spotRef.current = spot;
  useLayoutEffect(() => {
    if (still) return;
    const first = grid.current?.querySelector('.cd-cold-frame');
    const box = grid.current?.getBoundingClientRect();
    if (!first || !box) return;
    const row = first.getBoundingClientRect();
    if (row.height <= 0) return;
    setSpot({ x: box.left + box.width / 2, y: row.top + row.height / 2 });
    // Measured once the frames exist, which is the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, still]);

  return (
    <div className={`cd-cold${textIn ? ' cd-cold-in' : ''}`}>
      <strong className="cd-cold-head">Start with a movie you love</strong>
      <p className="cd-cold-sub">
        See every movie its cast and directors made, arranged by year and rating.
      </p>
      {/* The frames are drawn before there is anything to put in them,
          so the screen has its full shape from the first paint and
          nothing moves when the films land. */}
      {failed ? (
        <p className="cd-cold-error" role="status">
          Couldn&rsquo;t load suggestions. Search for a movie above.
        </p>
      ) : null}
      {spot && <LoadingMark at={spot} flight={flight} />}
      <div
        ref={grid}
        className={`cd-tiles${failed ? ' cd-tiles-gone' : ''}`}
        aria-busy={waiting || undefined}
        aria-hidden={failed || undefined}
      >
        {Array.from({ length: room }, (_, i) => (
          <ColdTile
            // By index, never by film id. Keying on the id swapped
            // every key the moment the list landed, so React threw the
            // eight frames away and mounted eight more — which is why
            // they blinked, and why the stagger and the fades never
            // played: the replacements mounted already visible.
            key={i}
            film={shown[i]}
            index={i}
            shown={tilesIn}
            theme={drawn}
            onPick={onPick}
          />
        ))}
      </div>
      {/* There is no View button on this screen, so the theme choice
          lives here. It fades in with the sub-line rather than with the
          tiles: it is not one of the eight movies. */}
      <ThemePicker value={theme} onChange={onTheme} />
    </div>
  );
}
