import { useEffect, useId, useRef, useState } from 'react';
import { NO_FILTERS, type MapFilters } from './filters';

interface Props {
  filters: MapFilters;
  onChange: (f: MapFilters) => void;
  /** People the current map connects films through. */
  people: { name: string; films: number; director: boolean }[];
  /** The year span the map covers. */
  bounds: { min: number; max: number };
}

/** Ratings a reader actually filters by. A continuous slider invites
 *  precision the data does not have. */
const RATING_STOPS = [0, 6, 7, 7.5, 8, 8.5] as const;

/** The map's view controls: which relations to travel, how good, how old,
 *  and through whom. Cast and Director stay outside the panel because
 *  they are also the map's colour legend. */
export function FilterPanel({ filters, onChange, people, bounds }: Props) {
  const [open, setOpen] = useState(false);
  const [personQuery, setPersonQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const active = countActive(filters);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: PointerEvent) => {
      if (ref.current && !ref.current.contains(ev.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const set = (over: Partial<MapFilters>) => onChange({ ...filters, ...over });
  const shown = personQuery.trim().toLowerCase();
  const matches = shown
    ? people.filter((p) => p.name.toLowerCase().includes(shown)).slice(0, 8)
    : people.slice(0, 8);

  return (
    <div className="mc-filter-wrap" ref={ref}>
      <button
        type="button"
        className={`mc-chip${active > 0 ? ' mc-chip-on' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 5h18M6 12h12M10 19h4" />
        </svg>
        Filters
        {active > 0 && <span className="mc-filter-count">{active}</span>}
      </button>

      {open && (
        <div className="mc-filter-panel" id={panelId} role="group" aria-label="Filter the map">
          <div className="mc-filter-head">
            <button
              type="button"
              className="mc-filter-clear"
              disabled={active === 0}
              onClick={() => {
                setPersonQuery('');
                onChange({ ...NO_FILTERS, cast: filters.cast, director: filters.director });
              }}
            >
              Clear
            </button>
          </div>

          <fieldset className="mc-filter-row">
            <legend>Rating at least</legend>
            <div className="mc-filter-stops">
              {RATING_STOPS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`mc-stop${filters.minRating === r ? ' mc-stop-on' : ''}`}
                  aria-pressed={filters.minRating === r}
                  onClick={() => set({ minRating: r })}
                >
                  {r === 0 ? 'Any' : r.toFixed(1)}
                </button>
              ))}
            </div>
            {filters.minRating > 0 && (
              <p className="mc-filter-note">Films with no rating yet are hidden.</p>
            )}
          </fieldset>

          <fieldset className="mc-filter-row">
            <legend>Released between</legend>
            <div className="mc-filter-years">
              <label>
                <span className="mc-sr-only">From year</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={bounds.min}
                  max={bounds.max}
                  placeholder={String(bounds.min)}
                  value={filters.fromYear ?? ''}
                  onChange={(e) => set({ fromYear: yearOrNull(e.target.value) })}
                />
              </label>
              <span aria-hidden="true">–</span>
              <label>
                <span className="mc-sr-only">To year</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={bounds.min}
                  max={bounds.max}
                  placeholder={String(bounds.max)}
                  value={filters.toYear ?? ''}
                  onChange={(e) => set({ toYear: yearOrNull(e.target.value) })}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="mc-filter-row">
            <legend>Through one person</legend>
            {filters.person ? (
              <button
                type="button"
                className="mc-person mc-person-on"
                onClick={() => set({ person: null })}
              >
                {filters.person}
                <span aria-hidden="true">×</span>
              </button>
            ) : (
              <>
                <input
                  className="mc-person-search"
                  type="search"
                  placeholder="Any actor or director"
                  aria-label="Filter by a person on the map"
                  value={personQuery}
                  onChange={(e) => setPersonQuery(e.target.value)}
                />
                <div className="mc-person-list">
                  {matches.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className="mc-person"
                      onClick={() => {
                        set({ person: p.name });
                        setPersonQuery('');
                      }}
                    >
                      <span className={`mc-chip-dot${p.director ? ' mc-dot-director' : ''}`} aria-hidden="true" />
                      {p.name}
                    </button>
                  ))}
                  {matches.length === 0 && <p className="mc-filter-note">Nobody on this map matches.</p>}
                </div>
              </>
            )}
          </fieldset>
        </div>
      )}
    </div>
  );
}

function yearOrNull(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() === '' || !Number.isFinite(n) ? null : Math.round(n);
}

/** How many narrowings are on, for the badge. Cast and Director live
 *  outside the panel, so they are counted there, not here. */
export function countActive(f: MapFilters): number {
  let n = 0;
  if (f.minRating > 0) n++;
  if (f.fromYear !== null || f.toYear !== null) n++;
  if (f.person !== null) n++;
  return n;
}
