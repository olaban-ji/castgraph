import {
  RATING_STOPS,
  settingsFrom,
  type GridSettings,
} from './grid';

/** What narrows one map: who is selected, the rating floor, the year
 *  window, and whether empty years are hidden.
 *
 *  How the map is drawn — newest first, unrated films, the searched
 *  year's highlight — stays with the reader. A filter does not. It
 *  belongs to the visit it was set on. */
export interface MapFilters {
  people: string[];
  minRating: number | null;
  yearFrom: number | null;
  yearTo: number | null;
  hideEmptyYears: boolean;
}

/** A movie just opened. Nothing set on the one being left comes with it. */
export function freshFilters(): MapFilters {
  return {
    people: [],
    minRating: null,
    yearFrom: null,
    yearTo: null,
    hideEmptyYears: false,
  };
}

/** The history entry for a movie opened forward: search, a card, home.
 *  Back through that entry is what restores the filters, so a forward
 *  step stores a clear map rather than copying the one being left. */
export function forwardEntry(
  movie: string | null,
  depth: number,
): { depth: number; movie?: string; filters: MapFilters } {
  const filters = freshFilters();
  return movie === null ? { depth, filters } : { movie, depth, filters };
}

/** Filters saved on the entry being returned to. Missing or nonsense
 *  is a clear map: an old entry, from before filters lived here, must
 *  not invent a selection. */
export function filtersFromState(state: unknown): MapFilters {
  if (!state || typeof state !== 'object' || !('filters' in state)) return freshFilters();
  const raw = (state as { filters: unknown }).filters;
  if (!raw || typeof raw !== 'object') return freshFilters();
  const f = raw as Record<string, unknown>;
  return {
    people: peopleOf(f.people),
    minRating: ratingOf(f.minRating),
    yearFrom: yearOf(f.yearFrom),
    yearTo: yearOf(f.yearTo),
    hideEmptyYears: f.hideEmptyYears === true,
  };
}

/** Write filters onto the entry the reader is on, keeping the movie
 *  and the depth already stored there. */
export function stampFilters(state: unknown, filters: MapFilters): Record<string, unknown> {
  const base: Record<string, unknown> =
    state !== null && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  if (typeof base.depth !== 'number') base.depth = 0;
  return { ...base, filters: { ...filters, people: [...filters.people] } };
}

export function filtersOf(settings: GridSettings, people: Iterable<string>): MapFilters {
  return {
    people: [...people],
    minRating: settings.minRating,
    yearFrom: settings.yearFrom,
    yearTo: settings.yearTo,
    hideEmptyYears: settings.hideEmptyYears,
  };
}

/** View preferences kept, filter fields replaced. */
export function applyFilters(settings: GridSettings, filters: MapFilters): GridSettings {
  return {
    ...settings,
    minRating: filters.minRating,
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    hideEmptyYears: filters.hideEmptyYears,
  };
}

/** The part that is allowed to follow the reader from map to map. */
export function viewPrefs(
  settings: GridSettings,
): Pick<GridSettings, 'yearOrder' | 'showUnrated' | 'highlightYear'> {
  return {
    yearOrder: settings.yearOrder,
    showUnrated: settings.showUnrated,
    highlightYear: settings.highlightYear,
  };
}

/** Preferences from storage. A year range or a rating floor left in
 *  there from when filters were global is dropped, so it cannot walk
 *  onto the next movie. */
export function preferencesFrom(raw: string | null): GridSettings {
  return applyFilters(settingsFrom(raw), freshFilters());
}

const STOPS = new Set<number>(RATING_STOPS);

function ratingOf(v: unknown): number | null {
  if (typeof v !== 'number' || !STOPS.has(v)) return null;
  return v;
}

function yearOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1800 || v > 2100) return null;
  return v;
}

/** An IMDb name id, and not a hundred of them: a chip row is a
 *  selection, not a dump of whatever a stale entry was holding. */
function peopleOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of v) {
    if (typeof id !== 'string' || !/^nm\d{1,12}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length === 80) break;
  }
  return out;
}
