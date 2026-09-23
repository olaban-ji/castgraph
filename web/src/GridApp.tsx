import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchGrid, searchMovies, type SearchHit } from './api';
import { capture } from './analytics';
import { firstRunFilms, tilesFrom } from './firstRun';
import { fetchFirstRun } from './api';
import {
  DEFAULT_SETTINGS,
  type GridFilm,
  type GridPayload,
  type GridSettings,
} from './grid';
import { GridMap } from './GridMap';
import { GridSheet } from './GridSheet';
import { filmCounts, PeopleChips } from './PeopleChips';
import { filmPath, movieIdFromPath, movieIdFromState } from './movieParam';

/** Where the reader's settings live between visits. */
const SETTINGS_KEY = 'cinedikt.grid';

/** Debounce before a keystroke becomes a request. */
const SEARCH_DEBOUNCE_MS = 250;

/** The rating grid, end to end: a film's people, every film they made,
 *  and nothing that has to be grown. */
export function GridApp() {
  const [movieId, setMovieId] = useFilmRoute();
  const [settings, setSettings] = useSettings();
  const [payload, setPayload] = useState<GridPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hovered, setHovered] = useState<number | null>(null);
  const [lit, setLit] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    if (movieId === null) {
      setPayload(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetchGrid(movieId, ctrl.signal)
      .then((p) => {
        setPayload(p);
        setSelected(new Set());
        setOpenId(null);
        capture('grid_loaded', { movie_id: movieId, films: p.films.length });
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [movieId]);

  const counts = useMemo(
    () => (payload ? filmCounts(payload.films) : new Map<number, number>()),
    [payload],
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
          <span className="cd-wordmark">Cinedikt</span>
          <SearchField title={payload?.anchor.title ?? ''} onPick={setMovieId} />
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
          onOpen={setOpenId}
        />
      ) : (
        <ColdStart loading={loading} error={error} onPick={setMovieId} />
      )}

      {open && payload && (
        <GridSheet
          film={open}
          payload={payload}
          counts={counts}
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

/** Every map has an address, so it can be shared and reloaded. */
function useFilmRoute(): [number | null, (id: number, title?: string) => void] {
  const [movieId, setId] = useState<number | null>(() => movieIdFromPath(location.pathname));
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      setId(movieIdFromState(e.state) ?? movieIdFromPath(location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((id: number, title?: string) => {
    history.pushState({ movieId: id }, '', filmPath(id, title));
    setId(id);
  }, []);
  return [movieId, go];
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

function ColdStart({
  loading,
  error,
  onPick,
}: {
  loading: boolean;
  error: string | null;
  onPick: (id: number, title?: string) => void;
}) {
  const [tiles, setTiles] = useState(firstRunFilms);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchFirstRun(ctrl.signal)
      .then((hits) => {
        const fresh = tilesFrom(hits);
        if (fresh.length > 0) setTiles(fresh);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  if (loading) return <div className="cd-cold"><p>Finding the cast…</p></div>;
  return (
    <div className="cd-cold">
      {error && <p className="cd-cold-error">{error}</p>}
      <strong>Every film is one step from the people who made it</strong>
      <p>Pick one, and see everything its cast and directors have done.</p>
      <div className="cd-tiles">
        {tiles.map((f) => (
          <button key={f.id} type="button" className="cd-tile" onClick={() => onPick(f.id, f.title)}>
            <img src={f.poster} alt="" width={104} height={156} loading="lazy" decoding="async" />
            <span className="cd-tile-title">{f.title}</span>
            <span className="cd-tile-year">{f.year}</span>
          </button>
        ))}
      </div>
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
