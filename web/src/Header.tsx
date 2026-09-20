import { useEffect, useRef, useState } from 'react';
import { searchMovies, type SearchHit } from './api';

interface Props {
  title: string;
  onPick: (movieId: number, title?: string) => void;
}

/** Fixed header: back button and the search pill showing the anchor title.
 *  Typing in the pill searches TMDb; picking a result re-anchors the map. */
export function Header({ title, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const beginEdit = () => {
    if (editing) return;
    setEditing(true);
    setQuery('');
    setHits([]);
  };

  const stopEditing = () => {
    setEditing(false);
    setQuery('');
    setHits([]);
  };

  useEffect(() => {
    const q = query.trim();
    if (!editing || q.length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchMovies(q, ctrl.signal)
        .then((r) => setHits(r.slice(0, 8)))
        .catch(() => setHits([]));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, editing]);

  const pick = (h: SearchHit) => {
    stopEditing();
    inputRef.current?.blur();
    onPick(h.id, h.title);
  };

  return (
    <header className="mc-header">
      <button className="mc-back" aria-label="Back" onClick={() => history.back()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F5F3EE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <div
        className="mc-search"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('.mc-results')) return;
          beginEdit();
          inputRef.current?.focus();
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8B93A1" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          aria-label="Search films"
          placeholder={title || 'Search a film'}
          readOnly={!editing}
          autoComplete="off"
          spellCheck={false}
          value={editing ? query : title}
          onFocus={beginEdit}
          onBlur={() => setTimeout(stopEditing, 150)}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') inputRef.current?.blur();
            if (e.key === 'Enter' && hits[0]) pick(hits[0]);
          }}
        />
        {editing && hits.length > 0 && (
          <div className="mc-results" role="listbox">
            {hits.map((h) => (
              <button key={h.id} role="option" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
                {h.title}
                <span className="mc-year">{h.release_date?.slice(0, 4)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
