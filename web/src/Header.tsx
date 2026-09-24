import { useEffect, useId, useRef, useState } from 'react';
import { searchMovies, type SearchHit } from './api';
import { FilterPanel } from './FilterPanel';
import type { MapFilters } from './filters';
import { sizedTmdbUrl } from './Node';

interface Props {
  /** The film the map is anchored on, shown as its own line — never as
   *  the value of the search field. */
  title: string;
  year?: number;
  filters: MapFilters;
  onFilters: (f: MapFilters) => void;
  /** People the map connects through, for the "one person" filter. */
  people: { name: string; films: number; director: boolean }[];
  bounds: { min: number; max: number };
  canGoBack: boolean;
  onBack: () => void;
  onPick: (movieId: number, title?: string, hit?: SearchHit) => void;
}

/** Debounce before a keystroke becomes a request. */
const SEARCH_DEBOUNCE_MS = 250;

/** Fixed header: back, the wordmark, a search field that is only ever a
 *  search field, and the two relation filters. What the map is anchored
 *  on is stated beneath, not typed into the box. */
export function Header({ title, year, filters, onFilters, people, bounds, canGoBack, onBack, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pending, setPending] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const q = query.trim();
  const searching = open && q.length >= 2;

  useEffect(() => {
    if (!searching) {
      setHits([]);
      setPending(false);
      return;
    }
    setPending(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchMovies(q, ctrl.signal)
        .then((r) => {
          setHits(r.slice(0, 8));
          setCursor(0);
        })
        .catch(() => setHits([]))
        .finally(() => setPending(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, searching]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setPending(false);
  };

  const pick = (h: SearchHit) => {
    close();
    inputRef.current?.blur();
    onPick(h.id, h.title, h);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (hits.length === 0) return;
      e.preventDefault();
      setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
      return;
    }
    if (e.key === 'Enter' && hits[cursor]) pick(hits[cursor]);
  };

  const showList = searching && (pending || hits.length > 0 || q.length >= 2);

  return (
    <header className="mc-header">
      <button
        className="mc-back"
        aria-label="Back to the previous map"
        disabled={!canGoBack}
        onClick={onBack}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      <div className="mc-brand">
        <span className="mc-wordmark">Cinedikt</span>
        {title ? (
          <span className="mc-anchored">
            Anchored on {title}
            {year ? ` (${year})` : ''}
          </span>
        ) : (
          <span className="mc-anchored">A movie’s cast and directors, and everything they made</span>
        )}
      </div>

      <div className="mc-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8B93A1" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          id="mc-search-input"
          aria-label="Search movies"
          placeholder="Search a movie"
          autoComplete="off"
          enterKeyHint="search"
          spellCheck={false}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && hits[cursor] ? `${listId}-${hits[cursor].id}` : undefined}
          value={query}
          onPointerDown={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(close, 150)}
          onChange={(e) => {
            setOpen(true);
            setQuery(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        {showList && (
          <div className="mc-results" id={listId} role="listbox" aria-label="Search results">
            {pending && hits.length === 0 && (
              <div className="mc-result mc-result-pending" role="presentation">
                <span className="mc-result-thumb mc-result-thumb-empty" aria-hidden="true" />
                <span className="mc-result-text">Searching…</span>
              </div>
            )}
            {!pending && hits.length === 0 && (
              <div className="mc-result" role="presentation">
                <span className="mc-result-thumb mc-result-thumb-empty" aria-hidden="true" />
                <span className="mc-result-text">No movies match “{q}”</span>
              </div>
            )}
            {hits.map((h, i) => (
              <button
                key={h.id}
                id={`${listId}-${h.id}`}
                className={`mc-result${i === cursor ? ' mc-result-cursor' : ''}`}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(h)}
              >
                {h.poster ? (
                  <img className="mc-result-thumb" src={sizedTmdbUrl(h.poster, 28)} alt="" width={28} height={42} decoding="async" />
                ) : (
                  <span className="mc-result-thumb mc-result-thumb-empty" aria-hidden="true" />
                )}
                <span className="mc-result-text">{h.title}</span>
                <span className="mc-year">{h.release_date?.slice(0, 4)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mc-filters" role="group" aria-label="Filter the map">
        <FilterChip
          label="Cast"
          on={filters.cast}
          tone="cast"
          onToggle={() => onFilters({ ...filters, cast: !filters.cast })}
        />
        <FilterChip
          label="Director"
          on={filters.director}
          tone="director"
          onToggle={() => onFilters({ ...filters, director: !filters.director })}
        />
        <FilterPanel
          filters={filters}
          onChange={onFilters}
          people={people}
          bounds={bounds}
        />
      </div>
    </header>
  );
}

function FilterChip({
  label,
  on,
  tone,
  onToggle,
}: {
  label: string;
  on: boolean;
  tone: 'cast' | 'director';
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`mc-chip mc-chip-${tone}${on ? ' mc-chip-on' : ''}`}
      aria-pressed={on}
      onClick={onToggle}
    >
      <span className="mc-chip-dot" aria-hidden="true" />
      {label}
    </button>
  );
}
